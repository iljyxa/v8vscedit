import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentOperationService,
  AgentWorkspaceService,
  type AgentCommandResult,
  type DesignerAgentTransport,
  type DesignerAgentTransportFactory,
} from '../../infra/agent';
import { buildAgentDumpSessionId, pruneStaleAgentDumps } from '../../infra/agent/AgentDumpCleanup';
import {
  createImportTempDir,
  getImportTempRoot,
  isInsideWorkspaceServiceDir,
  isStale,
  pruneStaleImportTempDirs,
  readMtimeMs,
} from '../../infra/fs/WorkspaceTempDir';
import { STALE_OPERATION_TEMP_MAX_AGE_MS, sweepStaleOperationTemp } from '../../infra/process/StaleOperationTempSweep';

/**
 * Issue #76 — хвосты временных каталогов операций после аварийного завершения
 * extension host: `.v8vscedit/import-temp/*` (возраст по mtime) и одноразовые выгрузки
 * агента `.v8vscedit/agent/0/{workspace,lists}` (возраст по метке в имени).
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

/** Каталог выгрузки хранилища — тем же кодом, что и живой поток, с подкаталогом `cf`. */
function makeImportTempDir(workspaceRoot: string, prefix: string, mtimeMs: number): string {
  const dir = createImportTempDir(workspaceRoot, prefix);
  fs.mkdirSync(path.join(dir, 'cf'));
  fs.writeFileSync(path.join(dir, 'cf', 'Configuration.xml'), 'выгрузка', 'utf-8');
  setMtime(dir, mtimeMs);
  return dir;
}

function makeAgentDump(workspaceRoot: string, sessionKey: string, startedAtMs: number, withList: boolean): string[] {
  const workspaceService = new AgentWorkspaceService(workspaceRoot);
  const sessionId = buildAgentDumpSessionId(sessionKey, startedAtMs, 1);
  const workspace = workspaceService.ensureWorkspace(sessionId, { kind: 'cf' });
  const created = [workspace.workspaceRoot];
  if (withList) {
    created.push(workspaceService.writeObjectNamesFile(sessionId, ['Справочник.Номенклатура']));
  }
  return created;
}

suite('WorkspaceTempDir — раскладка import-temp (issue #76)', () => {
  test('createImportTempDir создаёт уникальный каталог с префиксом внутри getImportTempRoot', () => {
    const workspaceRoot = makeWorkspace();
    const first = createImportTempDir(workspaceRoot, 'repository-dump-');
    const second = createImportTempDir(workspaceRoot, 'repository-dump-');

    assert.strictEqual(getImportTempRoot(workspaceRoot), path.join(workspaceRoot, '.v8vscedit', 'import-temp'));
    for (const dir of [first, second]) {
      assert.strictEqual(path.dirname(dir), getImportTempRoot(workspaceRoot));
      assert.match(path.basename(dir), /^repository-dump-.+$/);
      assert.ok(fs.statSync(dir).isDirectory());
    }
    assert.notStrictEqual(first, second);
  });
});

suite('WorkspaceTempDir — isInsideWorkspaceServiceDir (issue #79)', () => {
  const root = path.join(path.sep, 'ws');
  const cases: readonly { name: string; filePath: string; expected: boolean }[] = [
    { name: 'бэкап слияния', filePath: path.join(root, '.v8vscedit', 'repository', 'merge', 's', 'b', 'ObjectModule.bsl'), expected: true },
    { name: 'сам служебный каталог', filePath: path.join(root, '.v8vscedit'), expected: true },
    { name: 'файл конфигурации', filePath: path.join(root, 'Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), expected: false },
    { name: 'каталог с похожим именем', filePath: path.join(root, '.v8vscedit-backup', 'x.bsl'), expected: false },
    { name: 'служебный каталог другой рабочей области', filePath: path.join(path.sep, 'other', '.v8vscedit', 'x.bsl'), expected: false },
  ];
  for (const { name, filePath, expected } of cases) {
    test(`${name} → ${String(expected)}`, () => {
      assert.strictEqual(isInsideWorkspaceServiceDir(root, filePath), expected);
    });
  }
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
    const dir = makeImportTempDir(makeWorkspace(), 'repository-dump-', NOW.getTime() - DAY);
    assert.strictEqual(await readMtimeMs(dir), NOW.getTime() - DAY);
  });

  test('записи уже нет (удалена после readdir) — undefined, а не исключение', async () => {
    const dir = makeImportTempDir(makeWorkspace(), 'repository-dump-', NOW.getTime());
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
    const oldDump = makeImportTempDir(workspaceRoot, 'repository-dump-', nowMs - 2 * DAY);
    const oldImport = makeImportTempDir(workspaceRoot, 'import-ext-', nowMs - DAY - 1000);
    const fresh = makeImportTempDir(workspaceRoot, 'repository-dump-', nowMs - HOUR);
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

class FakeTransport implements DesignerAgentTransport {
  execute(): Promise<AgentCommandResult> {
    return Promise.resolve({ messages: [] });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeTransportFactory implements DesignerAgentTransportFactory {
  create(): Promise<DesignerAgentTransport> {
    return Promise.resolve(new FakeTransport());
  }
}

suite('AgentDumpCleanup — pruneStaleAgentDumps (issue #76)', () => {
  test('buildAgentDumpSessionId: <ключ>-dump-<мс>-<номер>', () => {
    assert.strictEqual(buildAgentDumpSessionId('cfe-EVOLC', 1717243200000, 7), 'cfe-EVOLC-dump-1717243200000-7');
  });

  test('каталога агента нет — пустой результат', async () => {
    assert.deepStrictEqual(await pruneStaleAgentDumps(makeWorkspace(), NOW, DAY), []);
  });

  test('брошенная выгрузка dumpToDirectory (без dispose) распознаётся и удаляется целиком', async () => {
    const workspaceRoot = makeWorkspace();
    const configRoot = path.join(workspaceRoot, 'src', 'cf');
    fs.mkdirSync(configRoot, { recursive: true });
    const service = new AgentOperationService(workspaceRoot, new FakeTransportFactory());
    const agentFileRoot = new AgentWorkspaceService(workspaceRoot).getAgentFileRoot();

    // dispose() не вызывается — так выглядит поток, прерванный крахом процесса.
    const handle = await service.dumpToDirectory(
      { kind: 'cf', name: 'Основная', rootPath: configRoot },
      { mode: 'partial', fullNames: ['Справочник.Номенклатура'] }
    );
    const listFiles = fs.readdirSync(path.join(agentFileRoot, 'lists'));
    assert.strictEqual(listFiles.length, 1);
    assert.ok(fs.existsSync(handle.dir));

    assert.deepStrictEqual(await pruneStaleAgentDumps(workspaceRoot, new Date(Date.now() + 2 * DAY), DAY), [
      path.join(agentFileRoot, 'workspace', path.basename(path.dirname(handle.dir))),
      path.join(agentFileRoot, 'lists', listFiles[0]),
    ]);
    assert.ok(!fs.existsSync(handle.dir));
    assert.deepStrictEqual(fs.readdirSync(path.join(agentFileRoot, 'lists')), []);
  });

  test('удаляются только выгрузки старше порога; постоянное зеркало и чужие имена остаются', async () => {
    const workspaceRoot = makeWorkspace();
    const nowMs = NOW.getTime();
    const workspaceService = new AgentWorkspaceService(workspaceRoot);
    const agentFileRoot = workspaceService.getAgentFileRoot();
    const oldDump = makeAgentDump(workspaceRoot, 'cf', nowMs - 2 * DAY, true);
    const oldNoList = makeAgentDump(workspaceRoot, 'cfe-EVOLC', nowMs - DAY - 1, false);
    const fresh = makeAgentDump(workspaceRoot, 'cf', nowMs - HOUR, true);
    const future = makeAgentDump(workspaceRoot, 'cf', nowMs + HOUR, false);
    const mirror = workspaceService.ensureWorkspace('cf', { kind: 'cf' }).workspaceRoot;
    const operationList = workspaceService.writeListFile('load-1', ['Catalogs/Товары.xml']);
    const oldStamp = String(nowMs - 2 * DAY);
    const nonTxt = path.join(agentFileRoot, 'lists', `cf-dump-${oldStamp}-1.bak`);
    const dirInLists = path.join(agentFileRoot, 'lists', `cf-dump-${oldStamp}-2.txt`);
    const fileInWorkspace = path.join(agentFileRoot, 'workspace', `cf-dump-${oldStamp}-3`);
    fs.writeFileSync(nonTxt, '', 'utf-8');
    fs.mkdirSync(dirInLists);
    fs.writeFileSync(fileInWorkspace, '', 'utf-8');

    const removed = await pruneStaleAgentDumps(workspaceRoot, NOW, DAY);

    assert.deepStrictEqual([...removed].sort(), [...oldDump, ...oldNoList].sort());
    for (const kept of [...fresh, ...future, mirror, operationList, nonTxt, dirInLists, fileInWorkspace]) {
      assert.ok(fs.existsSync(kept), kept);
    }
  });
});

suite('StaleOperationTempSweep — sweepStaleOperationTemp (issue #76)', () => {
  test('порог по умолчанию — сутки', async () => {
    const workspaceRoot = makeWorkspace();
    const nowMs = Date.now();
    const old = makeImportTempDir(workspaceRoot, 'repository-dump-', nowMs - STALE_OPERATION_TEMP_MAX_AGE_MS - HOUR);
    const fresh = makeImportTempDir(workspaceRoot, 'repository-dump-', nowMs - STALE_OPERATION_TEMP_MAX_AGE_MS + HOUR);

    const result = await sweepStaleOperationTemp(workspaceRoot, new Date(nowMs));

    assert.strictEqual(STALE_OPERATION_TEMP_MAX_AGE_MS, DAY);
    assert.deepStrictEqual(result, { removed: [old], failures: [] });
    assert.ok(fs.existsSync(fresh));
  });

  test('подметает import-temp и выгрузки агента за один вызов', async () => {
    const workspaceRoot = makeWorkspace();
    const nowMs = NOW.getTime();
    const importDir = makeImportTempDir(workspaceRoot, 'repository-dump-', nowMs - 2 * DAY);
    const agentDump = makeAgentDump(workspaceRoot, 'cf', nowMs - 2 * DAY, true);

    const result = await sweepStaleOperationTemp(workspaceRoot, NOW, DAY);

    assert.deepStrictEqual(result, { removed: [importDir, ...agentDump], failures: [] });
  });

  test('сбой одного шага не мешает другому и возвращается текстом', async () => {
    const workspaceRoot = makeWorkspace();
    fs.mkdirSync(path.dirname(getImportTempRoot(workspaceRoot)), { recursive: true });
    fs.writeFileSync(getImportTempRoot(workspaceRoot), 'не каталог', 'utf-8');
    const agentDump = makeAgentDump(workspaceRoot, 'cf', NOW.getTime() - 2 * DAY, false);

    const result = await sweepStaleOperationTemp(workspaceRoot, NOW, DAY);

    assert.deepStrictEqual(result.removed, agentDump);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /ENOTDIR/);
  });
});
