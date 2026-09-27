import * as assert from 'assert';
import { OneCdFile, OneCdFormatError } from '../../infra/repository/onecd/OneCdFile';
import {
  computeRecordSize,
  decodeBcdDateTime,
  decodeRecords,
  formatGuidBytesLe,
  parseTableDescription,
  readOneCdTable,
  type OneCdRecord,
  type OneCdTableDescription,
} from '../../infra/repository/onecd/OneCdTable';
import { readRootUuid } from './support/realConfigFixtures';
import { EXAMPLE_CF_221, LOCK_FIXTURE_VERSIONS, lockFixturePath, must, readRun, readScenario } from './support/repositoryLockFixtures';
import * as path from 'path';

/** Описания таблиц и записи реальных файлов хранилища обеих платформ. */

async function withFile<T>(version: (typeof LOCK_FIXTURE_VERSIONS)[number], act: (file: OneCdFile) => Promise<T>): Promise<T> {
  const file = await OneCdFile.open(lockFixturePath(version, '1cv8ddb.1CD'));
  try {
    return await act(file);
  } finally {
    await file.close();
  }
}

async function readDescriptions(version: (typeof LOCK_FIXTURE_VERSIONS)[number]): Promise<Map<string, { text: string; description: OneCdTableDescription }>> {
  const texts = await withFile(version, (file) => file.readTableDescriptions());
  return new Map(texts.map((text) => {
    const description = parseTableDescription(text);
    return [description.name, { text, description }];
  }));
}

function assertCorrupted(act: () => unknown): void {
  assert.throws(act, (error: unknown) => error instanceof OneCdFormatError && error.code === 'corrupted');
}

for (const version of LOCK_FIXTURE_VERSIONS) {
  suite(`OneCdTable — таблицы хранилища платформы ${version}`, () => {
    const run = readRun(version);
    const scenario = readScenario();

    test('описание OBJECTS: поля захвата допускают NULL, блокировки записей нет', async () => {
      const { description } = must((await readDescriptions(version)).get('OBJECTS'), 'OBJECTS');
      assert.deepStrictEqual(
        description.fields.map((field) => [field.name, field.type, field.nullable]),
        [
          ['OBJID', 'B', false], ['CLASSID', 'B', false], ['SELFVERNUM', 'N', false],
          ['REVISED', 'L', true], ['REVISORID', 'B', true], ['REVISEDATE', 'DT', true],
        ]
      );
      assert.strictEqual(description.recordLock, false);
      assert.ok(description.dataPage > 0);
    });

    test('описание USERS: имя NVC(256), файлы данных/blob/индексов', async () => {
      const { description } = must((await readDescriptions(version)).get('USERS'), 'USERS');
      const name = description.fields.find((field) => field.name === 'NAME');
      assert.deepStrictEqual(name, { name: 'NAME', type: 'NVC', nullable: false, length: 256, precision: 0 });
      assert.strictEqual(description.recordLock, false);
      assert.ok(description.blobPage > 0 && description.indexPage > 0);
    });

    test('данные каждой таблицы делятся на записи без остатка', async () => {
      const descriptions = await readDescriptions(version);
      await withFile(version, async (file) => {
        for (const { description } of descriptions.values()) {
          const data = await file.readObject(description.dataPage);
          assert.strictEqual(data.length % computeRecordSize(description.fields), 0, description.name);
        }
      });
    });

    test('USERS.NAME — пользователи сценария; PASSWORD — хеш пароля (NC)', async () => {
      const users = await withFile(version, (file) => readOneCdTable(file, 'USERS'));
      assert.deepStrictEqual(users.map((row) => row.NAME).sort(), scenario.users.map((user) => user.name).sort());
      const admin = must(users.find((row) => row.NAME === 'Admin'), 'Admin');
      assert.strictEqual(admin.PASSWORD, 'd41d8cd98f00b204e9800998ecf8427e');
      assert.ok(Buffer.isBuffer(admin.USERID));
      assert.deepStrictEqual(Object.keys(admin.BINDSTRING as object).sort(), ['blobIndex', 'blobLength']);
    });

    test('OBJECTS: корень конфигурации есть; захваченные — с датой в окне прогона, свободные — NULL', async () => {
      const objects = await withFile(version, (file) => readOneCdTable(file, 'OBJECTS'));
      const rootUuid = readRootUuid(path.join(EXAMPLE_CF_221, 'Configuration.xml'));
      assert.ok(objects.some((row) => formatGuidBytesLe(row.OBJID as Buffer) === rootUuid));
      const revised = objects.filter((row) => row.REVISED === true);
      assert.strictEqual(revised.length, scenario.locks.length);
      for (const row of revised) {
        const date = row.REVISEDATE as string;
        assert.ok(date >= run.lockedFrom && date <= run.lockedTo, `${date} вне ${run.lockedFrom}…${run.lockedTo}`);
      }
      const free = objects.filter((row) => row.REVISED !== true);
      assert.ok(free.length > 0);
      assert.ok(free.every((row) => row.REVISED === null && row.REVISEDATE === null && row.REVISORID === null));
      assert.ok(objects.every((row) => typeof row.SELFVERNUM === 'number' && row.SELFVERNUM > 0));
    });

    test('таблица с полем I (EXTERNALS) и DT/N (DEPOT) декодируется', async () => {
      const [externals, depot] = await withFile(version, async (file) => [
        await readOneCdTable(file, 'EXTERNALS'),
        await readOneCdTable(file, 'DEPOT'),
      ]);
      assert.ok(externals.length > 0);
      assert.deepStrictEqual(Object.keys(externals[0].EXTDATA as object).sort(), ['blobIndex', 'blobLength']);
      assert.strictEqual(depot.length, 1);
      assert.match(depot[0].CREATEDATE as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    });
  });
}

suite('OneCdTable — разбор и граничные случаи', () => {
  test('GUID в порядке bytes_le', () => {
    assert.strictEqual(
      formatGuidBytesLe(Buffer.from('a6be4acfb237d411940f008048da11f9', 'hex')),
      'cf4abea6-37b2-11d4-940f-008048da11f9'
    );
  });

  test('BCD-дата: нулевая и не десятичная → undefined', () => {
    assert.strictEqual(decodeBcdDateTime(Buffer.from('20260927104227', 'hex')), '2026-09-27T10:42:27');
    assert.strictEqual(decodeBcdDateTime(Buffer.alloc(7)), undefined);
    assert.strictEqual(decodeBcdDateTime(Buffer.from('2026ff27104227', 'hex')), undefined);
  });

  test('удалённая запись (флаг ≠ 0) пропускается', async () => {
    const descriptions = await readDescriptions('8.5.1');
    const { description } = must(descriptions.get('OBJECTS'), 'OBJECTS');
    const data = Buffer.from(await withFile('8.5.1', (file) => file.readObject(description.dataPage)));
    const before: OneCdRecord[] = decodeRecords(description, data);
    data[computeRecordSize(description.fields)] = 1;
    assert.strictEqual(decodeRecords(description, data).length, before.length - 1);
  });

  test('нулевая дата в поле DT → null', async () => {
    const { description } = must((await readDescriptions('8.5.1')).get('DEPOT'), 'DEPOT');
    const data = Buffer.from(await withFile('8.5.1', (file) => file.readObject(description.dataPage)));
    const recordSize = computeRecordSize(description.fields);
    // DEPOTID(16) и ROOTOBJID(16) идут перед CREATEDATE; поля без NULL — байтов-признаков нет.
    data.fill(0, recordSize + 1 + 32, recordSize + 1 + 32 + 7);
    assert.strictEqual(decodeRecords(description, data)[0].CREATEDATE, null);
  });

  test('данные не кратны размеру записи → corrupted', async () => {
    const { description } = must((await readDescriptions('8.5.1')).get('USERS'), 'USERS');
    assertCorrupted(() => decodeRecords(description, Buffer.alloc(computeRecordSize(description.fields) + 1)));
  });

  test('минимальный размер записи — 5 байт', () => {
    assert.strictEqual(computeRecordSize([{ name: 'F', type: 'L', nullable: false, length: 0, precision: 0 }]), 5);
  });

  test('нет запрошенной таблицы → corrupted', async () => {
    await assert.rejects(
      withFile('8.5.1', (file) => readOneCdTable(file, 'NOPE')),
      (error: unknown) => error instanceof OneCdFormatError && error.code === 'corrupted'
    );
  });

  suite('испорченное описание таблицы → corrupted', () => {
    let usersText = '';
    suiteSetup(async () => {
      usersText = must((await readDescriptions('8.5.1')).get('USERS'), 'USERS').text;
    });
    const cases: [string, (text: string) => string][] = [
      ['скобки не сбалансированы', (text) => text.slice(0, -1)],
      ['корень — не список с именем', () => '{{1}}'],
      ['нет раздела Files', (text) => text.replace(/\{"Files",[^}]*\}/, '')],
      ['нет раздела Fields', (text) => text.replace('"Fields"', '"Fieldz"')],
      ['номер страницы — не число', (text) => text.replace(/\{"Files",\d+/, '{"Files","x"')],
      ['поле короче пяти элементов', (text) => text.replace('{"NAME","NVC",0,256,0,"CI"}', '{"NAME","NVC"}')],
      ['поле — не список', (text) => text.replace('{"NAME","NVC",0,256,0,"CI"}', '"NAME"')],
    ];
    for (const [title, mutate] of cases) {
      test(title, () => {
        assertCorrupted(() => parseTableDescription(mutate(usersText)));
      });
    }
  });
});
