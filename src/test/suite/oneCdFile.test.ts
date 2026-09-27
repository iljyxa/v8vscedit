import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OneCdFile, OneCdFormatError, readBlobChain } from '../../infra/repository/onecd/OneCdFile';
import { EXAMPLE_CF_221, LOCK_FIXTURE_VERSIONS, lockFixturePath, readRun } from './support/repositoryLockFixtures';

/**
 * Постраничное чтение файла хранилища 1CD (формат 8.3.8) на реальных файлах платформ
 * 8.5.1 и 8.3.27. Повреждения моделируются правкой байтов копии настоящего файла:
 * так проверяется реакция на запись платформы во время чтения и на чужой файл.
 */

async function expectFormatError(promise: Promise<unknown>, code: OneCdFormatError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OneCdFormatError, `ожидалась OneCdFormatError, получено ${String(error)}`);
    assert.strictEqual(error.code, code);
    return true;
  });
}

function tempCopy(version: (typeof LOCK_FIXTURE_VERSIONS)[number], patch?: (data: Buffer) => Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-onecd-'));
  const target = path.join(dir, '1cv8ddb.1CD');
  const data = fs.readFileSync(lockFixturePath(version, '1cv8ddb.1CD'));
  fs.writeFileSync(target, patch ? patch(Buffer.from(data)) : data);
  return target;
}

for (const version of LOCK_FIXTURE_VERSIONS) {
  suite(`OneCdFile — файл хранилища платформы ${version}`, () => {
    const databaseFile = lockFixturePath(version, '1cv8ddb.1CD');
    const run = readRun(version);

    test('заголовок: версия формата 8.3.8.0, размер страницы из прогона генератора, число страниц покрывает файл', async () => {
      const file = await OneCdFile.open(databaseFile);
      try {
        assert.strictEqual(file.version, '8.3.8.0');
        assert.strictEqual(file.pageSize, run.pageSize);
        assert.strictEqual(file.pageCount * file.pageSize, fs.statSync(databaseFile).size);
      } finally {
        await file.close();
      }
    });

    test('описания таблиц из корневого объекта содержат USERS, OBJECTS, HISTORY, VERSIONS', async () => {
      const file = await OneCdFile.open(databaseFile);
      try {
        const names = (await file.readTableDescriptions()).map((text) => /^\{"(\w+)"/.exec(text)?.[1]);
        for (const name of ['USERS', 'OBJECTS', 'HISTORY', 'VERSIONS']) {
          assert.ok(names.includes(name), `нет таблицы ${name} среди ${names.join(', ')}`);
        }
      } finally {
        await file.close();
      }
    });

    test('корневой объект (стр. 2): fatlevel 0, данные ровно заявленной длины', async () => {
      const file = await OneCdFile.open(databaseFile);
      try {
        const info = await file.describeObject(2);
        assert.deepStrictEqual({ page: info.page, fatLevel: info.fatLevel }, { page: 2, fatLevel: 0 });
        assert.ok(info.length > 0);
        assert.strictEqual((await file.readObject(2)).length, info.length);
      } finally {
        await file.close();
      }
    });
  });
}

suite('OneCdFile — ошибки чтения', () => {
  const version = '8.5.1';

  test('нет файла → ошибка файловой системы ENOENT (классифицирует источник)', async () => {
    await assert.rejects(OneCdFile.open(path.join(os.tmpdir(), 'нет-такого-каталога', '1cv8ddb.1CD')), { code: 'ENOENT' });
  });

  test('чужой файл (Configuration.xml) → not-1cd', async () => {
    await expectFormatError(OneCdFile.open(path.join(EXAMPLE_CF_221, 'Configuration.xml')), 'not-1cd');
  });

  test('файл короче заголовка → not-1cd', async () => {
    const target = tempCopy(version, (data) => data.subarray(0, 10));
    await expectFormatError(OneCdFile.open(target), 'not-1cd');
  });

  test('усечённая копия (2 страницы) → corrupted: файл короче, чем заявлено в заголовке', async () => {
    const pageSize = readRun(version).pageSize;
    const target = tempCopy(version, (data) => data.subarray(0, 2 * pageSize));
    await expectFormatError(OneCdFile.open(target), 'corrupted');
  });

  test('размер страницы не степень двойки → corrupted', async () => {
    const target = tempCopy(version, (data) => {
      data.writeUInt32LE(5000, 20);
      return data;
    });
    await expectFormatError(OneCdFile.open(target), 'corrupted');
  });

  test('файл усечён платформой после открытия → corrupted при чтении страницы', async () => {
    const target = tempCopy(version);
    const file = await OneCdFile.open(target);
    try {
      fs.truncateSync(target, file.pageSize * 2);
      await expectFormatError(file.readObject(2), 'corrupted');
    } finally {
      await file.close();
    }
  });

  suite('заголовок объекта', () => {
    const pageSize = readRun(version).pageSize;
    const rootHeader = 2 * pageSize;
    const cases: [string, (data: Buffer) => void, (file: OneCdFile) => Promise<unknown>][] = [
      ['страница без сигнатуры объекта', () => undefined, (file) => file.describeObject(0)],
      ['страница за пределами файла', () => undefined, (file) => file.describeObject(file.pageCount + 5)],
      ['неизвестный fatlevel', (data) => data.writeUInt16LE(7, rootHeader + 2), (file) => file.describeObject(2)],
      ['длина больше безопасного целого', (data) => data.writeBigUInt64LE(2n ** 60n, rootHeader + 16), (file) => file.describeObject(2)],
      ['длина больше перечисленных страниц', (data) => data.writeBigUInt64LE(BigInt(pageSize * 50), rootHeader + 16), (file) => file.readObject(2)],
      ['номер страницы данных за пределами файла', (data) => data.writeUInt32LE(9999, rootHeader + 24), (file) => file.readObject(2)],
    ];
    for (const [title, patch, act] of cases) {
      test(`${title} → corrupted`, async () => {
        const target = tempCopy(version, (data) => {
          patch(data);
          return data;
        });
        const file = await OneCdFile.open(target);
        try {
          await expectFormatError(act(file), 'corrupted');
        } finally {
          await file.close();
        }
      });
    }
  });

  suite('blob-цепочка корневого объекта', () => {
    async function readRoot(): Promise<Buffer> {
      const file = await OneCdFile.open(lockFixturePath(version, '1cv8ddb.1CD'));
      try {
        return await file.readObject(2);
      } finally {
        await file.close();
      }
    }

    test('блок 1 — язык и перечень описаний таблиц', async () => {
      const head = readBlobChain(await readRoot(), 1);
      assert.strictEqual(head.subarray(0, 5).toString('latin1'), 'ru_RU');
    });

    test('блок за пределами данных → corrupted', async () => {
      const root = await readRoot();
      assert.throws(() => readBlobChain(root, root.length), (error: unknown) => error instanceof OneCdFormatError && error.code === 'corrupted');
    });

    test('длина фрагмента больше 250 байт → corrupted', async () => {
      const root = await readRoot();
      root.writeUInt16LE(251, 256 + 4);
      assert.throws(() => readBlobChain(root, 1), (error: unknown) => error instanceof OneCdFormatError && error.code === 'corrupted');
    });

    test('цикл в цепочке блоков → corrupted', async () => {
      const root = await readRoot();
      root.writeUInt32LE(1, 256);
      assert.throws(() => readBlobChain(root, 1), (error: unknown) => error instanceof OneCdFormatError && error.code === 'corrupted');
    });
  });
});
