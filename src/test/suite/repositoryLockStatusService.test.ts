import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileRepositoryLockStatusSource } from '../../infra/repository/FileRepositoryLockStatusSource';
import type { RepositoryLockStatusSource } from '../../infra/repository/RepositoryLockStatusSource';
import { mapServerLocksToUnits, RepositoryLockStatusService } from '../../infra/repository/RepositoryLockStatusService';
import { DEFAULT_CRS_VERSION_HINT } from '../../infra/repository/RepositoryLockStatusService';
import {
  createLockWorkspace,
  expectedScenarioLocks,
  inLockWindow,
  lockFixturePath,
  readRun,
  readTcpExchange,
  requestPasswordHash,
  requestVersion,
  startTcpReplayServer,
  tcpRequestBody,
  type LoopbackServer,
  type LockWorkspace,
} from './support/repositoryLockFixtures';

/**
 * Опрос статусов захвата целиком: привязка цели → источник → ConfigDumpInfo.xml копии
 * example/2.21 → свои/чужие захваты в state.json. Файловое хранилище — реальный 1CD.
 */

const NOW = new Date(2026, 8, 27, 12, 0, 0);

/** Сервис с явным набором источников — для проверки выбора источника и гонки с захватом. */
function serviceWith(ws: LockWorkspace, sources: readonly RepositoryLockStatusSource[]): RepositoryLockStatusService {
  return new RepositoryLockStatusService({
    workspaceRoot: ws.workspaceRoot,
    lockState: ws.service.lockState,
    isConnected: (target) => ws.service.isConnected(target),
    resolveBinding: (target) => ws.service.resolveBindingForCommand(target),
    readPlatformVersionHint: () => undefined,
    now: () => NOW,
  }, sources);
}

/** Реальный файловый источник с записью вызовов (проверка «источник не вызывался» и гонки). */
function recordingFileSource(beforeReturn?: () => void): RepositoryLockStatusSource & { calls: number } {
  const inner: RepositoryLockStatusSource = new FileRepositoryLockStatusSource();
  const source = {
    calls: 0,
    supports: (location: Parameters<RepositoryLockStatusSource['supports']>[0]) => inner.supports(location),
    readLocks: async (...args: Parameters<RepositoryLockStatusSource['readLocks']>) => {
      source.calls += 1;
      const result = await inner.readLocks(...args);
      beforeReturn?.();
      return result;
    },
  };
  return source;
}

suite('RepositoryLockStatusService — файловое хранилище (issue #6)', () => {
  const workspaces: LockWorkspace[] = [];
  const repoPath = lockFixturePath('8.5.1');
  const run = readRun('8.5.1');

  teardown(() => {
    workspaces.splice(0).forEach((ws) => ws.dispose());
  });

  async function workspace(repoUser: string, customRepoPath = repoPath): Promise<LockWorkspace> {
    const ws = await createLockWorkspace({ repoPath: customRepoPath, repoUser, repoPassword: '' });
    workspaces.push(ws);
    return ws;
  }

  for (const repoUser of ['Admin', 'admin', ' Admin ']) {
    test(`пользователь «${repoUser}»: чужие — захваты Petrov с датами, свои вне проекта — захваты Admin`, async () => {
      const ws = await workspace(repoUser);
      const result = await ws.service.lockStatus.syncTarget(ws.target);
      const expected = expectedScenarioLocks(ws.target);
      const admin = [...expected].filter(([, user]) => user === 'Admin').map(([fullName]) => fullName).sort((a, b) => a.localeCompare(b, 'ru'));
      assert.ok(result.status === 'synced');
      assert.deepStrictEqual(
        { foreign: result.foreign, own: result.own, unmatched: result.unmatched, ownElsewhere: result.ownElsewhere, unconfirmed: result.unconfirmed },
        { foreign: expected.size - admin.length, own: admin.length, unmatched: 0, ownElsewhere: admin, unconfirmed: [] }
      );
      assert.strictEqual(result.changed.length, expected.size);
      for (const [fullName, user] of expected) {
        const info = ws.service.getLockInfo(ws.target, fullName);
        if (user === 'Petrov') {
          assert.ok(info.state === 'foreign', fullName);
          assert.strictEqual(info.user, 'Petrov');
          assert.ok(inLockWindow(info.lockedAt, run), String(info.lockedAt));
        } else {
          assert.ok(info.state === 'own-elsewhere', fullName);
          assert.strictEqual(info.user, repoUser.trim());
        }
      }
      assert.strictEqual(ws.service.getRootLockInfo(ws.target).state, 'foreign');
      assert.strictEqual(ws.service.isEditRestricted(path.join(ws.configRoot, 'Catalogs', 'Банки.xml')), true);
    });
  }

  test('пользователь Petrov — зеркально: свои вне проекта, чужие — Admin; локальный захват Банков подтверждён', async () => {
    const ws = await workspace('Petrov');
    ws.service.lockState.applyLock(ws.target, { anchor: 'Справочник.Банки', members: ['Справочник.Банки'] });
    const result = await ws.service.lockStatus.syncTarget(ws.target);
    assert.ok(result.status === 'synced');
    assert.ok(!result.ownElsewhere.includes('Справочник.Банки'));
    assert.strictEqual(ws.service.getLockInfo(ws.target, 'Справочник.Контрагенты').state, 'foreign');
    const banks = ws.service.getLockInfo(ws.target, 'Справочник.Банки');
    assert.ok(banks.state === 'own');
    assert.deepStrictEqual([banks.user, banks.confirmed], ['Petrov', true]);
    assert.ok(inLockWindow(banks.lockedAt, run));
    assert.strictEqual(ws.service.getRootLockInfo(ws.target).state, 'own-elsewhere');
    assert.strictEqual(ws.service.isEditRestricted(path.join(ws.configRoot, 'Catalogs', 'Банки.xml')), false);
  });

  test('нет привязки → not-connected, источник не вызывается', async () => {
    const ws = await createLockWorkspace();
    workspaces.push(ws);
    const source = recordingFileSource();
    assert.deepStrictEqual(await serviceWith(ws, [source]).syncTarget(ws.target), { status: 'not-connected' });
    assert.strictEqual(source.calls, 0);
  });

  test('нет 1CD в каталоге хранилища → failed с путём', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-no-1cd-'));
    const ws = await workspace('Admin', empty);
    const result = await ws.service.lockStatus.syncTarget(ws.target);
    assert.ok(result.status === 'failed');
    assert.strictEqual(result.code, 'not-found');
    assert.ok(result.reason.includes(path.join(empty, '1cv8ddb.1CD')));
  });

  test('нет ConfigDumpInfo.xml → failed/no-dump-info', async () => {
    const ws = await workspace('Admin');
    fs.rmSync(path.join(ws.configRoot, 'ConfigDumpInfo.xml'));
    const result = await ws.service.lockStatus.syncTarget(ws.target);
    assert.ok(result.status === 'failed');
    assert.strictEqual(result.code, 'no-dump-info');
  });

  test('ConfigDumpInfo.xml без Банков → захват Банков в unmatched', async () => {
    const ws = await workspace('Admin');
    const dumpInfo = path.join(ws.configRoot, 'ConfigDumpInfo.xml');
    fs.writeFileSync(dumpInfo, fs.readFileSync(dumpInfo, 'utf-8').replace(/<Metadata name="Catalog\.Банки" [^>]*>/, '<Metadata name="Catalog.Банки">'));
    const result = await ws.service.lockStatus.syncTarget(ws.target);
    assert.ok(result.status === 'synced');
    assert.ok(result.unmatched >= 1);
    assert.deepStrictEqual(ws.service.getLockInfo(ws.target, 'Справочник.Банки'), { state: 'free' });
  });

  test('захват во время опроса → stale, state.json не меняется', async () => {
    const ws = await workspace('Admin');
    const source = recordingFileSource(() => {
      ws.service.lockState.applyLock(ws.target, { anchor: 'Справочник.Номенклатура', members: ['Справочник.Номенклатура'] });
    });
    assert.deepStrictEqual(await serviceWith(ws, [source]).syncTarget(ws.target), { status: 'stale' });
    assert.deepStrictEqual(ws.service.getLockInfo(ws.target, 'Справочник.Банки'), { state: 'free' });
  });

  test('отметка отказа захвата исчезает после опроса', async () => {
    const ws = await workspace('Admin');
    ws.service.lockState.applyLockRefusals(ws.target, [{ fullName: 'Справочник.Номенклатура', user: 'Petrov' }], '2026-09-27T11:00:00');
    assert.strictEqual(ws.service.getLockInfo(ws.target, 'Справочник.Номенклатура').state, 'foreign');
    await ws.service.lockStatus.syncTarget(ws.target);
    assert.deepStrictEqual(ws.service.getLockInfo(ws.target, 'Справочник.Номенклатура'), { state: 'free' });
  });

  test('повреждённый env.json → failed/unknown, без исключения наружу', async () => {
    const ws = await workspace('Admin');
    fs.writeFileSync(ws.service.getEnvJsonPath(), '{ битый', 'utf-8');
    const result = await ws.service.lockStatus.syncTarget(ws.target);
    assert.ok(result.status === 'failed');
    assert.strictEqual(result.code, 'unknown');
    assert.match(result.reason, /env\.json повреждён/);
  });

  test('ни один источник не поддерживает адрес → failed', async () => {
    const ws = await workspace('Admin');
    const result = await serviceWith(ws, []).syncTarget(ws.target);
    assert.ok(result.status === 'failed');
    assert.match(result.reason, /Неизвестный вид адреса/);
  });
});

suite('mapServerLocksToUnits (issue #6)', () => {
  const target = { configRoot: '/x', configKind: 'cf' as const, displayName: 'Тест' };

  test('uuid без записи ConfigDumpInfo и нераспознанный вид — unmatched; сравнение пользователя без регистра и пробелов', () => {
    const ids = new Map([['a', 'Catalog.А'], ['b', 'НеизвестныйВид.Б'], ['c', 'Catalog.В']]);
    const result = mapServerLocksToUnits([
      { objectId: 'A', user: 'Petrov', lockedAt: '2026-09-27T10:00:00' },
      { objectId: 'b', user: 'Petrov' },
      { objectId: 'z', user: 'Petrov' },
      { objectId: 'c', user: ' ADMIN ' },
    ], ids, target, 'admin');
    assert.deepStrictEqual(result, {
      foreign: { 'Справочник.А': { user: 'Petrov', lockedAt: '2026-09-27T10:00:00' } },
      own: { 'Справочник.В': { lockedAt: undefined } },
      unmatched: 2,
    });
  });
});

/**
 * Сетевое хранилище: loopback-замена crserver (ответы сняты с настоящего сервера 8.5.1)
 * отвечает по версии и хешу пароля запроса — как настоящий сервер.
 */
suite('RepositoryLockStatusService — сетевое хранилище (issue #6)', () => {
  const run = readRun('8.5.1');
  const workspaces: LockWorkspace[] = [];
  const servers: LoopbackServer[] = [];
  const exchange = (name: Parameters<typeof readTcpExchange>[1]): Buffer => readTcpExchange('8.5.1', name).server;
  const petrovHash = requestPasswordHash(tcpRequestBody(readTcpExchange('8.5.1', 'statistic-petrov').client));
  const adminHash = requestPasswordHash(tcpRequestBody(readTcpExchange('8.5.1', 'statistic-admin').client));

  teardown(async () => {
    workspaces.splice(0).forEach((ws) => ws.dispose());
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function startServer(): Promise<LoopbackServer> {
    const server = await startTcpReplayServer(exchange('statistic-admin'), (client) => {
      const body = tcpRequestBody(client);
      if (requestVersion(body) !== run.platform) {
        return exchange('version-mismatch');
      }
      const hash = requestPasswordHash(body);
      return hash === adminHash ? exchange('statistic-admin') : hash === petrovHash ? exchange('statistic-petrov') : exchange('auth-failed');
    });
    servers.push(server);
    return server;
  }

  async function workspace(server: LoopbackServer, repoUser: string, repoPassword: string, env: Record<string, string> = {}): Promise<LockWorkspace> {
    const ws = await createLockWorkspace({ repoPath: `tcp://127.0.0.1:${String(server.port)}/${run.alias}`, repoUser, repoPassword });
    workspaces.push(ws);
    const envPath = ws.service.getEnvJsonPath();
    const raw = JSON.parse(fs.readFileSync(envPath, 'utf-8')) as { default: Record<string, unknown> };
    Object.assign(raw.default, env);
    fs.writeFileSync(envPath, JSON.stringify(raw), 'utf-8');
    return ws;
  }

  test('результат тот же, что у файлового источника; версия сервера сохраняется, следующий опрос — одна отправка', async () => {
    const server = await startServer();
    const ws = await workspace(server, 'Admin', '');
    const result = await ws.service.lockStatus.syncTarget(ws.target);
    assert.ok(result.status === 'synced');
    assert.deepStrictEqual(server.requests.map((client) => requestVersion(tcpRequestBody(client))), [DEFAULT_CRS_VERSION_HINT, run.platform]);
    for (const [fullName, user] of expectedScenarioLocks(ws.target)) {
      assert.strictEqual(ws.service.getLockInfo(ws.target, fullName).state, user === 'Admin' ? 'own-elsewhere' : 'foreign', fullName);
    }
    assert.strictEqual(ws.service.lockState.getServerVersion(ws.target), run.platform);
    await ws.service.lockStatus.syncTarget(ws.target);
    assert.strictEqual(server.requests.length, 3);
    assert.strictEqual(requestVersion(tcpRequestBody(server.requests[2])), run.platform);
  });

  test('пароль из SecretStorage даёт хеш в запросе (Petrov/123) — захваты зеркальны', async () => {
    const server = await startServer();
    const ws = await workspace(server, 'Petrov', '123', { '--v8version': run.platform });
    const result = await ws.service.lockStatus.syncTarget(ws.target);
    assert.ok(result.status === 'synced');
    assert.deepStrictEqual(server.requests.map((client) => requestPasswordHash(tcpRequestBody(client))), [petrovHash]);
    assert.strictEqual(ws.service.getLockInfo(ws.target, 'Справочник.Банки').state, 'own-elsewhere');
    assert.strictEqual(ws.service.getLockInfo(ws.target, 'Справочник.Контрагенты').state, 'foreign');
  });

  const hints: [string, Record<string, string>, string][] = [
    ['--v8version', { '--v8version': '8.3.25.1000', '--path': '/opt/1cv8/x86_64/8.3.24.1500/1cv8' }, '8.3.25.1000'],
    ['версия из --path', { '--v8version': '', '--path': '/opt/1cv8/x86_64/8.3.24.1500/1cv8' }, '8.3.24.1500'],
    ['константа', {}, DEFAULT_CRS_VERSION_HINT],
  ];
  for (const [title, env, expected] of hints) {
    test(`подсказка версии первого вызова: ${title}`, async () => {
      const server = await startServer();
      const ws = await workspace(server, 'Admin', '', env);
      await ws.service.lockStatus.syncTarget(ws.target);
      assert.strictEqual(requestVersion(tcpRequestBody(server.requests[0])), expected);
    });
  }

  test('неверный пароль → failed/auth-failed с подсказкой про «Подключить к хранилищу»', async () => {
    const server = await startServer();
    const ws = await workspace(server, 'Petrov', 'wrong', { '--v8version': run.platform });
    const result = await ws.service.lockStatus.syncTarget(ws.target);
    assert.ok(result.status === 'failed');
    assert.strictEqual(result.code, 'auth-failed');
    assert.match(result.reason, /Подключить к хранилищу/);
  });
});
