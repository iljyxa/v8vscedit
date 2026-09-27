import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { SecretStore } from '../../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../../infra/environment/ProjectSecretStorage';
import { dumpInfoOwnerToRepositoryFullName } from '../../../infra/repository/RepositoryObjectNames';
import { RepositoryService, type RepositoryBinding, type RepositoryTarget } from '../../../infra/repository/RepositoryService';

/**
 * Фикстура захватов хранилища (issue #6): `example/repository/2.21-locks`, собрана
 * `example/tools/build-repository-locks.mjs` на реальных платформах. Сценарий
 * (`scenario.json`) — шаги захвата и ожидаемые захваты по имени записи
 * ConfigDumpInfo.xml; `<версия>/run.json` — то, что намерил генератор (окно времени
 * захватов, alias, размер страницы 1CD).
 */
export const REPOSITORY_LOCKS_ROOT = path.resolve(__dirname, '../../../../example/repository/2.21-locks');
/**
 * Фикстуры частичного отказа рекурсивного захвата (issue #87), тот же генератор:
 * `2.21-partial-locks` — отказы по подчинённой форме и по якорю справочника,
 * `2.21-partial-root` — рекурсивный захват корня при чужом захвате Справочник.Банки.
 * Ожидаемые строки успеха/отказа /Out — `expect` шага сценария.
 */
export const PARTIAL_LOCKS_ROOT = path.resolve(__dirname, '../../../../example/repository/2.21-partial-locks');
export const PARTIAL_ROOT_ROOT = path.resolve(__dirname, '../../../../example/repository/2.21-partial-root');
/**
 * Привязка к хранилищу пользователем с уже имеющимися захватами (issue #106), тот же генератор:
 * `bind-own-locks.out.txt` — вывод привязки пустой базы Petrov (блок непомеченных захватов),
 * `bind-not-empty.out.txt` — отказ привязки базы с загруженной конфигурацией без -forceReplaceCfg.
 * Ожидаемый блок — `binds[0].expect.unmarked` сценария.
 */
export const BIND_LOCKS_ROOT = path.resolve(__dirname, '../../../../example/repository/2.21-bind');
export const REPOSITORY_TLS_DIR = path.resolve(__dirname, '../../../../example/repository/tls');
export const EXAMPLE_CF_221 = path.resolve(__dirname, '../../../../example/2.21/src/cf');

/** Версии платформы с файловой фикстурой (1CD + вывод отказа захвата). */
export const LOCK_FIXTURE_VERSIONS = ['8.5.1', '8.3.27'] as const;
/** Версии с сетевой фикстурой (обмены с crserver); 8.3.27 дописывается при съёме. */
export const NETWORK_FIXTURE_VERSIONS = ['8.5.1'] as const;

export type LockFixtureVersion = (typeof LOCK_FIXTURE_VERSIONS)[number];
export type NetworkFixtureVersion = (typeof NETWORK_FIXTURE_VERSIONS)[number];

export const CRS_EXCHANGES = ['statistic-admin', 'statistic-petrov', 'version-mismatch', 'auth-failed', 'alias-not-found'] as const;
export type CrsExchangeName = (typeof CRS_EXCHANGES)[number];

export interface LockScenario {
  alias: string;
  users: { name: string; password: string }[];
  locks: { dumpName: string; user: string }[];
  refusals: { objectName: string; user: string }[];
}

export interface LockRun {
  platform: string;
  alias: string;
  lockedFrom: string;
  lockedTo: string;
  pageSize: number;
}

export function readScenario(): LockScenario {
  return JSON.parse(fs.readFileSync(path.join(REPOSITORY_LOCKS_ROOT, 'scenario.json'), 'utf-8')) as LockScenario;
}

export interface LockStepExpectation {
  grants: string[];
  refusals: { objectName: string; user: string }[];
}

export function readScenarioAt(root: string): LockScenario & { steps: { log?: string; expect?: LockStepExpectation }[] } {
  return JSON.parse(fs.readFileSync(path.join(root, 'scenario.json'), 'utf-8')) as LockScenario & {
    steps: { log?: string; expect?: LockStepExpectation }[];
  };
}

export interface BindScenario {
  binds: { user: string; log: string; expect: { unmarked?: string[]; contains?: string } }[];
}

export function readBindScenario(): BindScenario {
  return JSON.parse(fs.readFileSync(path.join(BIND_LOCKS_ROOT, 'scenario.json'), 'utf-8')) as BindScenario;
}

export function scenarioFixturePath(root: string, version: LockFixtureVersion, ...parts: string[]): string {
  return path.join(root, version, ...parts);
}

export function readRun(version: LockFixtureVersion): LockRun {
  return JSON.parse(fs.readFileSync(lockFixturePath(version, 'run.json'), 'utf-8')) as LockRun;
}

export function lockFixturePath(version: LockFixtureVersion, ...parts: string[]): string {
  return path.join(REPOSITORY_LOCKS_ROOT, version, ...parts);
}

export function readTcpExchange(version: NetworkFixtureVersion, name: CrsExchangeName): { client: Buffer; server: Buffer } {
  return {
    client: fs.readFileSync(lockFixturePath(version, 'tcp', `${name}.client.bin`)),
    server: fs.readFileSync(lockFixturePath(version, 'tcp', `${name}.server.bin`)),
  };
}

export interface HttpExchange {
  request: Buffer;
  response: Buffer;
  meta: { method: string; path: string; status: number; headers: Record<string, string> };
}

export function readHttpExchange(version: NetworkFixtureVersion, name: CrsExchangeName): HttpExchange {
  const base = lockFixturePath(version, 'http', name);
  return {
    request: fs.readFileSync(`${base}.request.bin`),
    response: fs.readFileSync(`${base}.response.bin`),
    meta: JSON.parse(fs.readFileSync(`${base}.meta.json`, 'utf-8')) as HttpExchange['meta'],
  };
}

/** Тело ответа из tcp-потока сервера: без приветствия, заголовка кадра и терминатора. */
export function tcpResponseBody(server: Buffer): Buffer {
  const headerEnd = server.indexOf('\r\n\r\n', 5);
  const length = Number(/Content-Length: (\d+)/i.exec(server.subarray(5, headerEnd).toString('latin1'))?.[1]);
  return server.subarray(headerEnd + 4, headerEnd + 4 + length);
}

/** Тело запроса из tcp-потока клиента: без 20 байт приветствия, заголовка кадра и терминатора. */
export function tcpRequestBody(client: Buffer): Buffer {
  const headerEnd = client.indexOf('\r\n\r\n', 20);
  const length = Number(/Content-Length: (\d+)/i.exec(client.subarray(20, headerEnd).toString('latin1'))?.[1]);
  return client.subarray(headerEnd + 4, headerEnd + 4 + length);
}

/** Атрибут `version` конверта crs:call (для серверов, отвечающих по версии запроса). */
export function requestVersion(body: Buffer): string {
  return /<crs:call [^>]*version="([^"]*)"/.exec(body.toString('utf-8'))?.[1] ?? '';
}

/** Атрибут `password` конверта crs:call — хеш пароля, который отправил клиент. */
export function requestPasswordHash(body: Buffer): string {
  return /<crs:auth [^>]*password="([^"]*)"/.exec(body.toString('utf-8'))?.[1] ?? '';
}

export interface LoopbackServer {
  readonly port: number;
  /** Полные потоки клиента по соединениям (tcp) или тела запросов (http). */
  readonly requests: Buffer[];
  close(): Promise<void>;
}

/**
 * Замена crserver на loopback (внешняя система недоступна в тестовом окружении): сервер
 * отправляет приветствие из реального потока, читает клиентский поток до конца кадра
 * (приветствие 20 байт + заголовок + тело + терминатор) и отвечает байтами, снятыми с
 * настоящего crserver. `respond` получает весь поток клиента и номер соединения и
 * возвращает полный поток сервера (с приветствием — оно отбрасывается, т.к. уже отправлено).
 */
export async function startTcpReplayServer(
  greeting: Buffer,
  respond: (client: Buffer, index: number) => Buffer
): Promise<LoopbackServer> {
  const requests: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let received = Buffer.alloc(0);
    socket.write(greeting.subarray(0, 5));
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf('\r\n\r\n', 20);
      if (headerEnd < 0) {
        return;
      }
      const length = Number(/Content-Length: (\d+)/i.exec(received.subarray(20, headerEnd).toString('latin1'))?.[1]);
      if (received.length < headerEnd + 4 + length + 4) {
        return;
      }
      const index = requests.length;
      requests.push(received);
      socket.end(respond(received, index).subarray(5));
    });
  });
  return listenLoopback(server, requests, sockets);
}

export interface HttpReplayRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Замена веб-публикации хранилища на loopback: ответы — байты, снятые с настоящего wsap. */
export async function startHttpReplayServer(
  respond: (request: HttpReplayRequest, index: number) => { status: number; headers?: Record<string, string>; body: Buffer }
): Promise<LoopbackServer & { readonly received: HttpReplayRequest[] }> {
  const requests: Buffer[] = [];
  const received: HttpReplayRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const item: HttpReplayRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      const index = received.length;
      received.push(item);
      requests.push(item.body);
      const answer = respond(item, index);
      response.writeHead(answer.status, { 'Content-Type': 'application/xml', ...answer.headers });
      response.end(answer.body);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const base = await listenLoopback(server, requests, sockets);
  return { ...base, received };
}

export function listenLoopback(server: net.Server, requests: Buffer[], sockets: Set<net.Socket>): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        requests,
        close: () => new Promise<void>((done) => {
          sockets.forEach((socket) => socket.destroy());
          server.close(() => done());
        }),
      });
    });
  });
}

/** Порт на loopback, на котором гарантированно никто не слушает (сервер открыт и сразу закрыт). */
export async function findClosedPort(): Promise<number> {
  const server = net.createServer();
  const loopback = await listenLoopback(server, [], new Set());
  await loopback.close();
  return loopback.port;
}

/** Хранилище секретов на Map — структурный контракт vscode.SecretStorage. */
export function createMapSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

export interface LockWorkspace {
  readonly workspaceRoot: string;
  readonly configRoot: string;
  readonly service: RepositoryService;
  readonly target: RepositoryTarget;
  dispose(): void;
}

/**
 * Рабочая область с копией `example/2.21/src/cf` (её ConfigDumpInfo.xml согласован с OBJID
 * фикстуры хранилища) и, если задана, привязкой к хранилищу: пароль уходит в SecretStorage
 * тем же `saveBinding`, что и у команды «Подключить к хранилищу».
 */
export async function createLockWorkspace(binding?: RepositoryBinding): Promise<LockWorkspace> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-ws-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(path.dirname(configRoot), { recursive: true });
  fs.cpSync(EXAMPLE_CF_221, configRoot, { recursive: true });
  const service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createMapSecretStore(), workspaceRoot));
  const target = service.resolveTargetByConfigRoot(configRoot);
  if (!target) {
    throw new Error('копия example/2.21/src/cf не распознана как цель хранилища');
  }
  if (binding) {
    await service.saveBinding(target, binding);
  }
  return {
    workspaceRoot,
    configRoot,
    service,
    target,
    dispose: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

/**
 * Ожидаемые захваты сценария в алфавите state.json: имя записи ConfigDumpInfo.xml →
 * fullName хранилища (корень — сентинел) → пользователь.
 */
export function expectedScenarioLocks(target: RepositoryTarget): Map<string, string> {
  return new Map(readScenario().locks.map((lock): [string, string] => {
    const fullName = dumpInfoOwnerToRepositoryFullName(lock.dumpName, target);
    if (!fullName) {
      throw new Error(`не переводится имя записи ${lock.dumpName}`);
    }
    return [fullName, lock.user];
  }));
}

/** Значение обязано быть: иначе тест падает с понятной причиной (замена оператора `!`). */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`нет ожидаемого значения: ${what}`);
  }
  return value;
}

/** Время захвата лежит в окне прогона генератора фикстуры. */
export function inLockWindow(value: string | undefined, run: LockRun): boolean {
  return value !== undefined && value >= run.lockedFrom && value <= run.lockedTo;
}
