import * as assert from 'assert';
import { OneCdFile } from '../../infra/repository/onecd/OneCdFile';
import { readOneCdTable } from '../../infra/repository/onecd/OneCdTable';
import { parseCrsAddress } from '../../infra/repository/crs/CrsAddress';
import { callCrs, decodeCrsException, hashCrsPassword } from '../../infra/repository/crs/CrsClient';
import { RepositoryLockStatusError } from '../../infra/repository/RepositoryLockStatusSource';
import { CRS_OBJECTS_STATISTIC_PARAMS, parseCrsResponse } from '../../infra/xml/CrsMessageXml';
import {
  NETWORK_FIXTURE_VERSIONS,
  lockFixturePath,
  must,
  readHttpExchange,
  readRun,
  requestPasswordHash,
  type CrsExchangeName,
} from './support/repositoryLockFixtures';

/** Клиент crs: хеш пароля, исключения сервера и рукопожатие по версии на реальных ответах. */

function payloadOf(version: (typeof NETWORK_FIXTURE_VERSIONS)[number], exchange: CrsExchangeName): { clsid: string; payload: string } {
  const response = parseCrsResponse(readHttpExchange(version, exchange).response);
  assert.ok(response.kind === 'exception');
  return response;
}

async function expectStatusError(promise: Promise<unknown>, code: RepositoryLockStatusError['code'], pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RepositoryLockStatusError, String(error));
    assert.strictEqual(error.code, code);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    return true;
  });
}

for (const version of NETWORK_FIXTURE_VERSIONS) {
  suite(`CrsClient — сервер ${version}`, () => {
    const run = readRun(version);
    const address = (): ReturnType<typeof parseCrsAddress> => parseCrsAddress(`tcp://127.0.0.1:1/${run.alias}`);

    /** Отправитель, отдающий снятые ответы по очереди и запоминающий тела запросов. */
    function replay(...exchanges: CrsExchangeName[]): { send: (a: unknown, body: Buffer) => Promise<Buffer>; bodies: Buffer[] } {
      const bodies: Buffer[] = [];
      return {
        bodies,
        send: (_a, body) => {
          bodies.push(body);
          return Promise.resolve(readHttpExchange(version, must(exchanges[bodies.length - 1], 'ответ для вызова')).response);
        },
      };
    }

    const request = (versionHint: string, user = 'Admin', password = ''): Parameters<typeof callCrs>[1] =>
      ({ method: 'DevDepot_devObjectsStatistic', paramsXml: CRS_OBJECTS_STATISTIC_PARAMS, user, password, versionHint });

    test('хеш пароля: пустой — md5 пустой строки; «123» — как USERS.PASSWORD Petrov в 1CD и в принятом сервером запросе', async () => {
      assert.strictEqual(hashCrsPassword(''), 'd41d8cd98f00b204e9800998ecf8427e');
      const file = await OneCdFile.open(lockFixturePath(version, '1cv8ddb.1CD'));
      try {
        const petrov = must((await readOneCdTable(file, 'USERS')).find((row) => row.NAME === 'Petrov'), 'Petrov');
        assert.strictEqual(hashCrsPassword('123'), petrov.PASSWORD);
      } finally {
        await file.close();
      }
      assert.strictEqual(hashCrsPassword('123'), requestPasswordHash(readHttpExchange(version, 'statistic-petrov').request));
    });

    test('исключения сервера: текст, код и версия сервера из вложенной структуры', () => {
      const auth = payloadOf(version, 'auth-failed');
      const decodedAuth = decodeCrsException(auth.clsid, auth.payload);
      assert.match(decodedAuth.message, /^Ошибка аутентификации в хранилище конфигурации!/);
      assert.deepStrictEqual([decodedAuth.code, decodedAuth.serverVersion, decodedAuth.clsid], ['4', undefined, auth.clsid]);
      const alias = payloadOf(version, 'alias-not-found');
      const decodedAlias = decodeCrsException(alias.clsid, alias.payload);
      assert.match(decodedAlias.message, /не обнаружено/);
      assert.deepStrictEqual([decodedAlias.code, decodedAlias.serverVersion], ['1', undefined]);
      const mismatch = payloadOf(version, 'version-mismatch');
      const decodedMismatch = decodeCrsException(mismatch.clsid, mismatch.payload);
      assert.match(decodedMismatch.message, /^Несоответствие версий/);
      assert.deepStrictEqual([decodedMismatch.code, decodedMismatch.serverVersion], ['17', run.platform]);
    });

    test('рукопожатие: несоответствие версий → ровно один повтор с версией сервера; тела совпадают с принятыми сервером', async () => {
      const { send, bodies } = replay('version-mismatch', 'statistic-admin');
      const result = await callCrs(address(), request('8.3.0.0'), send);
      assert.strictEqual(result.serverVersion, run.platform);
      assert.ok(result.response.statistics.length > 0);
      assert.deepStrictEqual(bodies, [readHttpExchange(version, 'version-mismatch').request, readHttpExchange(version, 'statistic-admin').request]);
    });

    test('верная версия с первого раза — один вызов', async () => {
      const { send, bodies } = replay('statistic-admin');
      assert.strictEqual((await callCrs(address(), request(run.platform), send)).serverVersion, run.platform);
      assert.strictEqual(bodies.length, 1);
    });

    test('два несоответствия подряд → version-mismatch, всего два вызова', async () => {
      const { send, bodies } = replay('version-mismatch', 'version-mismatch');
      await expectStatusError(callCrs(address(), request('8.3.0.0'), send), 'version-mismatch', /Несоответствие версий/);
      assert.strictEqual(bodies.length, 2);
    });

    test('ошибка аутентификации → auth-failed с текстом сервера и подсказкой про пароль', async () => {
      const { send } = replay('auth-failed');
      await expectStatusError(callCrs(address(), request(run.platform, 'Petrov', 'wrong'), send), 'auth-failed', /аутентификации[\s\S]*Подключить к хранилищу/);
    });

    test('хранилище не обнаружено → server-error с текстом сервера', async () => {
      const { send } = replay('alias-not-found');
      await expectStatusError(callCrs(address(), request(run.platform), send), 'server-error', /не обнаружено/);
    });
  });
}

suite('CrsClient — искажённая нагрузка исключения', () => {
  test('не скобочный формат → protocol', () => {
    assert.throws(() => decodeCrsException('x', Buffer.from('{"незакрыто').toString('base64')),
      (error: unknown) => error instanceof RepositoryLockStatusError && error.code === 'protocol');
  });

  test('структура без текста → общий текст, без кода и версии', () => {
    const decoded = decodeCrsException('x', Buffer.from('{}').toString('base64'));
    assert.deepStrictEqual([decoded.code, decoded.serverVersion], [undefined, undefined]);
    assert.match(decoded.message, /x/);
  });
});
