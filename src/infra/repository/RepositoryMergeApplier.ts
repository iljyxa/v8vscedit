import * as fs from 'fs';
import * as path from 'path';
import { computeFileHash, patchHashCacheEntries } from '../cache/HashCache';
import type { MergePlan, MergePlanEntry } from './RepositoryMergePlanner';
import { removeEmptyParentDirs, type ObjectScope } from './RepositoryObjectScope';
import type { RepositoryTarget } from './RepositoryService';
import { getRepositoryMergeRoot } from './RepositoryTempCleanup';

/**
 * Исход единственного диалога конфликтов:
 *  - `replace` — версия хранилища поверх локальной (локальная — в бэкап);
 *  - `compare` — то же, что `replace`, после чего открываются диффы «бэкап ↔ проект»;
 *  - `keep-local` — конфликтные файлы остаются как есть, версия хранилища кладётся рядом.
 */
export type MergeChoice = 'compare' | 'replace' | 'keep-local';

export interface ApplyRepositoryMergeOptions {
  /** Корень рабочей области — там живёт хеш-кэш `.v8vscedit/cache`. */
  projectRoot: string;
  target: RepositoryTarget;
  dumpDir: string;
  plan: MergePlan;
  choice: MergeChoice;
  backupDir: string;
  /** Вызывается до записи с абсолютными путями — для подавления реакции watcher'а. */
  beforeWrite: (filePaths: string[]) => void;
}

export interface MergeBackupEntry {
  rel: string;
  backupPath: string;
  projectPath: string;
}

export interface MergeRepositoryCopy {
  rel: string;
  repositoryPath: string;
  projectPath: string;
}

export interface MergeApplyResult {
  writtenFiles: string[];
  deletedFiles: string[];
  /** Конфликтные файлы, оставленные с расхождением от базы (`keep-local`). */
  keptLocalFiles: string[];
  backups: MergeBackupEntry[];
  repositoryCopies: MergeRepositoryCopy[];
}

/** Подкаталог бэкапа, куда при `keep-local` кладётся версия хранилища. */
const REPOSITORY_COPY_DIR = 'repository';
const ALL_SCOPE: ObjectScope = { kind: 'all' };

/**
 * `.v8vscedit/repository/merge/<scopeKey>/<время>-<метка>` — уникален на операцию.
 * Формат имени разбирает ротация `pruneMergeBackups`: меняется только вместе с ней.
 */
export function buildMergeBackupDir(workspaceRoot: string, scopeKey: string, label: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(getRepositoryMergeRoot(workspaceRoot), scopeKey, `${stamp}-${label}`);
}

/**
 * Применяет план слияния побайтовым копированием (BOM и переводы строк версии
 * хранилища сохраняются как есть). Хеш-кэш после применения описывает состояние
 * базы: записанным и оставленным локально файлам проставляется хеш версии
 * хранилища, удалённые из кэша убираются.
 */
export function applyRepositoryMerge(options: ApplyRepositoryMergeOptions): MergeApplyResult {
  const result: MergeApplyResult = { writtenFiles: [], deletedFiles: [], keptLocalFiles: [], backups: [], repositoryCopies: [] };
  const configRoot = options.target.configRoot;
  const keepLocal = options.choice === 'keep-local';
  const cacheEntries: Record<string, string> = {};
  const cacheDeleted: string[] = [];

  const toWrite: MergePlanEntry[] = [];
  const toDelete: MergePlanEntry[] = [];
  for (const entry of options.plan.entries) {
    const isConflict = entry.action === 'conflict-write' || entry.action === 'conflict-delete';
    if (entry.action === 'noop' && entry.repositoryHash !== null) {
      cacheEntries[entry.rel] = entry.repositoryHash;
    } else if (isConflict && keepLocal) {
      keepLocalEntry(entry, options, result, cacheEntries, cacheDeleted);
    } else if (entry.action === 'write' || entry.action === 'conflict-write') {
      toWrite.push(entry);
    } else if (entry.action === 'delete' || entry.action === 'conflict-delete') {
      toDelete.push(entry);
    }
  }

  const touched = [...toWrite, ...toDelete].map((entry) => path.join(configRoot, entry.rel));
  if (touched.length > 0) {
    options.beforeWrite(touched);
  }

  for (const entry of toWrite) {
    const projectPath = path.join(configRoot, entry.rel);
    backupIfNeeded(entry, projectPath, options.backupDir, result);
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.copyFileSync(path.join(options.dumpDir, entry.dumpRel ?? entry.rel), projectPath);
    result.writtenFiles.push(projectPath);
    cacheEntries[entry.rel] = computeFileHash(projectPath);
  }

  for (const entry of toDelete) {
    const projectPath = path.join(configRoot, entry.rel);
    backupIfNeeded(entry, projectPath, options.backupDir, result);
    fs.rmSync(projectPath, { force: true });
    removeEmptyParentDirs(configRoot, entry.rel, entry.scope ?? ALL_SCOPE);
    result.deletedFiles.push(projectPath);
    cacheDeleted.push(entry.rel);
  }

  patchHashCacheEntries(
    options.projectRoot,
    options.target.configKind,
    configRoot,
    options.target.extensionName ?? '',
    cacheEntries,
    cacheDeleted
  );
  return result;
}


function keepLocalEntry(
  entry: MergePlanEntry,
  options: ApplyRepositoryMergeOptions,
  result: MergeApplyResult,
  cacheEntries: Record<string, string>,
  cacheDeleted: string[]
): void {
  const projectPath = path.join(options.target.configRoot, entry.rel);
  result.keptLocalFiles.push(projectPath);
  if (entry.repositoryHash === null) {
    cacheDeleted.push(entry.rel);
    return;
  }
  const repositoryPath = path.join(options.backupDir, REPOSITORY_COPY_DIR, entry.rel);
  fs.mkdirSync(path.dirname(repositoryPath), { recursive: true });
  fs.copyFileSync(path.join(options.dumpDir, entry.dumpRel ?? entry.rel), repositoryPath);
  result.repositoryCopies.push({ rel: entry.rel, repositoryPath, projectPath });
  cacheEntries[entry.rel] = entry.repositoryHash;
}

/**
 * Бэкап обязателен для конфликтного файла и для любого файла, изменившегося между
 * построением плана и применением: план строится вне аренды, и пользователь мог
 * успеть сохранить правку, которую молчаливая запись иначе потеряла бы.
 */
function backupIfNeeded(entry: MergePlanEntry, projectPath: string, backupDir: string, result: MergeApplyResult): void {
  if (!fs.existsSync(projectPath)) {
    return;
  }
  const isConflict = entry.action === 'conflict-write' || entry.action === 'conflict-delete';
  if (!isConflict && computeFileHash(projectPath) === entry.localHash) {
    return;
  }
  const backupPath = path.join(backupDir, entry.rel);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(projectPath, backupPath);
  result.backups.push({ rel: entry.rel, backupPath, projectPath });
}
