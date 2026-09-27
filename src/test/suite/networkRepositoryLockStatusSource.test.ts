import * as assert from 'assert';
import * as os from 'os';
import { FileRepositoryLockStatusSource } from '../../infra/repository/FileRepositoryLockStatusSource';
import { NetworkRepositoryLockStatusSource } from '../../infra/repository/NetworkRepositoryLockStatusSource';
import {
  classifyRepositoryLocation,
  RepositoryLockStatusError,
  type RepositoryLockStatusSource,
  type RepositoryServerLockRecord,
} from '../../infra/repository/RepositoryLockStatusSource';
import {
  lockFixturePath,
  NETWORK_FIXTURE_VERSIONS,
  readHttpExchange,
  readRun,
  readTcpExchange,
  requestVersion,
  startHttpReplayServer,
  startTcpReplayServer,
  tcpRequestBody,
  type LoopbackServer,
} from './support/repositoryLockFixtures';

/**
 * Сетевой источник на loopback-замене crserver (ответы — снятые байты). Главный оракул —
 * совпадение с файловым источником на ТОМ ЖЕ хранилище: 1CD фикстуры скопирован из
 * каталога данных того crserver, с которого сняты обмены.
 */

function sortRecords(records: readonly RepositoryServerLockRecord[]): RepositoryServerLockRecord[] {
  return [...records].sort((left, right) => left.objectId.localeCompare(right.objectId));
}

for (const version of NETWORK_FIXTURE_VERSIONS) {
  suite(`NetworkRepositoryLockStatusSource — crserver ${version}`, () => {
    const run = readRun(version);
    const servers: LoopbackServer[] = [];
    const source: RepositoryLockStatusSource = new NetworkRepositoryLockStatusSource({ timeoutMs: 10_000 });
    const context = (platformVersionHint: string): Parameters<RepositoryLockStatusSource['readLocks']>[1] =>
      ({ user: 'Admin', password: '', platformVersionHint });

    teardown(async () => {
      await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    async function fileRecords(): Promise<RepositoryServerLockRecord[]> {
      const file: RepositoryLockStatusSource = new FileRepositoryLockStatusSource();
      return sortRecords((await file.readLocks(classifyRepositoryLocation(lockFixturePath(version), os.tmpdir()), context(''))).records);
    }

    /** Сервер отвечает по версии запроса: верная — статистика, иная — несоответствие версий. */
    async function startServer(transport: 'tcp' | 'http'): Promise<{ server: LoopbackServer; repoPath: string }> {
      if (transport === 'tcp') {
        const ok = readTcpExchange(version, 'statistic-admin').server;
        const mismatch = readTcpExchange(version, 'version-mismatch').server;
        const server = await startTcpReplayServer(ok, (client) => (requestVersion(tcpRequestBody(client)) === run.platform ? ok : mismatch));
        servers.push(server);
        return { server, repoPath: `tcp://127.0.0.1:${String(server.port)}/${run.alias}` };
      }
      const ok = readHttpExchange(version, 'statistic-admin').response;
      const mismatch = readHttpExchange(version, 'version-mismatch').response;
      const server = await startHttpReplayServer((request) => ({ status: 200, body: requestVersion(request.body) === run.platform ? ok : mismatch }));
      servers.push(server);
      return { server, repoPath: `http://127.0.0.1:${String(server.port)}/repo/repo.1ccr/${run.alias}` };
    }

    for (const transport of ['tcp', 'http'] as const) {
      test(`${transport}: записи равны файловому источнику на том же хранилище, версия сервера возвращается`, async () => {
        const { server, repoPath } = await startServer(transport);
        const location = classifyRepositoryLocation(repoPath, os.tmpdir());
        assert.strictEqual(source.supports(location), true);
        const result = await source.readLocks(location, context(run.platform));
        assert.deepStrictEqual(sortRecords(result.records), await fileRecords());
        assert.strictEqual(result.serverVersion, run.platform);
        assert.strictEqual(server.requests.length, 1);
      });

      test(`${transport}: подсказка чужой версии → повтор с версией сервера`, async () => {
        const { server, repoPath } = await startServer(transport);
        const result = await source.readLocks(classifyRepositoryLocation(repoPath, os.tmpdir()), context('8.3.0.0'));
        assert.strictEqual(result.serverVersion, run.platform);
        assert.strictEqual(server.requests.length, 2);
      });
    }
  });
}

suite('NetworkRepositoryLockStatusSource — адреса', () => {
  const source: RepositoryLockStatusSource = new NetworkRepositoryLockStatusSource();
  const context = { user: 'Admin', password: '', platformVersionHint: '8.3.27.0' };

  test('файловое хранилище не поддерживается, а переданное напрямую — ошибка адреса', async () => {
    const location = classifyRepositoryLocation(lockFixturePath('8.5.1'), os.tmpdir());
    assert.strictEqual(source.supports(location), false);
    await assert.rejects(source.readLocks(location, context), (error: unknown) => error instanceof RepositoryLockStatusError && error.code === 'invalid-address');
  });

  test('tcp без имени хранилища → invalid-address', async () => {
    await assert.rejects(source.readLocks(classifyRepositoryLocation('tcp://127.0.0.1:1', os.tmpdir()), context),
      (error: unknown) => error instanceof RepositoryLockStatusError && error.code === 'invalid-address');
  });
});
