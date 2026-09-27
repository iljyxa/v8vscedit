import { RepositoryLockStatusError } from '../RepositoryLockStatusSource';

/**
 * Адрес сервера хранилища из строки подключения привязки:
 *  - http(s): POST на URL до `.1ccr` включительно, alias — сегмент пути после `.1ccr`
 *    (без хвоста — `maincr`); путь в connectString публикации на alias не влияет;
 *  - tcp: `tcp://host[:port]/<alias>`, alias — каталог хранилища на сервере (так его
 *    передаёт Конфигуратор, проверено снятым запросом), порт по умолчанию 1542.
 */
export interface CrsAddress {
  readonly transport: 'tcp' | 'http' | 'https';
  readonly host: string;
  readonly port: number;
  /** Путь POST для http(s) (до `.1ccr` включительно); для tcp не используется. */
  readonly requestPath: string;
  readonly alias: string;
}

export const CRS_DEFAULT_TCP_PORT = 1542;
export const CRS_DEFAULT_ALIAS = 'maincr';

const HTTP_PATH_RE = /^(.*?\.1ccr)(?:\/([^/]+))?\/?$/i;

export function parseCrsAddress(repoPath: string): CrsAddress {
  let url: URL;
  try {
    url = new URL(repoPath.trim());
  } catch {
    throw invalidAddress(repoPath, 'строка не является адресом');
  }
  // У URL хост IPv6 в скобках; сокету нужен адрес без них.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  const transport = url.protocol.slice(0, -1);
  if (transport === 'tcp') {
    const alias = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
    if (!alias) {
      throw invalidAddress(repoPath, 'не указано имя хранилища (tcp://сервер[:порт]/имя)');
    }
    return { transport, host, port: port || CRS_DEFAULT_TCP_PORT, requestPath: '', alias };
  }
  if (transport !== 'http' && transport !== 'https') {
    throw invalidAddress(repoPath, 'поддерживаются tcp://, http:// и https://');
  }
  const match = HTTP_PATH_RE.exec(url.pathname);
  if (!match) {
    throw invalidAddress(repoPath, 'адрес веб-публикации должен указывать на файл .1ccr');
  }
  return {
    transport,
    host,
    port: port || (transport === 'https' ? 443 : 80),
    requestPath: match[1],
    alias: match[2] ? decodeURIComponent(match[2]) : CRS_DEFAULT_ALIAS,
  };
}

function invalidAddress(repoPath: string, reason: string): RepositoryLockStatusError {
  return new RepositoryLockStatusError('invalid-address', `Неверный адрес хранилища «${repoPath}»: ${reason}.`);
}
