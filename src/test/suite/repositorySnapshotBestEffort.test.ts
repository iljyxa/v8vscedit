import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { buildRepositoryScopeKey } from '../../infra/repository/RepositoryLockState';
import { buildMergeBackupDir } from '../../infra/repository/RepositoryMergeApplier';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { getRepositoryMergeRoot, removePathWithRetries } from '../../infra/repository/RepositoryTempCleanup';
import type { MergeDiffPair } from '../../ui/commands/repository/RepositoryFileSyncDialogs';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices } from '../../ui/commands/repository/RepositoryFileSyncShared';
import { runRepositoryLockFlow, runRepositoryUpdateFlow } from '../../ui/commands/repository/RepositoryLockSync';
import { runRepositoryCommitFlow, runRepositoryUnlockFlow } from '../../ui/commands/repository/RepositoryUnlockSync';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { bumpConfigDumpInfoVersion } from './support/configDumpInfoFixture';
import { createPartialDumpFixture, KNOWN_FIXTURE_UNITS, type PartialDumpFixture } from './support/partialDumpFixture';

/**
 * Issue #103 — сбой шага снимка (на Windows — EPERM при удалении каталога снимка, который
 * держит антивирус/индексатор) не должен превращаться в потерю результата операции
 * хранилища: отмена захвата/помещение/захват завершаются 'done', сбой — строка
 * `[repository][file-sync][warn]` и одно предупреждение; при сбое после записи файлов
 * проекта пользователь узнаёт путь каталога резервных копий.
 *
 * Сбой совместного доступа Windows на Linux не воспроизводим (chmod даёт EACCES и не
 * работает под root), поэтому моделируется внедрённым в хранилище снимков примитивом
 * RemoveTree по конкретному пути; остальные операции ФС — настоящие, проект — реальная
 * копия example/2.21/src/cf, выгрузка — partialDumpFixture.
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const NOW = new Date('2024-01-01T00:00:00.000Z');
const FORM = KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska;
const FORM_REL = path.join('Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка', 'Ext', 'Form.xml');

type RemoveHook = (targetPath: string) => void;

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

function notCalled(name: string): (...args: unknown[]) => never {
  return () => { throw new Error(`"${name}" не должен вызываться в этом сценарии`); };
}

function epermError(): Error {
  return Object.assign(new Error("EPERM: operation not permitted, rmdir '\\\\?\\c:\\Ïðîåêòû\\x'"), { code: 'EPERM' });
}

const failRemove: RemoveHook = () => { throw epermError(); };

/** Удаление проходит, но на месте файла появляется каталог — запись манифеста падает EISDIR. */
const replaceWithDirectory: RemoveHook = (targetPath) => {
  removePathWithRetries(targetPath);
  fs.mkdirSync(targetPath, { recursive: true });
};

interface Notices {
  info: string[];
  warnings: string[];
  errors: string[];
}

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  services: RepositoryFileSyncServices;
  outputLines: string[];
  /** Сбой удаления по пути; без записи — настоящее удаление с повторами. */
  removeHooks: Map<string, RemoveHook>;
  fixture: PartialDumpFixture;
  notices: Notices;
}

const createdRoots: string[] = [];
const createdFixtures: PartialDumpFixture[] = [];

teardown(() => {
  createdFixtures.splice(0).forEach((fixture) => fixture.disposeAll());
  createdRoots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snapshot-best-effort-'));
  createdRoots.push(workspaceRoot);
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.cpSync(EXAMPLE_CF, configRoot, { recursive: true });
  const removeHooks = new Map<string, RemoveHook>();
  const repositoryService = new RepositoryService(
    workspaceRoot,
    new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot),
    {
      removeTree: (targetPath) => {
        const hook = removeHooks.get(path.resolve(targetPath));
        if (hook) {
          hook(targetPath);
          return;
        }
        removePathWithRetries(targetPath);
      },
    }
  );
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };
  const outputLines: string[] = [];
  const services: RepositoryFileSyncServices = {
    configurationOperationGuard: new ConfigurationOperationGuard(),
    workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
    outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
    repositoryService,
    projectSecretStorage: {} as unknown as RepositoryFileSyncServices['projectSecretStorage'],
    supportService: undefined,
    suppressConfigurationReloadForFiles: () => undefined,
    markChangedConfigurationByFiles: () => undefined,
    treeProvider: { refresh: () => undefined, refreshCacheForFiles: () => true } as unknown as MetadataTreeProvider,
    refreshActionsView: () => undefined,
    reloadEntries: () => Promise.resolve(),
  };
  const fixture = createPartialDumpFixture(EXAMPLE_CF, target.displayName);
  createdFixtures.push(fixture);
  return {
    workspaceRoot, configRoot, target, repositoryService, services, outputLines, removeHooks, fixture,
    notices: { info: [], warnings: [], errors: [] },
  };
}

function baseDeps(harness: Harness, overrides: Partial<RepositoryFileSyncDeps> = {}): RepositoryFileSyncDeps {
  return {
    runRepositoryCli: () => Promise.resolve({ status: 'done' }),
    dumpToTemp: (target, request, services) => harness.fixture.dumpToTemp(target, request, services),
    chooseConflictResolution: notCalled('chooseConflictResolution'),
    confirmRollback: notCalled('confirmRollback'),
    openDiffs: notCalled('openDiffs'),
    notifyBusy: () => undefined,
    notifyInfo: (message) => { harness.notices.info.push(message); },
    notifyWarning: (message) => { harness.notices.warnings.push(message); },
    notifyError: (message) => { harness.notices.errors.push(message); },
    isFileSyncEnabled: () => true,
    getDirtyFilePaths: () => [],
    now: () => NOW,
    ...overrides,
  };
}

function resetNotices(harness: Harness): void {
  harness.notices.info.length = 0;
  harness.notices.warnings.length = 0;
  harness.notices.errors.length = 0;
  harness.outputLines.length = 0;
}

function formNode(harness: Harness): RepositoryNodeRef {
  const ownerXmlPath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты.xml');
  return {
    nodeKind: 'Form',
    label: 'ФормаСписка',
    xmlPath: ownerXmlPath,
    metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXmlPath },
  };
}

function rootNode(harness: Harness): RepositoryNodeRef {
  return { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') };
}

function snapshotDir(harness: Harness): string {
  return harness.repositoryService.snapshots.resolveSnapshotDir(harness.target, FORM);
}

function warnLines(harness: Harness): string[] {
  return harness.outputLines.filter((line) => line.startsWith('[repository][file-sync][warn]'));
}

function assertNoGarbledPath(harness: Harness): void {
  [...harness.outputLines, ...harness.notices.warnings].forEach((line) => assert.ok(!line.includes('Ïðîåêòû'), line));
}

function editForm(harness: Harness): { formPath: string; repositoryContent: string; localContent: string } {
  const formPath = path.join(harness.configRoot, FORM_REL);
  const repositoryContent = fs.readFileSync(path.join(EXAMPLE_CF, FORM_REL), 'utf-8');
  const localContent = `${repositoryContent}<!--локальная правка формы-->`;
  fs.writeFileSync(formPath, localContent, 'utf-8');
  return { formPath, repositoryContent, localContent };
}

async function lockForm(harness: Harness): Promise<void> {
  const outcome = await runRepositoryLockFlow(formNode(harness), false, harness.services, baseDeps(harness));
  assert.strictEqual(outcome, 'done');
  assert.ok(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, FORM), 'предпосылка: снимок формы снят.');
  resetNotices(harness);
}

suite('Снимок best-effort: отмена захвата и повторный захват формы (issue #103)', () => {
  for (const force of [false, true]) {
    test(`отмена захвата force=${String(force)}: сбой удаления каталога снимка — 'done', warn, одно предупреждение; повторный захват со сбоем — 'done'`, async () => {
      const harness = createHarness();
      await lockForm(harness);
      harness.removeHooks.set(path.resolve(snapshotDir(harness)), failRemove);

      const unlocked = await runRepositoryUnlockFlow(formNode(harness), { recursive: false, force }, harness.services, baseDeps(harness));

      assert.strictEqual(unlocked, 'done');
      assert.deepStrictEqual(harness.notices.errors, []);
      assert.strictEqual(harness.notices.warnings.length, 1);
      assert.ok(harness.notices.info.some((message) => message.includes('освобождены')));
      assert.ok(!harness.outputLines.some((line) => line.includes('[error]')), harness.outputLines.join('\n'));
      const [discardWarn] = warnLines(harness);
      assert.ok(discardWarn.includes(FORM) && discardWarn.includes(snapshotDir(harness)) && discardWarn.includes('EPERM'), discardWarn);
      assertNoGarbledPath(harness);
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, FORM), false);
      assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, FORM), undefined);

      resetNotices(harness);
      const relocked = await runRepositoryLockFlow(formNode(harness), false, harness.services, baseDeps(harness));

      assert.strictEqual(relocked, 'done');
      assert.deepStrictEqual(harness.notices.errors, []);
      assert.strictEqual(harness.notices.warnings.length, 1);
      assert.ok(harness.notices.info.some((message) => message.includes('захвачены')));
      const [captureWarn] = warnLines(harness);
      assert.ok(captureWarn.includes('не сохранён') && captureWarn.includes(snapshotDir(harness)) && captureWarn.includes('будет выгружена заново'), captureWarn);
      assertNoGarbledPath(harness);
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, FORM), true);
      assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, FORM), undefined);

      // Продолжение: снимка нет — эталон берётся свежей выгрузкой, откат возвращает версию хранилища.
      harness.removeHooks.clear();
      resetNotices(harness);
      const { formPath, repositoryContent } = editForm(harness);
      const callsBefore = harness.fixture.calls.length;
      let rollbackAsked = 0;

      const rolledBack = await runRepositoryUnlockFlow(formNode(harness), { recursive: false, force }, harness.services, baseDeps(harness, {
        confirmRollback: () => { rollbackAsked += 1; return Promise.resolve(true); },
      }));

      assert.strictEqual(rolledBack, 'done');
      assert.deepStrictEqual(harness.fixture.calls.slice(callsBefore).map((call) => call.names), [[FORM]]);
      assert.strictEqual(rollbackAsked, 1);
      assert.strictEqual(fs.readFileSync(formPath, 'utf-8'), repositoryContent);
      assert.deepStrictEqual(harness.notices.errors, []);
      assert.deepStrictEqual(harness.notices.warnings, []);
    });
  }

  test('откат при отмене прерван сбоем удаления лишнего файла — reportFlowError, путь резервных копий, снимки удалены', async () => {
    const harness = createHarness();
    await lockForm(harness);
    const extra = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка', 'Ext', 'Лишний.txt');
    fs.writeFileSync(extra, 'появился после захвата', 'utf-8');
    harness.removeHooks.set(path.resolve(extra), failRemove);
    const backupDir = buildMergeBackupDir(harness.workspaceRoot, buildRepositoryScopeKey(harness.target), 'unlock', NOW);

    const outcome = await runRepositoryUnlockFlow(formNode(harness), { recursive: false, force: false }, harness.services, baseDeps(harness, {
      confirmRollback: () => Promise.resolve(true),
    }));

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.notices.errors.length, 1);
    assert.ok(harness.notices.errors[0].includes('синхронизация файлов'), harness.notices.errors[0]);
    assert.ok(fs.existsSync(backupDir), 'резервная копия лишнего файла снята до сбоя удаления.');
    assert.ok(harness.notices.warnings.some((message) => message.includes(backupDir)), harness.notices.warnings.join('\n'));
    assert.ok(warnLines(harness).some((line) => line.includes(backupDir)), harness.outputLines.join('\n'));
    assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, FORM), undefined);
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, FORM), false);
  });
});

suite('Снимок best-effort: захват с конфликтом и сбои после записи файлов (issue #103)', () => {
  test('choice="compare" + сбой снимка — окно сравнения открыто, резервные копии в журнале, предупреждение о снимке', async () => {
    const harness = createHarness();
    const { formPath, repositoryContent } = editForm(harness);
    harness.removeHooks.set(path.resolve(snapshotDir(harness)), failRemove);
    const diffCalls: MergeDiffPair[][] = [];

    const outcome = await runRepositoryLockFlow(formNode(harness), false, harness.services, baseDeps(harness, {
      chooseConflictResolution: () => Promise.resolve('compare'),
      openDiffs: (pairs) => { diffCalls.push(pairs); },
    }));

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(harness.notices.errors, []);
    assert.strictEqual(diffCalls.length, 1);
    assert.strictEqual(diffCalls[0].length, 1);
    const [pair] = diffCalls[0];
    assert.ok(pair.local.startsWith(getRepositoryMergeRoot(harness.workspaceRoot)), pair.local);
    assert.strictEqual(pair.repository, formPath);
    assert.strictEqual(pair.projectSide, 'repository');
    assert.strictEqual(fs.readFileSync(formPath, 'utf-8'), repositoryContent);
    assert.ok(harness.outputLines.some((line) => line.includes('резервные копии:')));
    assert.strictEqual(harness.notices.warnings.length, 1);
    assert.ok(harness.notices.warnings[0].includes('не сохранено снимков захвата: 1'), harness.notices.warnings[0]);
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, FORM), true);
  });

  test('choice="compare" + сбой снимка, окно сравнения не открылось — сообщены и резервные копии, и несохранённый снимок', async () => {
    const harness = createHarness();
    editForm(harness);
    harness.removeHooks.set(path.resolve(snapshotDir(harness)), failRemove);

    const outcome = await runRepositoryLockFlow(formNode(harness), false, harness.services, baseDeps(harness, {
      chooseConflictResolution: () => Promise.resolve('compare'),
      openDiffs: () => { throw new Error('окно сравнения не открылось'); },
    }));

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.notices.errors.length, 1, harness.notices.errors.join('\n'));
    assert.ok(harness.notices.warnings.some((text) => text.includes(getRepositoryMergeRoot(harness.workspaceRoot))), harness.notices.warnings.join('\n'));
    assert.ok(harness.notices.warnings.some((text) => text.includes('не сохранено снимков захвата: 1')), harness.notices.warnings.join('\n'));
  });

  test('choice="replace", сбой обновления дерева после записи — notifyError и путь резервных копий, снимок не снят', async () => {
    const harness = createHarness();
    const { localContent } = editForm(harness);
    harness.services.treeProvider = {
      refresh: () => undefined,
      refreshCacheForFiles: () => { throw new Error('дерево недоступно'); },
    } as unknown as MetadataTreeProvider;
    const backupDir = buildMergeBackupDir(harness.workspaceRoot, buildRepositoryScopeKey(harness.target), 'lock', NOW);

    const outcome = await runRepositoryLockFlow(formNode(harness), false, harness.services, baseDeps(harness, {
      chooseConflictResolution: () => Promise.resolve('replace'),
    }));

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.notices.errors.length, 1);
    assert.ok(harness.notices.errors[0].includes('Захват «ФормаСписка»: синхронизация файлов'), harness.notices.errors[0]);
    assert.strictEqual(harness.notices.warnings.length, 1);
    assert.ok(harness.notices.warnings[0].includes(backupDir), harness.notices.warnings[0]);
    assert.ok(warnLines(harness).some((line) => line.includes(backupDir)), harness.outputLines.join('\n'));
    assert.strictEqual(fs.readFileSync(path.join(backupDir, FORM_REL), 'utf-8'), localContent);
    assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, FORM), undefined);
  });

  test('сбой post-mutation на чистом проекте — каталога резервных копий нет, о копиях не сообщается', async () => {
    const harness = createHarness();
    harness.services.refreshActionsView = () => { throw new Error('панель недоступна'); };

    const outcome = await runRepositoryLockFlow(formNode(harness), false, harness.services, baseDeps(harness));

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.notices.errors.length, 1);
    assert.ok(harness.notices.errors[0].includes('панель недоступна'));
    assert.deepStrictEqual(harness.notices.warnings, []);
    assert.deepStrictEqual(warnLines(harness), []);
    assert.strictEqual(fs.existsSync(getRepositoryMergeRoot(harness.workspaceRoot)), false);
  });
});

/** Выгрузка ConfigDumpInfo.xml для рекурсивного корня: тот же (без изменений) или с изменённым владельцем. */
function rootDeps(harness: Harness, changed: boolean): RepositoryFileSyncDeps {
  const projectInfo = fs.readFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), 'utf-8');
  const info = changed
    ? bumpConfigDumpInfoVersion(projectInfo, 'Catalog.Валюты.ObjectModule', '000000000000000000000000000000000000000b')
    : projectInfo;
  return baseDeps(harness, {
    dumpToTemp: (target, request, services) => {
      if (request.mode !== 'update-info') {
        return harness.fixture.dumpToTemp(target, request, services);
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snapshot-best-effort-info-'));
      createdRoots.push(dir);
      fs.writeFileSync(path.join(dir, 'ConfigDumpInfo.xml'), info, 'utf-8');
      return Promise.resolve({ ok: true, dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) });
    },
  });
}

suite('Снимок best-effort: манифест рекурсивно захваченного корня (issue #103)', () => {
  const modes: { name: string; stale: boolean; code: string }[] = [
    { name: 'запись упала после удаления (EISDIR)', stale: false, code: 'EISDIR' },
    { name: 'старый манифест не удалён (EPERM)', stale: true, code: 'EPERM' },
  ];
  for (const branch of [{ name: 'unchanged', changed: false }, { name: 'acquired', changed: true }]) {
    for (const mode of modes) {
      test(`захват корня, ветка ${branch.name}: ${mode.name} — 'done', предупреждение${mode.stale ? ' об устаревшем снимке' : ''}`, async () => {
        const harness = createHarness();
        const snapshots = harness.repositoryService.snapshots;
        const manifestPath = snapshots.resolveRootManifestPath(harness.target);
        if (mode.stale) {
          snapshots.captureRootManifest(harness.target);
        }
        harness.removeHooks.set(path.resolve(manifestPath), mode.stale ? failRemove : replaceWithDirectory);

        const outcome = await runRepositoryLockFlow(rootNode(harness), true, harness.services, rootDeps(harness, branch.changed));

        assert.strictEqual(outcome, 'done');
        assert.deepStrictEqual(harness.notices.errors, []);
        assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), true);
        assert.strictEqual(harness.notices.warnings.length, 1);
        assert.strictEqual(harness.notices.warnings[0].includes('устарел'), mode.stale, harness.notices.warnings[0]);
        const lines = warnLines(harness);
        assert.strictEqual(lines.length, 1, harness.outputLines.join('\n'));
        assert.ok(lines[0].includes(manifestPath) && lines[0].includes(mode.code), lines[0]);
        assert.strictEqual(snapshots.readRootManifestHashes(harness.target) !== undefined, mode.stale);
        assertNoGarbledPath(harness);
      });
    }
  }
  [{ name: 'unchanged', changed: false }, { name: 'acquired', changed: true }].forEach((branch) => {
    test(`получение корня без рекурсивного захвата, ветка ${branch.name} — манифест не снимается, предупреждений нет`, async () => {
      const harness = createHarness();

      const outcome = await runRepositoryUpdateFlow(rootNode(harness), { recursive: true, force: false }, harness.services, rootDeps(harness, branch.changed));

      assert.strictEqual(outcome, 'done');
      assert.deepStrictEqual(harness.notices.errors, []);
      assert.deepStrictEqual(harness.notices.warnings, []);
      assert.strictEqual(harness.repositoryService.snapshots.readRootManifestHashes(harness.target), undefined);
    });
  });
});

suite('Снимок best-effort: помещение и рекурсивная отмена захвата корня (issue #103)', () => {
  const commitForm = { recursive: false, comment: 'правка', force: false };

  test('помещение без сохранения захвата: сбой удаления снимка — \'done\', warn, «помещены»', async () => {
    const harness = createHarness();
    await lockForm(harness);
    harness.removeHooks.set(path.resolve(snapshotDir(harness)), failRemove);

    const outcome = await runRepositoryCommitFlow(formNode(harness), { ...commitForm, keepLocked: false }, harness.services, baseDeps(harness));

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(harness.notices.errors, []);
    assert.strictEqual(harness.notices.warnings.length, 1);
    assert.ok(harness.notices.warnings[0].includes('не удалено снимков захвата: 1'), harness.notices.warnings[0]);
    assert.ok(harness.notices.info.some((message) => message.includes('помещены')));
    assert.ok(warnLines(harness)[0].includes(snapshotDir(harness)));
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, FORM), false);
  });

  test('помещение с сохранением захвата: сбой повторного снимка — \'done\', warn о несохранённом снимке', async () => {
    const harness = createHarness();
    await lockForm(harness);
    harness.removeHooks.set(path.resolve(snapshotDir(harness)), failRemove);

    const outcome = await runRepositoryCommitFlow(formNode(harness), { ...commitForm, keepLocked: true }, harness.services, baseDeps(harness));

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(harness.notices.errors, []);
    assert.strictEqual(harness.notices.warnings.length, 1);
    assert.ok(harness.notices.info.some((message) => message.includes('помещены')));
    const [line] = warnLines(harness);
    assert.ok(line.includes('не сохранён') && line.includes(snapshotDir(harness)), line);
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, FORM), true);
    assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, FORM), undefined);
  });

  test('помещение корня с сохранением рекурсивного захвата: сбой манифеста корня — \'done\', устаревший снимок', async () => {
    const harness = createHarness();
    assert.strictEqual(await runRepositoryLockFlow(rootNode(harness), true, harness.services, rootDeps(harness, false)), 'done');
    const manifestPath = harness.repositoryService.snapshots.resolveRootManifestPath(harness.target);
    assert.ok(harness.repositoryService.snapshots.readRootManifestHashes(harness.target), 'предпосылка: манифест корня снят.');
    resetNotices(harness);
    harness.removeHooks.set(path.resolve(manifestPath), failRemove);

    const outcome = await runRepositoryCommitFlow(
      rootNode(harness),
      { recursive: true, comment: 'правка', force: false, keepLocked: true },
      harness.services,
      baseDeps(harness)
    );

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(harness.notices.errors, []);
    assert.strictEqual(harness.notices.warnings.length, 1);
    assert.ok(harness.notices.warnings[0].includes('устарел') && harness.notices.warnings[0].includes(manifestPath), harness.notices.warnings[0]);
    assert.ok(harness.notices.info.some((message) => message.includes('помещены')));
  });

  test('рекурсивная отмена захвата корня: сбой удаления каталога снимков цели — \'done\', warn с его путём', async () => {
    const harness = createHarness();
    assert.strictEqual(await runRepositoryLockFlow(rootNode(harness), true, harness.services, rootDeps(harness, false)), 'done');
    resetNotices(harness);
    const scopeDir = harness.repositoryService.snapshots.resolveScopeDir(harness.target);
    harness.removeHooks.set(path.resolve(scopeDir), failRemove);

    const outcome = await runRepositoryUnlockFlow(rootNode(harness), { recursive: true, force: false }, harness.services, baseDeps(harness));

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(harness.notices.errors, []);
    assert.strictEqual(harness.notices.warnings.length, 1);
    assert.ok(harness.notices.info.some((message) => message.includes('освобождены')));
    const [line] = warnLines(harness);
    assert.ok(line.includes(scopeDir) && line.includes('EPERM'), line);
    assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), false);
    assert.strictEqual(harness.repositoryService.snapshots.readRootManifestHashes(harness.target), undefined);
  });
});
