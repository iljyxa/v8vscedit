import * as fs from 'fs';
import * as path from 'path';
import { computeFileHash } from '../cache/HashCache';
import { parseObjectXml } from '../xml';
import {
  collectScopeFiles,
  detectScopeLayout,
  mapDumpPathToProject,
  toPosixRel,
  type ObjectScope,
} from './RepositoryObjectScope';

/**
 * Трёхстороннее сравнение файла при получении версии хранилища:
 * R — версия хранилища (временная выгрузка), L — локальный файл проекта,
 * B — последняя известная версия базы (хеш-кэш, при его отсутствии — снимок захвата).
 * `null` — файла на соответствующей стороне нет.
 */
export interface MergeFileState {
  /** Путь в проекте относительно корня конфигурации (POSIX). */
  rel: string;
  repositoryHash: string | null;
  localHash: string | null;
  baseHash: string | null;
  /** Путь в выгрузке, если раскладка XML объекта там другая. */
  dumpRel?: string;
  /** Область файла — чтобы применение убирало опустевшие каталоги только внутри неё. */
  scope?: ObjectScope;
  /** Частичная выгрузка не содержит файлов дочернего элемента — локальные не трогать. */
  incomplete?: boolean;
  /** Несохранённый редактор: молча перезаписывать/удалять файл нельзя. */
  forceConflict?: boolean;
}

export type MergeAction = 'noop' | 'write' | 'delete' | 'conflict-write' | 'conflict-delete' | 'skip-incomplete';

export interface MergePlanEntry extends MergeFileState {
  action: MergeAction;
}

export interface MergePlan {
  entries: MergePlanEntry[];
  conflicts: MergePlanEntry[];
  silent: MergePlanEntry[];
  skipped: MergePlanEntry[];
  hasConflicts: boolean;
}

export interface CollectMergeFileStatesOptions {
  configRoot: string;
  dumpDir: string;
  scopes: readonly ObjectScope[];
  baseHashes: Readonly<Record<string, string>>;
  snapshotHashes?: Readonly<Record<string, string>>;
  dirtyRelativePaths: readonly string[];
}

/**
 * Подкаталоги дочерних элементов объекта в выгрузке. Это раскладка формата
 * выгрузки (тег ChildObjects → подпапка), а не реестр типов метаданных.
 */
const CHILD_ELEMENT_DIRS: Readonly<Record<string, string>> = {
  Form: 'Forms',
  Template: 'Templates',
  Command: 'Commands',
};

const TEXT_MERGE_EXTENSIONS: ReadonlySet<string> = new Set(['.bsl', '.xml', '.txt', '.html', '.json']);

function decideAction(state: MergeFileState): MergeAction {
  if (state.incomplete) {
    return 'skip-incomplete';
  }
  const { repositoryHash, localHash, baseHash } = state;
  if (repositoryHash !== null) {
    if (state.forceConflict) {
      return 'conflict-write';
    }
    if (localHash === repositoryHash) {
      return 'noop';
    }
    const untouchedLocally = localHash === null ? baseHash === null : localHash === baseHash;
    return untouchedLocally ? 'write' : 'conflict-write';
  }
  if (localHash === null) {
    return 'noop';
  }
  return !state.forceConflict && localHash === baseHash ? 'delete' : 'conflict-delete';
}

/** Чистая функция: решение по каждому файлу и раскладка по группам для диалога. */
export function planRepositoryMerge(states: readonly MergeFileState[]): MergePlan {
  const entries = states.map((state): MergePlanEntry => ({ ...state, action: decideAction(state) }));
  const conflicts = entries.filter((entry) => entry.action === 'conflict-write' || entry.action === 'conflict-delete');
  return {
    entries,
    conflicts,
    silent: entries.filter((entry) => entry.action === 'write' || entry.action === 'delete'),
    skipped: entries.filter((entry) => entry.action === 'skip-incomplete'),
    hasConflicts: conflicts.length > 0,
  };
}

/** Файл, который имеет смысл показывать в текстовом диффе. */
export function isTextMergeFile(rel: string): boolean {
  return TEXT_MERGE_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

/** Сравнение текущих хешей области с эталоном (снимок или выгрузка). */
export function diffScopeAgainstEtalon(
  etalon: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>
): { changed: string[]; missing: string[]; extra: string[] } {
  const byName = (left: string, right: string): number => left.localeCompare(right);
  return {
    changed: Object.keys(etalon).filter((rel) => rel in current && current[rel] !== etalon[rel]).sort(byName),
    missing: Object.keys(etalon).filter((rel) => !(rel in current)).sort(byName),
    extra: Object.keys(current).filter((rel) => !(rel in etalon)).sort(byName),
  };
}

/** Состояния R/L/B для всех файлов областей в проекте и выгрузке. */
export function collectMergeFileStates(options: CollectMergeFileStatesOptions): MergeFileState[] {
  const dirty = new Set(options.dirtyRelativePaths.map(toPosixRel));
  const states = new Map<string, MergeFileState>();
  for (const scope of options.scopes) {
    const projectLayout = detectScopeLayout(options.configRoot, scope);
    const dumpFiles = collectScopeFiles(options.dumpDir, scope);
    const incompleteDirs = collectIncompleteChildDirs(options.dumpDir, scope, dumpFiles);
    const dumpByProjectRel = new Map<string, string>();
    for (const dumpRel of dumpFiles) {
      dumpByProjectRel.set(toPosixRel(mapDumpPathToProject(dumpRel, scope, projectLayout)), dumpRel);
    }
    const projectFiles = collectScopeFiles(options.configRoot, scope);
    for (const rel of new Set([...dumpByProjectRel.keys(), ...projectFiles])) {
      if (states.has(rel)) {
        continue;
      }
      const dumpRel = dumpByProjectRel.get(rel);
      const state: MergeFileState = {
        rel,
        repositoryHash: dumpRel ? computeFileHash(path.join(options.dumpDir, dumpRel)) : null,
        localHash: hashIfExists(path.join(options.configRoot, rel)),
        baseHash: lookupHash(options.baseHashes, rel) ?? lookupHash(options.snapshotHashes, rel),
        scope,
      };
      if (dumpRel && dumpRel !== rel) {
        state.dumpRel = dumpRel;
      }
      if (!dumpRel && incompleteDirs.some((dir) => rel === `${dir}.xml` || rel.startsWith(`${dir}/`))) {
        state.incomplete = true;
      }
      if (dirty.has(rel)) {
        state.forceConflict = true;
      }
      states.set(rel, state);
    }
  }
  return [...states.values()];
}

/**
 * Защита от неполной частичной выгрузки: если дочерний элемент (форма, макет,
 * команда) есть в ChildObjects версии хранилища, но его файлов в выгрузке нет,
 * отсутствие файлов не означает удаления — локальные файлы элемента не трогаются.
 */
function collectIncompleteChildDirs(dumpDir: string, scope: ObjectScope, dumpFiles: readonly string[]): string[] {
  if (scope.kind !== 'object') {
    return [];
  }
  const xmlRel = dumpFiles.find((rel) => rel.endsWith('.xml') && isObjectXmlRel(rel, scope));
  if (!xmlRel) {
    return [];
  }
  let children: { tag: string; name: string }[];
  try {
    children = parseObjectXml(path.join(dumpDir, xmlRel))?.children ?? [];
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const child of children) {
    const subDir = CHILD_ELEMENT_DIRS[child.tag] as string | undefined;
    if (!subDir) {
      continue;
    }
    const childDir = `${scope.dirRel}/${subDir}/${child.name}`;
    if (!dumpFiles.some((rel) => rel === `${childDir}.xml` || rel.startsWith(`${childDir}/`))) {
      result.push(childDir);
    }
  }
  return result;
}

function isObjectXmlRel(rel: string, scope: Extract<ObjectScope, { kind: 'object' }>): boolean {
  const name = path.posix.basename(scope.dirRel);
  return rel === `${scope.dirRel}/${name}.xml` || rel === `${path.posix.dirname(scope.dirRel)}/${name}.xml`;
}

function lookupHash(hashes: Readonly<Record<string, string>> | undefined, rel: string): string | null {
  return hashes && Object.prototype.hasOwnProperty.call(hashes, rel) ? hashes[rel] : null;
}

function hashIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? computeFileHash(filePath) : null;
}
