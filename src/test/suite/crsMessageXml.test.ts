import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { RepositoryLockStatusError } from '../../infra/repository/RepositoryLockStatusSource';
import { buildCrsCallBody, CRS_OBJECTS_STATISTIC_PARAMS, parseCrsResponse } from '../../infra/xml/CrsMessageXml';
import {
  NETWORK_FIXTURE_VERSIONS,
  lockFixturePath,
  readHttpExchange,
  readRun,
  readScenario,
  readTcpExchange,
  tcpRequestBody,
} from './support/repositoryLockFixtures';

/**
 * Конверт вызова crs и разбор ответа на байтах, снятых с настоящего crserver: запрос
 * фикстуры принят сервером, а конверт devObjectsStatistic совпадает с запросом самого
 * Конфигуратора (без `<crs:bind>`, `removed=false`).
 */

/** md5 от UTF-16LE — независимое от продукта вычисление хеша для сверки конверта. */
function md5Utf16(password: string): string {
  return crypto.createHash('md5').update(Buffer.from(password, 'utf16le')).digest('hex');
}

function expectProtocol(act: () => unknown): void {
  assert.throws(act, (error: unknown) => error instanceof RepositoryLockStatusError && error.code === 'protocol');
}

for (const version of NETWORK_FIXTURE_VERSIONS) {
  suite(`CrsMessageXml — обмены с crserver ${version}`, () => {
    const run = readRun(version);
    const scenario = readScenario();

    for (const [exchange, user, password] of [['statistic-admin', 'Admin', ''], ['statistic-petrov', 'Petrov', '123']] as const) {
      test(`${exchange}: тело совпадает байт-в-байт с принятым сервером (tcp и http)`, () => {
        const body = buildCrsCallBody({
          alias: run.alias, method: 'DevDepot_devObjectsStatistic', version: run.platform,
          user, passwordHash: md5Utf16(password), paramsXml: CRS_OBJECTS_STATISTIC_PARAMS,
        });
        assert.deepStrictEqual(body, tcpRequestBody(readTcpExchange(version, exchange).client));
        assert.deepStrictEqual(body, readHttpExchange(version, exchange).request);
      });
    }

    test('конверт совпадает с запросом Конфигуратора после удаления crs:bind и removed=false', () => {
      const designer = fs.readFileSync(lockFixturePath(version, 'designer-devObjectsStatistic.request.bin'), 'utf-8')
        .replace(/<crs:bind [^>]*\/>/, '')
        .replace('<crs:removed value="true"/>', '<crs:removed value="false"/>');
      const body = buildCrsCallBody({
        alias: run.alias, method: 'DevDepot_devObjectsStatistic', version: run.platform,
        user: 'Admin', passwordHash: md5Utf16(''), paramsXml: CRS_OBJECTS_STATISTIC_PARAMS,
      });
      assert.strictEqual(body.toString('utf-8'), designer);
    });

    test('call_return: захваченные объекты и имена пользователей сценария; у свободных нулевой revisorID отброшен', () => {
      const response = parseCrsResponse(readHttpExchange(version, 'statistic-admin').response);
      assert.ok(response.kind === 'return');
      const revised = response.value.statistics.filter((item) => item.revised);
      assert.strictEqual(revised.length, scenario.locks.length);
      assert.deepStrictEqual(
        [...new Set(revised.map((item) => response.value.users.get(item.revisorId ?? '')))].sort(),
        ['Admin', 'Petrov']
      );
      const free = response.value.statistics.filter((item) => !item.revised);
      assert.ok(free.length > 0 && free.every((item) => item.revisorId === undefined));
      assert.ok(response.value.statistics.every((item) => /^[0-9a-f-]{36}$/.test(item.objectId) && item.reviseDate !== undefined));
    });

    for (const exchange of ['version-mismatch', 'auth-failed', 'alias-not-found'] as const) {
      test(`call_exception ${exchange}: clsid и base64-нагрузка`, () => {
        const response = parseCrsResponse(readHttpExchange(version, exchange).response);
        assert.ok(response.kind === 'exception');
        assert.strictEqual(response.clsid, '3ccb2518-9616-4445-aaa7-20048fead174');
        assert.ok(Buffer.from(response.payload, 'base64').toString('utf-8').startsWith('\uFEFF{'));
      });
    }
  });
}

suite('CrsMessageXml — экранирование и искажённые ответы', () => {
  test('атрибуты конверта экранируются', () => {
    const body = buildCrsCallBody({
      alias: 'a<b', method: 'M', version: '8.5.1.1529', user: 'Иван "Бух" & Ко', passwordHash: 'h', paramsXml: '<crs:params/>',
    }).toString('utf-8');
    assert.ok(body.includes('alias="a&lt;b"'));
    assert.ok(body.includes('user="Иван &quot;Бух&quot; &amp; Ко"'));
  });

  // Ниже — не данные платформы, а искажённые ответы (веб-сервер вместо публикации,
  // обрыв ответа, пустое хранилище): проверяется, что разбор не выдаёт мусор.
  test('HTML-страница вместо crs → protocol', () => {
    expectProtocol(() => parseCrsResponse(Buffer.from('<html><body><h1>502 Bad Gateway</h1></body></html>')));
  });

  test('оборванный ответ (не XML) → protocol', () => {
    expectProtocol(() => parseCrsResponse(readHttpExchange('8.5.1', 'statistic-admin').response.subarray(0, 4)));
  });

  test('исключение без нагрузки → protocol', () => {
    expectProtocol(() => parseCrsResponse(Buffer.from('<crs:call_exception xmlns:crs="http://v8.1c.ru/8.2/crs" clsid="x"></crs:call_exception>')));
  });

  test('ответ без статистики и пользователей (пустые элементы, запись без атрибутов) → пустые наборы', () => {
    const response = parseCrsResponse(Buffer.from('<crs:call_return xmlns:crs="http://v8.1c.ru/8.2/crs"><crs:statMap><crs:value>'
      + '<crs:first value="a"/><crs:second/></crs:value><crs:value><crs:second/></crs:value></crs:statMap><crs:users/></crs:call_return>'));
    assert.deepStrictEqual(response, {
      kind: 'return',
      value: { statistics: [{ objectId: 'a', revised: false, revisorId: undefined, reviseDate: undefined }], users: new Map() },
    });
  });
});
