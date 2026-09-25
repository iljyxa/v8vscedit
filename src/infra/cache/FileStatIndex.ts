import * as fs from 'fs';
import {
  computeFileHash,
  createHashSnapshot,
  resolveHashCacheFileStem,
  walkSupportedFiles,
  type HashCacheSnapshot,
} from './HashCache';
import { writeFileAtomicSync } from '../fs/AtomicFileWrite';

export const FILE_STAT_INDEX_SCHEMA_VERSION = 1;

/**
 * Окно «ненадёжного» stat: изменение файла в пределах гранулярности mtime
 * (до 2 с на FAT) может не сдвинуть отметку времени, поэтому свежие файлы в
 * индекс не попадают и перехешируются на следующем проходе (как racy-git).
 */
export const FILE_STAT_RACY_WINDOW_MS = 2000;

export interface FileStatEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  hash: string;
}

/**
 * Stat-индекс рабочего дерева: только ускоритель построения снапшота хешей,
 * а не источник правды. Любая неуверенность в записи — повод перехешировать файл.
 */
export interface FileStatIndex {
  schemaVersion: 1;
  scopeKey: string;
  files: Record<string, FileStatEntry>;
}

export interface HashSnapshotWithStatIndex {
  snapshot: HashCacheSnapshot;
  index: FileStatIndex;
  /** Нужно ли сохранять индекс: неизменный индекс не переписываем лишний раз. */
  indexChanged: boolean;
  /** Сколько файлов пришлось прочитать и хешировать заново. */
  hashedCount: number;
}

export function createEmptyFileStatIndex(scopeKey: string): FileStatIndex {
  return { schemaVersion: FILE_STAT_INDEX_SCHEMA_VERSION, scopeKey, files: {} };
}

/**
 * Загружает индекс области. Любой дефект файла даёт пустой индекс, а не ошибку:
 * потеря индекса стоит лишь полного перехеширования, а не корректности.
 */
export function loadFileStatIndex(projectRoot: string, scopeKey: string): FileStatIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getStatIndexFilePath(projectRoot, scopeKey), 'utf-8'));
  } catch {
    return createEmptyFileStatIndex(scopeKey);
  }

  if (
    !isPlainObject(parsed)
    || parsed.schemaVersion !== FILE_STAT_INDEX_SCHEMA_VERSION
    || parsed.scopeKey !== scopeKey
    || !isPlainObject(parsed.files)
  ) {
    return createEmptyFileStatIndex(scopeKey);
  }

  // Отбрасываем записи неверной формы поштучно: одна испорченная запись не
  // должна обесценивать весь индекс и заставлять перехешировать выгрузку целиком.
  const files: Record<string, FileStatEntry> = {};
  for (const [relativePath, value] of Object.entries(parsed.files)) {
    if (isFileStatEntry(value)) {
      files[relativePath] = { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, hash: value.hash };
    }
  }
  return { schemaVersion: FILE_STAT_INDEX_SCHEMA_VERSION, scopeKey, files };
}

/**
 * Сохраняет индекс рядом со снапшотом хешей той же области. Ошибку записи не
 * глушит — решение о её допустимости принимает вызывающий.
 */
export function saveFileStatIndex(projectRoot: string, index: FileStatIndex): void {
  writeFileAtomicSync(getStatIndexFilePath(projectRoot, index.scopeKey), JSON.stringify(index));
}

export function isFileStatEntryReusable(
  entry: FileStatEntry | undefined,
  stat: Pick<fs.Stats, 'size' | 'mtimeMs' | 'ctimeMs'>
): entry is FileStatEntry {
  if (!entry) {
    return false;
  }
  // ctime входит в критерий, т.к. его нельзя выставить utimes: подмена mtime
  // «назад» (checkout, распаковка архива) всё равно сдвигает ctime.
  return entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.ctimeMs === stat.ctimeMs;
}

export function isRacyFileStat(stat: Pick<fs.Stats, 'mtimeMs' | 'ctimeMs'>, nowMs: number): boolean {
  // Отметки из будущего (рассинхрон часов, сетевые ФС) тоже считаем ненадёжными.
  return nowMs - Math.max(stat.mtimeMs, stat.ctimeMs) < FILE_STAT_RACY_WINDOW_MS;
}

/**
 * Строит снапшот хешей, читая содержимое только тех файлов, чей stat не совпал
 * с индексом. Результат `snapshot` эквивалентен `buildHashSnapshot` при условии,
 * что совпадение size+mtime+ctime означает неизменное содержимое.
 */
export function buildHashSnapshotWithStatIndex(
  scopeKey: string,
  configDir: string,
  previous: FileStatIndex,
  nowMs: number
): HashSnapshotWithStatIndex {
  const previousFiles: Partial<Record<string, FileStatEntry>> = previous.files;
  const hashes: Record<string, string> = {};
  const indexFiles: Record<string, FileStatEntry> = {};
  let hashedCount = 0;

  walkSupportedFiles(configDir, (fullPath, relativePath) => {
    // stat — до чтения содержимого: если файл изменится между stat и чтением,
    // индекс запомнит старый stat, и следующий проход перехеширует файл.
    const stat = fs.statSync(fullPath);
    const previousEntry = previousFiles[relativePath];
    let hash: string;
    if (isFileStatEntryReusable(previousEntry, stat)) {
      hash = previousEntry.hash;
    } else {
      hash = computeFileHash(fullPath);
      hashedCount += 1;
    }
    hashes[relativePath] = hash;
    if (!isRacyFileStat(stat, nowMs)) {
      indexFiles[relativePath] = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash };
    }
  });

  return {
    snapshot: createHashSnapshot(scopeKey, hashes),
    index: { schemaVersion: FILE_STAT_INDEX_SCHEMA_VERSION, scopeKey, files: indexFiles },
    indexChanged: !hasSameEntries(previousFiles, indexFiles),
    hashedCount,
  };
}

function getStatIndexFilePath(projectRoot: string, scopeKey: string): string {
  return `${resolveHashCacheFileStem(projectRoot, scopeKey)}.stat.json`;
}

function hasSameEntries(
  previous: Partial<Record<string, FileStatEntry>>,
  next: Record<string, FileStatEntry>
): boolean {
  const nextPaths = Object.keys(next);
  if (nextPaths.length !== Object.keys(previous).length) {
    return false;
  }
  return nextPaths.every((relativePath) => {
    const left = previous[relativePath];
    const right = next[relativePath];
    // left отсутствует у новых путей: left?.size даёт undefined и сравнение ложно.
    return left?.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs
      && left.hash === right.hash;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileStatEntry(value: unknown): value is FileStatEntry {
  return isPlainObject(value)
    && isFiniteNumber(value.size)
    && isFiniteNumber(value.mtimeMs)
    && isFiniteNumber(value.ctimeMs)
    && typeof value.hash === 'string'
    && value.hash.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
