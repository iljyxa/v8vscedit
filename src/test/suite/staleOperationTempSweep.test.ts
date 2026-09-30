import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createImportTempDir,
  getImportTempRoot,
  isStale,
  pruneStaleImportTempDirs,
  readMtimeMs,
} from '../../infra/fs/WorkspaceTempDir';
import { STALE_OPERATION_TEMP_MAX_AGE_MS, sweepStaleOperationTemp } from '../../infra/process/StaleOperationTempSweep';

/**
 * Хвосты временных каталогов операций после аварийного завершения extension host:
 * `.v8vscedit/import-temp/*` (возраст по mtime).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2024-06-01T12:00:00.000Z');

const createdWorkspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-stale-temp-sweep-'));
  createdWorkspaces.push(dir);
  return dir;
}

teardown(() => {
  createdWorkspaces.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function setMtime(target: string, at: number): void {
  const date = new Date(at);
  fs.utimesSync(target, date, date);
}

/** Каталог операции Конфигуратора — тем же кодом, что и живой поток, с подкаталогом `cf`. */
function makeImportTempDir(workspaceRoot: string, prefix: string, mtimeMs: number): string {
  const dir = createImportTempDir(workspaceRoot, prefix);
  fs.mkdirSync(path.join(dir, 'cf'));
  fs.writeFileSync(path.join(dir, 'cf', 'Configuration.xml'), 'выгрузка', 'utf-8');
  setMtime(dir, mtimeMs);
  return dir;
}

suite('WorkspaceTempDir — раскладка import-temp', () => {
  test('createImportTempDir создаёт уникальный каталог с префиксом внутри getImportTempRoot', () => {
    const workspaceRoot = makeWorkspace();
    const first = createImportTempDir(workspaceRoot, 'import-cf-');
    const second = createImportTempDir(workspaceRoot, 'import-cf-');

    assert.strictEqual(getImportTempRoot(workspaceRoot), path.join(workspaceRoot, '.v8vscedit', 'import-temp'));
    for (const dir of [first, second]) {
      assert.strictEqual(path.dirname(dir), getImportTempRoot(workspaceRoot));
      assert.match(path.basename(dir), /^import-cf-.+$/);
      assert.ok(fs.statSync(dir).isDirectory());
    }
    assert.notStrictEqual(first, second);
  });
});

suite('WorkspaceTempDir — isStale', () => {
  const cases: readonly { name: string; time: number | undefined; expected: boolean }[] = [
    { name: 'нет метки', time: undefined, expected: false },
    { name: 'старше порога', time: NOW.getTime() - DAY - 1, expected: true },
    { name: 'ровно порог', time: NOW.getTime() - DAY, expected: false },
    { name: 'моложе порога', time: NOW.getTime() - HOUR, expected: false },
    { name: 'метка из будущего', time: NOW.getTime() + HOUR, expected: false },
  ];
  for (const { name, time, expected } of cases) {
    test(`${name} → ${String(expected)}`, () => {
      assert.strictEqual(isStale(time, NOW.getTime(), DAY), expected);
    });
  }
});

suite('WorkspaceTempDir — readMtimeMs', () => {
  test('существующий каталог — его mtime', async () => {
    const dir = makeImportTempDir(makeWorkspace(), 'import-cf-', NOW.getTime() - DAY);
    assert.strictEqual(await readMtimeMs(dir), NOW.getTime() - DAY);
  });

  test('записи уже нет (удалена после readdir) — undefined, а не исключение', async () => {
    const dir = makeImportTempDir(makeWorkspace(), 'import-cf-', NOW.getTime());
    fs.rmSync(dir, { recursive: true });
    assert.strictEqual(await readMtimeMs(dir), undefined);
  });

  test('прочие ошибки пробрасываются (путь внутри обычного файла — ENOTDIR)', async () => {
    const file = path.join(makeWorkspace(), 'file.txt');
    fs.writeFileSync(file, '', 'utf-8');
    await assert.rejects(readMtimeMs(path.join(file, 'child')), /ENOTDIR/);
  });
});

suite('WorkspaceTempDir — pruneStaleImportTempDirs', () => {
  test('каталога import-temp нет — пустой результат', async () => {
    assert.deepStrictEqual(await pruneStaleImportTempDirs(makeWorkspace(), NOW, DAY), []);
  });

  test('удаляются только каталоги старше порога; свежий, пограничный, из будущего и файлы остаются', async () => {
    const workspaceRoot = makeWorkspace();
    const nowMs = NOW.getTime();
    const oldDump = makeImportTempDir(workspaceRoot, 'import-cf-', nowMs - 2 * DAY);
    const oldImport = makeImportTempDir(workspaceRoot, 'import-ext-', nowMs - DAY - 1000);
    const fresh = makeImportTempDir(workspaceRoot, 'import-cf-', nowMs - HOUR);
    const boundary = makeImportTempDir(workspaceRoot, 'list-ext-', nowMs - DAY);
    const future = makeImportTempDir(workspaceRoot, 'import-cf-', nowMs + HOUR);
    const strayFile = path.join(getImportTempRoot(workspaceRoot), 'stray.log');
    fs.writeFileSync(strayFile, 'лог', 'utf-8');
    setMtime(strayFile, nowMs - 10 * DAY);

    const removed = await pruneStaleImportTempDirs(workspaceRoot, NOW, DAY);

    assert.deepStrictEqual([...removed].sort(), [oldDump, oldImport].sort());
    assert.ok(!fs.existsSync(oldDump));
    assert.ok(!fs.existsSync(oldImport));
    for (const kept of [fresh, boundary, future, strayFile]) {
      assert.ok(fs.existsSync(kept), kept);
    }
  });

  test('import-temp — обычный файл: ошибка пробрасывается', async () => {
    const workspaceRoot = makeWorkspace();
    fs.mkdirSync(path.dirname(getImportTempRoot(workspaceRoot)), { recursive: true });
    fs.writeFileSync(getImportTempRoot(workspaceRoot), 'не каталог', 'utf-8');

    await assert.rejects(pruneStaleImportTempDirs(workspaceRoot, NOW, DAY), /ENOTDIR/);
  });
});

suite('StaleOperationTempSweep — sweepStaleOperationTemp', () => {
  test('порог по умолчанию — сутки', async () => {
    const workspaceRoot = makeWorkspace();
    const nowMs = Date.now();
    const old = makeImportTempDir(workspaceRoot, 'import-cf-', nowMs - STALE_OPERATION_TEMP_MAX_AGE_MS - HOUR);
    const fresh = makeImportTempDir(workspaceRoot, 'import-cf-', nowMs - STALE_OPERATION_TEMP_MAX_AGE_MS + HOUR);

    const result = await sweepStaleOperationTemp(workspaceRoot, new Date(nowMs));

    assert.strictEqual(STALE_OPERATION_TEMP_MAX_AGE_MS, DAY);
    assert.deepStrictEqual(result, { removed: [old], failures: [] });
    assert.ok(fs.existsSync(fresh));
  });

  test('сбой подметания не бросает исключение, а возвращается текстом', async () => {
    const workspaceRoot = makeWorkspace();
    fs.mkdirSync(path.dirname(getImportTempRoot(workspaceRoot)), { recursive: true });
    fs.writeFileSync(getImportTempRoot(workspaceRoot), 'не каталог', 'utf-8');

    const result = await sweepStaleOperationTemp(workspaceRoot, NOW, DAY);

    assert.deepStrictEqual(result.removed, []);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /ENOTDIR/);
  });
});
