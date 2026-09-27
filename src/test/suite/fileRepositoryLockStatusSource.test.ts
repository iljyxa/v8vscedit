import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyFileAccessError, FileRepositoryLockStatusSource } from '../../infra/repository/FileRepositoryLockStatusSource';
import { classifyRepositoryLocation, RepositoryLockStatusError, type RepositoryLockStatusSource, type RepositoryServerLockRecord } from '../../infra/repository/RepositoryLockStatusSource';
import { parseConfigDumpInfoUnitIds } from '../../infra/xml/ConfigDumpInfoReader';
import { EXAMPLE_CF_221, LOCK_FIXTURE_VERSIONS, lockFixturePath, readRun, readScenario } from './support/repositoryLockFixtures';

/** Файловый источник статусов: соединение USERS × OBJECTS реального файла хранилища. */

const context = { user: 'Admin', password: '', platformVersionHint: '8.3.27.0' };

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

function asDumpLocks(records: readonly RepositoryServerLockRecord[]): string[] {
  const unitIds = parseConfigDumpInfoUnitIds(fs.readFileSync(path.join(EXAMPLE_CF_221, 'ConfigDumpInfo.xml'), 'utf-8'));
  return records.map((record) => `${String(unitIds.get(record.objectId))}=${record.user}`).sort();
}

for (const version of LOCK_FIXTURE_VERSIONS) {
  suite(`FileRepositoryLockStatusSource — хранилище платформы ${version}`, () => {
    test('захваты совпадают со сценарием, даты — в окне прогона генератора', async () => {
      const source: RepositoryLockStatusSource = new FileRepositoryLockStatusSource();
      const location = classifyRepositoryLocation(lockFixturePath(version), os.tmpdir());
      assert.strictEqual(source.supports(location), true);
      const { records, serverVersion } = await source.readLocks(location, context);
      const scenario = readScenario();
      assert.deepStrictEqual(asDumpLocks(records), scenario.locks.map((lock) => `${lock.dumpName}=${lock.user}`).sort());
      const run = readRun(version);
      for (const record of records) {
        assert.ok(record.lockedAt && record.lockedAt >= run.lockedFrom && record.lockedAt <= run.lockedTo, String(record.lockedAt));
      }
      assert.strictEqual(serverVersion, undefined);
    });
  });
}

suite('FileRepositoryLockStatusSource — ошибки', () => {
  const source: RepositoryLockStatusSource = new FileRepositoryLockStatusSource();

  test('сетевой адрес не поддерживается, а переданный напрямую — ошибка адреса', async () => {
    const location = classifyRepositoryLocation('tcp://srv/repo', os.tmpdir());
    assert.strictEqual(source.supports(location), false);
    await expectStatusError(source.readLocks(location, context), 'invalid-address');
  });

  test('каталог без 1CD → not-found с путём', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-file-src-'));
    const location = classifyRepositoryLocation(dir, os.tmpdir());
    await expectStatusError(source.readLocks(location, context), 'not-found', new RegExp(path.join(dir, '1cv8ddb.1CD').replace(/[\\.]/g, '\\$&')));
  });

  test('чужой файл → unsupported-format («не является 1CD»)', async () => {
    const databaseFile = path.join(EXAMPLE_CF_221, 'ConfigDumpInfo.xml');
    await expectStatusError(source.readLocks({ kind: 'file', repoPath: EXAMPLE_CF_221, databaseFile }, context), 'unsupported-format', /не является/);
  });

  test('усечённый файл → corrupted («повторите обновление»)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-file-src-'));
    const data = fs.readFileSync(lockFixturePath('8.5.1', '1cv8ddb.1CD'));
    fs.writeFileSync(path.join(dir, '1cv8ddb.1CD'), data.subarray(0, readRun('8.5.1').pageSize * 2));
    await expectStatusError(source.readLocks(classifyRepositoryLocation(dir, os.tmpdir()), context), 'corrupted', /повторите обновление/);
  });

  test('повреждение после заголовка (страница корня за пределами файла) → corrupted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-file-src-'));
    const databaseFile = path.join(dir, '1cv8ddb.1CD');
    const data = Buffer.from(fs.readFileSync(lockFixturePath('8.5.1', '1cv8ddb.1CD')));
    data.writeUInt32LE(9999, readRun('8.5.1').pageSize * 2 + 24);
    fs.writeFileSync(databaseFile, data);
    await expectStatusError(source.readLocks(classifyRepositoryLocation(dir, os.tmpdir()), context), 'corrupted');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('файл без прав на чтение → unavailable (тесты идут не от root)', async function () {
    if (process.getuid?.() === 0) {
      this.skip();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-file-src-'));
    const databaseFile = path.join(dir, '1cv8ddb.1CD');
    fs.copyFileSync(lockFixturePath('8.5.1', '1cv8ddb.1CD'), databaseFile);
    fs.chmodSync(databaseFile, 0o000);
    try {
      await expectStatusError(source.readLocks(classifyRepositoryLocation(dir, os.tmpdir()), context), 'unavailable', /недоступен/);
    } finally {
      fs.chmodSync(databaseFile, 0o600);
    }
  });

  test('путь-каталог вместо файла 1CD → unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-file-src-'));
    fs.mkdirSync(path.join(dir, '1cv8ddb.1CD'));
    await expectStatusError(source.readLocks(classifyRepositoryLocation(dir, os.tmpdir()), context), 'unavailable');
  });

  // EBUSY/EPERM на Linux не воспроизводятся (файл занят другим процессом — поведение Windows),
  // поэтому классификация проверяется на объектах ошибок с этими кодами.
  const codes: [unknown, RepositoryLockStatusError['code']][] = [
    [Object.assign(new Error('busy'), { code: 'EBUSY' }), 'unavailable'],
    [Object.assign(new Error('perm'), { code: 'EPERM' }), 'unavailable'],
    [Object.assign(new Error('nodir'), { code: 'ENOTDIR' }), 'not-found'],
    ['строка вместо ошибки', 'unavailable'],
  ];
  for (const [error, code] of codes) {
    test(`classifyFileAccessError: ${String((error as { code?: string }).code ?? error)} → ${code}`, () => {
      const classified = classifyFileAccessError(error, '/x/1cv8ddb.1CD');
      assert.strictEqual(classified.code, code);
      assert.ok(classified.message.includes('/x/1cv8ddb.1CD'));
    });
  }
});
