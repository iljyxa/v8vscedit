import { OneCdFile, OneCdFormatError } from './onecd/OneCdFile';
import { formatGuidBytesLe, readOneCdTable, type OneCdValue } from './onecd/OneCdTable';
import {
  RepositoryLockStatusError,
  type RepositoryLocation,
  type RepositoryLockReadResult,
  type RepositoryLockStatusSource,
  type RepositoryServerLockRecord,
} from './RepositoryLockStatusSource';

/**
 * Файловое хранилище: захваты — записи OBJECTS с `REVISED = true`, держатель — USERS по
 * `REVISORID`, время — `REVISEDATE`. Файл открывается только на чтение: хранилище
 * разделяемое, писать в него может только платформа.
 */
export class FileRepositoryLockStatusSource implements RepositoryLockStatusSource {
  supports(location: RepositoryLocation): boolean {
    return location.kind === 'file';
  }

  // Контекст (пользователь, пароль) файловому хранилищу не нужен: файл читается без аутентификации.
  async readLocks(location: RepositoryLocation): Promise<RepositoryLockReadResult> {
    if (location.kind !== 'file') {
      throw new RepositoryLockStatusError('invalid-address', `Адрес ${location.repoPath} не является файловым хранилищем.`);
    }
    const filePath = location.databaseFile;
    let file: OneCdFile;
    try {
      file = await OneCdFile.open(filePath);
    } catch (error) {
      throw toStatusError(error, filePath);
    }
    try {
      const users = await readOneCdTable(file, 'USERS');
      const objects = (await readOneCdTable(file, 'OBJECTS')).map((row) => ({
        objectId: formatGuidBytesLe(row.OBJID as Buffer),
        revised: row.REVISED === true,
        revisor: binaryKey(row.REVISORID),
        lockedAt: typeof row.REVISEDATE === 'string' ? row.REVISEDATE : undefined,
      }));
      // Соединение USERS × OBJECTS: захват с держателем, которого нет в USERS, не выводится.
      const records: RepositoryServerLockRecord[] = [];
      for (const user of users) {
        const userKey = binaryKey(user.USERID);
        for (const object of objects) {
          if (object.revised && object.revisor === userKey) {
            records.push({ objectId: object.objectId, user: user.NAME as string, lockedAt: object.lockedAt });
          }
        }
      }
      return { records };
    } catch (error) {
      throw toStatusError(error, filePath);
    } finally {
      await file.close();
    }
  }
}

/** Ошибка доступа к файлу хранилища → код и понятная причина с путём. */
export function classifyFileAccessError(error: unknown, filePath: string): RepositoryLockStatusError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new RepositoryLockStatusError('not-found', `Файл хранилища не найден: ${filePath}`, { cause: error });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new RepositoryLockStatusError('unavailable', `Файл хранилища недоступен: ${filePath} (${reason})`, { cause: error });
}

function toStatusError(error: unknown, filePath: string): RepositoryLockStatusError {
  if (!(error instanceof OneCdFormatError)) {
    return classifyFileAccessError(error, filePath);
  }
  switch (error.code) {
    case 'not-1cd':
      return new RepositoryLockStatusError('unsupported-format', `Файл не является файлом хранилища 1CD: ${filePath}`, { cause: error });
    case 'corrupted':
      return new RepositoryLockStatusError('corrupted', `${error.message} Файл: ${filePath}`, { cause: error });
    /* c8 ignore next 2 -- версия формата ≠ 8.3.8 и незнакомые поля/Recordlock: см. OneCdFile/OneCdTable */
    default:
      return new RepositoryLockStatusError('unsupported-format', `Формат файла хранилища не поддерживается: ${error.message}`, { cause: error });
  }
}

function binaryKey(value: OneCdValue): string | undefined {
  return Buffer.isBuffer(value) ? value.toString('hex') : undefined;
}
