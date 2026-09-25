import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { computeFileHash } from '../cache/HashCache';
import { buildRepositoryScopeKey } from './RepositoryLockState';
import {
  collectScopeFiles,
  detectScopeLayout,
  mapDumpPathToProject,
  removeEmptyParentDirs,
  resolveOwnerFullNameByRelativePath,
  type ObjectScope,
} from './RepositoryObjectScope';
import type { RepositoryTarget } from './RepositoryService';

/**
 * Снимок объекта на момент захвата — «версия хранилища», к которой можно откатить
 * файлы при отмене захвата без повторной выгрузки из базы. Хранит хеши и копии файлов
 * области. Для рекурсивного захвата корня копировать всю конфигурацию дорого, поэтому
 * снимается только хеш-манифест: при отмене по нему определяются изменённые владельцы,
 * и выгружаются только они.
 *
 * Раскладка: `.v8vscedit/repository/snapshots/<scopeKey>/<sha1(fullName)>/{manifest.json,files/<rel>}`
 * — совпадает с прежней, чтобы снимки, снятые до обновления, оставались читаемыми
 * (манифест v1 — `{files}` без хешей).
 */
interface SnapshotManifest {
  version?: number;
  files: string[];
  hashes?: Record<string, string>;
}

interface RootManifest {
  version: 1;
  hashes: Record<string, string>;
}

export interface SnapshotBackupEntry {
  rel: string;
  backupPath: string;
  projectPath: string;
}

export interface SnapshotRestoreResult {
  /** Абсолютные пути файлов, возвращённых к версии снимка. */
  restored: string[];
  /** Абсолютные пути удалённых лишних файлов области. */
  deleted: string[];
  backups: SnapshotBackupEntry[];
}

const SNAPSHOT_MANIFEST_VERSION = 2;
const ROOT_MANIFEST_FILE = 'root-manifest.json';
const ALL_SCOPE: ObjectScope = { kind: 'all' };

export class RepositoryLockSnapshotStore {
  constructor(private readonly workspaceRoot: string) {}

  /** Снимок из каталога выгрузки (версия хранилища, полученная при захвате). */
  captureFromDirectory(target: RepositoryTarget, fullName: string, sourceDir: string, scope: ObjectScope): void {
    const snapshotDir = this.getSnapshotDir(target, fullName);
    // Актуален только снимок последнего захвата — предыдущий затирается.
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    const files = collectScopeFiles(sourceDir, scope);
    const hashes: Record<string, string> = {};
    for (const rel of files) {
      const source = path.join(sourceDir, rel);
      const destination = path.join(snapshotDir, 'files', rel);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      hashes[rel] = computeFileHash(source);
    }
    const manifest: SnapshotManifest = { version: SNAPSHOT_MANIFEST_VERSION, files, hashes };
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  }

  /** Пересъём снимка из проекта — после помещения с сохранением захвата версия хранилища = проект. */
  captureFromProject(target: RepositoryTarget, fullName: string, scope: ObjectScope): void {
    this.captureFromDirectory(target, fullName, target.configRoot, scope);
  }

  /** Хеши файлов снимка; `undefined` — снимка нет или манифест не читается. */
  readSnapshotHashes(target: RepositoryTarget, fullName: string): Record<string, string> | undefined {
    const snapshotDir = this.getSnapshotDir(target, fullName);
    const manifest = readSnapshotManifest(snapshotDir);
    if (!manifest) {
      return undefined;
    }
    const hashes: Record<string, string> = {};
    for (const rel of manifest.files) {
      const hash = manifest.hashes?.[rel] ?? hashIfExists(path.join(snapshotDir, 'files', rel));
      if (hash) {
        hashes[rel] = hash;
      }
    }
    return hashes;
  }

  /**
   * Возвращает область объекта к снимку: изменённые/удалённые файлы восстанавливаются,
   * лишние (появившиеся после захвата) удаляются. Всё, что перезаписывается или
   * удаляется, предварительно копируется в `backupDir`.
   */
  restoreToProject(
    target: RepositoryTarget,
    fullName: string,
    scope: ObjectScope,
    backupDir: string
  ): SnapshotRestoreResult {
    const result: SnapshotRestoreResult = { restored: [], deleted: [], backups: [] };
    const snapshotDir = this.getSnapshotDir(target, fullName);
    const manifest = readSnapshotManifest(snapshotDir);
    if (!manifest) {
      return result;
    }
    const projectLayout = detectScopeLayout(target.configRoot, scope);
    const expected = new Set<string>();
    for (const snapshotRel of manifest.files) {
      const source = path.join(snapshotDir, 'files', snapshotRel);
      if (!fs.existsSync(source)) {
        continue;
      }
      const rel = mapDumpPathToProject(snapshotRel, scope, projectLayout);
      expected.add(rel);
      const projectPath = path.join(target.configRoot, rel);
      if (fs.existsSync(projectPath) && filesAreEqual(projectPath, source)) {
        continue;
      }
      this.backup(rel, projectPath, backupDir, result);
      fs.mkdirSync(path.dirname(projectPath), { recursive: true });
      fs.copyFileSync(source, projectPath);
      result.restored.push(projectPath);
    }
    for (const rel of collectScopeFiles(target.configRoot, scope)) {
      if (expected.has(rel)) {
        continue;
      }
      const projectPath = path.join(target.configRoot, rel);
      this.backup(rel, projectPath, backupDir, result);
      fs.rmSync(projectPath, { force: true });
      removeEmptyParentDirs(target.configRoot, rel, scope);
      result.deleted.push(projectPath);
    }
    return result;
  }

  discard(target: RepositoryTarget, fullName: string): void {
    fs.rmSync(this.getSnapshotDir(target, fullName), { recursive: true, force: true });
  }

  /** Удаляет все снимки и манифест корня цели (отмена захвата корня, отвязка). */
  discardAll(target: RepositoryTarget): void {
    fs.rmSync(this.getScopeDir(target), { recursive: true, force: true });
  }

  /** Хеш-манифест всех файлов цели (без копий) — точка отсчёта рекурсивного захвата корня. */
  captureRootManifest(target: RepositoryTarget): void {
    const manifest: RootManifest = { version: 1, hashes: hashScopeFiles(target.configRoot, ALL_SCOPE) };
    const filePath = path.join(this.getScopeDir(target), ROOT_MANIFEST_FILE);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(manifest)}\n`, 'utf-8');
  }

  /** Владельцы, чьи файлы изменились, появились или исчезли относительно манифеста корня. */
  diffRootManifest(target: RepositoryTarget): { owners: string[]; hasManifest: boolean } {
    const manifest = readRootManifest(path.join(this.getScopeDir(target), ROOT_MANIFEST_FILE));
    if (!manifest) {
      return { owners: [], hasManifest: false };
    }
    const current = hashScopeFiles(target.configRoot, ALL_SCOPE);
    const changedRels = new Set<string>();
    for (const [rel, hash] of Object.entries(current)) {
      if (manifest.hashes[rel] !== hash) {
        changedRels.add(rel);
      }
    }
    Object.keys(manifest.hashes).filter((rel) => !(rel in current)).forEach((rel) => changedRels.add(rel));
    const owners = new Set<string>();
    for (const rel of changedRels) {
      const owner = resolveOwnerFullNameByRelativePath(rel, target);
      if (owner) {
        owners.add(owner);
      }
    }
    return { owners: [...owners].sort((left, right) => left.localeCompare(right)), hasManifest: true };
  }

  private backup(rel: string, projectPath: string, backupDir: string, result: SnapshotRestoreResult): void {
    if (!fs.existsSync(projectPath)) {
      return;
    }
    const backupPath = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(projectPath, backupPath);
    result.backups.push({ rel, backupPath, projectPath });
  }

  private getScopeDir(target: RepositoryTarget): string {
    return path.join(this.workspaceRoot, '.v8vscedit', 'repository', 'snapshots', buildRepositoryScopeKey(target));
  }

  private getSnapshotDir(target: RepositoryTarget, fullName: string): string {
    const fullNameHash = crypto.createHash('sha1').update(fullName).digest('hex');
    return path.join(this.getScopeDir(target), fullNameHash);
  }
}

function hashScopeFiles(baseDir: string, scope: ObjectScope): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of collectScopeFiles(baseDir, scope)) {
    hashes[rel] = computeFileHash(path.join(baseDir, rel));
  }
  return hashes;
}

function hashIfExists(filePath: string): string | undefined {
  try {
    return computeFileHash(filePath);
  } catch {
    return undefined;
  }
}

function readSnapshotManifest(snapshotDir: string): SnapshotManifest | null {
  const parsed = readJson(path.join(snapshotDir, 'manifest.json'));
  if (!parsed || !Array.isArray(parsed.files)) {
    return null;
  }
  const files = parsed.files.filter((item): item is string => typeof item === 'string');
  const hashes = isStringRecord(parsed.hashes) ? parsed.hashes : undefined;
  return { files, hashes };
}

function readRootManifest(filePath: string): RootManifest | null {
  const parsed = readJson(filePath);
  return parsed && isStringRecord(parsed.hashes) ? { version: 1, hashes: parsed.hashes } : null;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

function filesAreEqual(leftPath: string, rightPath: string): boolean {
  try {
    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
  } catch {
    return false;
  }
}
