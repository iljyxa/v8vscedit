import * as path from 'path';

/**
 * Источник статусов захвата хранилища: файловое хранилище (1CD) или сервер хранилища
 * (crserver по tcp/http(s)). Сервис выбирает первый источник, поддерживающий адрес
 * привязки, — второй вид хранилища подключается без правки модели и UI.
 */

export type RepositoryLocation =
  | { readonly kind: 'file'; readonly repoPath: string; readonly databaseFile: string }
  | { readonly kind: 'server'; readonly repoPath: string; readonly transport: 'tcp' | 'http' | 'https' };

const SERVER_SCHEME_RE = /^(tcp|https?):\/\//i;
const DATABASE_FILE_NAME = '1cv8ddb.1CD';

/**
 * Адрес привязки → вид хранилища. Сетевой — по схеме (без учёта регистра); иначе файловое:
 * относительный путь — от рабочей области, каталог дополняется именем файла базы.
 */
export function classifyRepositoryLocation(repoPath: string, workspaceRoot: string): RepositoryLocation {
  const trimmed = repoPath.trim();
  const scheme = SERVER_SCHEME_RE.exec(trimmed);
  if (scheme) {
    return { kind: 'server', repoPath: trimmed, transport: scheme[1].toLowerCase() as 'tcp' | 'http' | 'https' };
  }
  const resolved = path.resolve(workspaceRoot, trimmed);
  const databaseFile = /\.1cd$/i.test(resolved) ? resolved : path.join(resolved, DATABASE_FILE_NAME);
  return { kind: 'file', repoPath: resolved, databaseFile };
}

/** Захват объекта на сервере: uuid объекта (OBJID = uuid выгрузки), пользователь и время захвата. */
export interface RepositoryServerLockRecord {
  readonly objectId: string;
  readonly user: string;
  /** Локальное время сервера `YYYY-MM-DDTHH:mm:ss`. */
  readonly lockedAt?: string;
}

export interface RepositoryLockReadContext {
  readonly user: string;
  /** Пароль из SecretStorage — только в памяти, для хеша аутентификации сервера. */
  readonly password: string;
  readonly platformVersionHint: string;
}

export interface RepositoryLockReadResult {
  readonly records: RepositoryServerLockRecord[];
  /** Версия сервера, с которой вызов прошёл (для следующего рукопожатия). */
  readonly serverVersion?: string;
}

export type RepositoryLockStatusErrorCode =
  | 'not-found' | 'unavailable' | 'unsupported-format' | 'corrupted'
  | 'invalid-address' | 'timeout' | 'tls' | 'protocol' | 'too-large'
  | 'auth-failed' | 'server-error' | 'version-mismatch';

export class RepositoryLockStatusError extends Error {
  constructor(readonly code: RepositoryLockStatusErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RepositoryLockStatusError';
  }
}

export interface RepositoryLockStatusSource {
  supports(location: RepositoryLocation): boolean;
  readLocks(location: RepositoryLocation, context: RepositoryLockReadContext): Promise<RepositoryLockReadResult>;
}
