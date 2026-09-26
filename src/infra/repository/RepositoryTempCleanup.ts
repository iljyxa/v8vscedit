import * as fs from 'fs';
import * as path from 'path';

/**
 * Временные артефакты операций хранилища в `.v8vscedit/repository`: файлы `Objects.xml`
 * для `-ObjectsFile` и каталоги резервных копий слияния. Единственное место, знающее их
 * раскладку, — и запись, и очистка опираются на функции этого модуля.
 */

export interface MergeBackupRetention {
  /** Каталог старше этого возраста удаляется (строго больше). */
  readonly maxAgeMs: number;
  /** Сколько последних каталогов хранится в каждом scope. */
  readonly maxPerScope: number;
}

export const DEFAULT_MERGE_BACKUP_RETENTION: MergeBackupRetention = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxPerScope: 20,
};

/**
 * Метка времени в имени каталога бэкапа — формат `buildMergeBackupDir`:
 * `toISOString()` с заменой `:` и `.` на `-`, затем `-<метка операции>`.
 */
const MERGE_BACKUP_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-.+$/;

function getRepositoryTempRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.v8vscedit', 'repository');
}

export function getRepositoryObjectsDir(workspaceRoot: string): string {
  return path.join(getRepositoryTempRoot(workspaceRoot), 'objects');
}

export function getRepositoryMergeRoot(workspaceRoot: string): string {
  return path.join(getRepositoryTempRoot(workspaceRoot), 'merge');
}

/** Отсутствие каталога — нормальное состояние «чистить нечего»; прочие сбои — наружу. */
function readDirOrEmpty(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Удаляет все `*.xml` из каталога `objects/`. Файлы создаются только внутри аренды
 * общего guard'а хранилища, поэтому в начале аренды любой из них — хвост прерванной
 * операции, а не файл работающего Конфигуратора.
 */
export function pruneRepositoryObjectsFiles(workspaceRoot: string): string[] {
  const dir = getRepositoryObjectsDir(workspaceRoot);
  const removed: string[] = [];
  for (const entry of readDirOrEmpty(dir)) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
      const filePath = path.join(dir, entry.name);
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    }
  }
  return removed;
}

function parseMergeBackupStamp(name: string): number | undefined {
  const match = MERGE_BACKUP_NAME.exec(name);
  if (!match) {
    return undefined;
  }
  const [, date, hours, minutes, seconds, millis] = match;
  const time = Date.parse(`${date}T${hours}:${minutes}:${seconds}.${millis}Z`);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Ротация резервных копий слияния по всем scope: удаляется каталог старше
 * `maxAgeMs` или не входящий в `maxPerScope` последних своего scope. Возраст берётся из
 * имени, а не из mtime: копирование/распаковка рабочей области mtime меняют. Имена
 * другого формата и метки из будущего (сбитые часы) не трогаются и в счёт лимита не
 * входят — удалять то, что не понимаешь, опаснее, чем оставить. Опустевший каталог
 * scope удаляется.
 */
export function pruneMergeBackups(
  workspaceRoot: string,
  now: Date,
  retention: MergeBackupRetention = DEFAULT_MERGE_BACKUP_RETENTION
): string[] {
  const root = getRepositoryMergeRoot(workspaceRoot);
  const nowMs = now.getTime();
  const removed: string[] = [];
  for (const scopeEntry of readDirOrEmpty(root)) {
    if (!scopeEntry.isDirectory()) {
      continue;
    }
    const scopeDir = path.join(root, scopeEntry.name);
    const backups = readDirOrEmpty(scopeDir)
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ dir: path.join(scopeDir, entry.name), time: parseMergeBackupStamp(entry.name) }))
      .filter((backup): backup is { dir: string; time: number } => backup.time !== undefined && backup.time <= nowMs)
      .sort((left, right) => right.time - left.time);
    backups.forEach((backup, index) => {
      if (nowMs - backup.time > retention.maxAgeMs || index >= retention.maxPerScope) {
        fs.rmSync(backup.dir, { recursive: true, force: true });
        removed.push(backup.dir);
      }
    });
    if (fs.readdirSync(scopeDir).length === 0) {
      fs.rmdirSync(scopeDir);
    }
  }
  return removed;
}

/**
 * Ресурс освобождается, только если тело упало: при успехе владение переходит
 * вызывающему (обычно — в возвращаемом значении).
 */
export function disposeOnError<T>(resource: { dispose(): void }, body: () => T): T {
  try {
    return body();
  } catch (error) {
    resource.dispose();
    throw error;
  }
}

export async function disposeOnErrorAsync<T>(resource: { dispose(): void }, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    resource.dispose();
    throw error;
  }
}
