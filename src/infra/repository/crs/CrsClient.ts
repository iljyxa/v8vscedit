import * as crypto from 'crypto';
import { parseBracketText, type BracketNode } from '../OneCBracketText';
import { RepositoryLockStatusError } from '../RepositoryLockStatusSource';
import { buildCrsCallBody, parseCrsResponse, type CrsCallReturn } from '../../xml/CrsMessageXml';
import type { CrsAddress } from './CrsAddress';

/**
 * Вызов метода сервера хранилища: аутентификация хешем пароля, разбор исключений и
 * рукопожатие по версии. Атрибут `version` конверта должен совпасть с версией сервера,
 * иначе сервер отвечает исключением «несоответствие версий» с собственной версией внутри —
 * поэтому не больше двух вызовов: с подсказкой и с версией из исключения.
 */

/** md5 от пароля в UTF-16LE, нижний hex (так пароль хранит и сверяет сервер). */
export function hashCrsPassword(password: string): string {
  return crypto.createHash('md5').update(Buffer.from(password, 'utf16le')).digest('hex');
}

export interface CrsException {
  readonly clsid: string;
  readonly message: string;
  /** Код ошибки сервера (второе поле корня нагрузки): 4 — аутентификация, 17 — версия, 1 — хранилище не найдено. */
  readonly code?: string;
  readonly serverVersion?: string;
}

/** Вложенная структура исключения несоответствия версий: `{9f06d311-…, "", {…}, "<версия сервера>"}`. */
const VERSION_INFO_CLSID = '9f06d311-1431-4a54-bd6f-fa93c4d4c471';
const VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;
const AUTH_FAILED_CODE = '4';

/** base64 → UTF-8 (BOM) → скобочный формат; message — текст ошибки, serverVersion — из вложенной структуры. */
export function decodeCrsException(clsid: string, base64Payload: string): CrsException {
  let nodes: BracketNode[];
  try {
    nodes = parseBracketText(Buffer.from(base64Payload, 'base64').toString('utf-8'));
  } catch (error) {
    throw new RepositoryLockStatusError('protocol', `Некорректное исключение сервера хранилища ${clsid}: ${(error as Error).message}`);
  }
  const root = nodes[0];
  const message = at(at(root, 0), 1);
  const code = at(root, 1);
  return {
    clsid,
    message: typeof message === 'string' ? message : `Сервер хранилища вернул исключение ${clsid}.`,
    code: typeof code === 'string' ? code : undefined,
    serverVersion: findServerVersion(root),
  };
}

export interface CrsCallRequest {
  readonly method: string;
  readonly paramsXml: string;
  readonly user: string;
  readonly password: string;
  readonly versionHint: string;
}

export type CrsSender = (address: CrsAddress, body: Buffer) => Promise<Buffer>;

/** Не больше двух вызовов: второй — только при несоответствии версий с известной версией сервера. */
export async function callCrs(address: CrsAddress, request: CrsCallRequest, send: CrsSender): Promise<{ response: CrsCallReturn; serverVersion: string }> {
  const passwordHash = hashCrsPassword(request.password);
  const call = async (version: string): Promise<CrsCallReturn | CrsException> => {
    const body = buildCrsCallBody({ alias: address.alias, method: request.method, version, user: request.user, passwordHash, paramsXml: request.paramsXml });
    const response = parseCrsResponse(await send(address, body));
    return response.kind === 'return' ? response.value : decodeCrsException(response.clsid, response.payload);
  };
  const first = await call(request.versionHint);
  if (!isException(first)) {
    return { response: first, serverVersion: request.versionHint };
  }
  if (first.serverVersion === undefined) {
    throw toStatusError(first);
  }
  const serverVersion = first.serverVersion;
  const second = await call(serverVersion);
  if (!isException(second)) {
    return { response: second, serverVersion };
  }
  // После повтора с версией сервера возможна обычная ошибка (например, пароль) — её и показываем.
  throw second.serverVersion === undefined
    ? toStatusError(second)
    : new RepositoryLockStatusError('version-mismatch', `${second.message} (повтор с версией сервера ${serverVersion} не помог)`);
}

function isException(value: CrsCallReturn | CrsException): value is CrsException {
  return 'clsid' in value;
}

function toStatusError(exception: CrsException): RepositoryLockStatusError {
  return exception.code === AUTH_FAILED_CODE
    ? new RepositoryLockStatusError('auth-failed', `${exception.message} Проверьте пользователя и пароль хранилища в «Подключить к хранилищу».`)
    : new RepositoryLockStatusError('server-error', exception.message);
}

function at(node: BracketNode | undefined, index: number): BracketNode | undefined {
  return Array.isArray(node) ? node[index] : undefined;
}

function findServerVersion(node: BracketNode | undefined): string | undefined {
  if (!Array.isArray(node)) {
    return undefined;
  }
  const last = node[node.length - 1];
  if (node[0] === VERSION_INFO_CLSID && typeof last === 'string' && VERSION_RE.test(last)) {
    return last;
  }
  for (const child of node) {
    const found = findServerVersion(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}
