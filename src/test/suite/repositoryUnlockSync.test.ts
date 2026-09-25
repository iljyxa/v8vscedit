import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runRepositoryUnlockFlow, runRepositoryCommitFlow } from '../../ui/commands/repository/RepositoryUnlockSync';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices } from '../../ui/commands/repository/RepositoryFileSyncShared';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { resolveObjectScope, type ObjectScope } from '../../infra/repository/RepositoryObjectScope';
import type { ConfigurationDumpRequest } from '../../infra/agent';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';

/**
 * Issue #1 — `RepositoryUnlockSync` (unlock/commit), раздел «B. Поток «отмена
 * захвата»» плана архитектора. Как и в `repositoryLockSync.test.ts`, полная
 * матрица сценариев (все пороги/раунды рекурсивной подсистемы) не покрывается
 * буквально «в лоб» — базовые, однозначно специфицированные ветки покрыты
 * полностью; глубокие количественные пороги уже проверены на уровне чистых
 * функций.
 */

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

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  guard: ConfigurationOperationGuard;
  services: RepositoryFileSyncServices;
  outputLines: string[];
  markChangedCalls: string[][];
}

function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-sync-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');

  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
  const guard = new ConfigurationOperationGuard();
  const outputLines: string[] = [];
  const markChangedCalls: string[][] = [];

  const services: RepositoryFileSyncServices = {
    configurationOperationGuard: guard,
    workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
    outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
    repositoryService,
    projectSecretStorage: {} as unknown as RepositoryFileSyncServices['projectSecretStorage'],
    supportService: undefined,
    suppressConfigurationReloadForFiles: () => undefined,
    markChangedConfigurationByFiles: (files: string[]) => markChangedCalls.push(files),
    treeProvider: {
      refresh: () => undefined,
      refreshCacheForFiles: () => true,
    } as unknown as MetadataTreeProvider,
    refreshActionsView: () => undefined,
    reloadEntries: () => Promise.resolve(),
  };

  return { workspaceRoot, configRoot, target, repositoryService, guard, services, outputLines, markChangedCalls };
}

function baseDeps(overrides: Partial<RepositoryFileSyncDeps> = {}): RepositoryFileSyncDeps {
  return {
    runRepositoryCli: notCalled('runRepositoryCli'),
    dumpToTemp: notCalled('dumpToTemp'),
    chooseConflictResolution: notCalled('chooseConflictResolution'),
    confirmRollback: notCalled('confirmRollback'),
    openDiffs: notCalled('openDiffs'),
    notifyBusy: () => undefined,
    notifyInfo: () => undefined,
    notifyWarning: () => undefined,
    notifyError: () => undefined,
    isFileSyncEnabled: () => true,
    getDirtyFilePaths: () => [],
    now: () => new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function catalogNode(harness: Harness, objectName: string): RepositoryNodeRef {
  const xmlPath = path.join(harness.configRoot, 'Catalogs', `${objectName}.xml`);
  fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
  if (!fs.existsSync(xmlPath)) {
    fs.writeFileSync(xmlPath, '<MetaDataObject/>', 'utf-8');
  }
  return { nodeKind: 'Catalog', label: objectName, xmlPath };
}

suite('RepositoryUnlockSync — runRepositoryUnlockFlow: базовая гвардия и ошибки CLI', () => {
  test('guard занят — busy, CLI не вызывается', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const lease = harness.guard.tryAcquire('Синхронизация с хранилищем');
    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, baseDeps());
    assert.strictEqual(outcome, 'busy');
    lease?.release();
  });

  test('CLI status:"failed" — outcome "failed", state не меняется (объект остаётся захваченным)', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });

    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'failed', message: 'сбой' }),
      notifyError: () => undefined,
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), true);
  });
});

suite('RepositoryUnlockSync — снимок без изменений (тихо, без диалога)', () => {
  test('файлы совпадают со снимком — CLI применяется, никакого диалога/отката', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    fs.writeFileSync(objectModulePath, 'содержимое на момент захвата', 'utf-8');

    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const scope = resolveObjectScope(harness.configRoot, 'Справочник.Товары', harness.target) as Extract<ObjectScope, { kind: 'object' }>;
    harness.repositoryService.snapshots.captureFromProject(harness.target, 'Справочник.Товары', scope);

    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }) });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), 'содержимое на момент захвата');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), false);
  });
});

suite('RepositoryUnlockSync — расхождение со снимком × {откат, оставить, Esc}', () => {
  function setupDivergedSnapshot(harness: Harness, node: RepositoryNodeRef): { objectModulePath: string; snapshotContent: string } {
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    const snapshotContent = 'содержимое на момент захвата';
    fs.writeFileSync(objectModulePath, snapshotContent, 'utf-8');

    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const scope = resolveObjectScope(harness.configRoot, 'Справочник.Товары', harness.target) as Extract<ObjectScope, { kind: 'object' }>;
    harness.repositoryService.snapshots.captureFromProject(harness.target, 'Справочник.Товары', scope);

    fs.writeFileSync(objectModulePath, 'правка во время захвата', 'utf-8');
    return { objectModulePath, snapshotContent };
  }

  test('пользователь выбирает откат — файл восстанавливается к снимку, hasConflicts диалог показан вне аренды', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const { objectModulePath, snapshotContent } = setupDivergedSnapshot(harness, node);

    let observedBusyDuringDialog: boolean | undefined;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      confirmRollback: () => {
        observedBusyDuringDialog = harness.guard.isBusy;
        return Promise.resolve(true);
      },
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(observedBusyDuringDialog, false);
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), snapshotContent);
  });

  test('пользователь выбирает "оставить изменения" — файл не трогается, помечается изменённым', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const { objectModulePath } = setupDivergedSnapshot(harness, node);

    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      confirmRollback: () => Promise.resolve(false),
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), 'правка во время захвата');
    assert.ok(harness.markChangedCalls.some((files) => files.some((f) => path.resolve(f) === path.resolve(objectModulePath))));
  });

  test('Esc (диалог закрыт без выбора) трактуется как "оставить" — файл не трогается', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const { objectModulePath } = setupDivergedSnapshot(harness, node);

    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      confirmRollback: () => Promise.resolve(undefined as unknown as boolean),
    });

    await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), 'правка во время захвата');
  });
});

suite('RepositoryUnlockSync — нет снимка (объект захвачен вне нашего flow / снимок утерян)', () => {
  test('настройка включена: unlock выполняет dumpToTemp (в аренде), затем диалог (вне аренды)', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    fs.writeFileSync(objectModulePath, 'локальное содержимое', 'utf-8');

    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-dump-'));
    fs.mkdirSync(path.join(dumpDir, 'Catalogs', 'Товары', 'Ext'), { recursive: true });
    fs.writeFileSync(path.join(dumpDir, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl'), 'эталон из хранилища');

    let dumpCalledWithBusy: boolean | undefined;
    let dialogCalledWithBusy: boolean | undefined;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => {
        dumpCalledWithBusy = harness.guard.isBusy;
        return Promise.resolve({ ok: true, dir: dumpDir, dispose: () => fs.rmSync(dumpDir, { recursive: true, force: true }) });
      },
      confirmRollback: () => {
        dialogCalledWithBusy = harness.guard.isBusy;
        return Promise.resolve(true);
      },
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(dumpCalledWithBusy, true);
    assert.strictEqual(dialogCalledWithBusy, false);
  });

  test('настройка выключена: dumpToTemp/диалог не вызываются вовсе', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });

    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      isFileSyncEnabled: () => false,
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);
    assert.strictEqual(outcome, 'done');
  });
});

suite('RepositoryUnlockSync — корень рекурсивно с хеш-манифестом', () => {
  function rootNode(harness: Harness): RepositoryNodeRef {
    return { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') };
  }

  test('без изменений относительно манифеста — Конфигуратор для довыгрузки не запускается (dumpToTemp не вызван)', async () => {
    const harness = createHarness();
    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: '__configuration_root__',
      members: ['__configuration_root__'],
      recursiveRoot: true,
    });
    harness.repositoryService.snapshots.captureRootManifest(harness.target);

    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }), dumpToTemp: notCalled('dumpToTemp') });

    const outcome = await runRepositoryUnlockFlow(rootNode(harness), { recursive: true, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), false);
  });

  test('2 изменённых объекта относительно манифеста — частичная выгрузка ровно по ним', async () => {
    const harness = createHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'А.xml'), '<xml/>', 'utf-8');
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Б.xml'), '<xml/>', 'utf-8');

    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: '__configuration_root__',
      members: ['__configuration_root__'],
      recursiveRoot: true,
    });
    harness.repositoryService.snapshots.captureRootManifest(harness.target);

    // Изменяем оба объекта ПОСЛЕ снятия манифеста.
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'А.xml'), '<xml changed="true"/>', 'utf-8');
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Б.xml'), '<xml changed="true"/>', 'utf-8');

    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-root-dump-'));
    let dumpRequest: unknown;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_target: RepositoryTarget, request: ConfigurationDumpRequest) => {
        dumpRequest = request;
        return Promise.resolve({ ok: true, dir: dumpDir, dispose: () => fs.rmSync(dumpDir, { recursive: true, force: true }) });
      },
      confirmRollback: () => Promise.resolve(true),
    });

    const outcome = await runRepositoryUnlockFlow(rootNode(harness), { recursive: true, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.ok(dumpRequest);
    const request = dumpRequest as { mode: string; fullNames?: string[] };
    assert.strictEqual(request.mode, 'partial');
    assert.deepStrictEqual([...(request.fullNames ?? [])].sort(), ['Справочник.А', 'Справочник.Б'].sort());
  });

  test('нет манифеста (объект был захвачен ДО обновления расширения) — пропуск синхронизации файлов с логом, без исключения', async () => {
    const harness = createHarness();
    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: '__configuration_root__',
      members: ['__configuration_root__'],
      recursiveRoot: true,
    });
    // captureRootManifest НЕ вызывается — манифеста нет.

    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }), dumpToTemp: notCalled('dumpToTemp') });

    const outcome = await runRepositoryUnlockFlow(rootNode(harness), { recursive: true, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.ok(harness.outputLines.some((line) => line.includes('[repository][file-sync]')), 'Должен быть лог о пропуске синхронизации без манифеста.');
  });
});

suite('RepositoryUnlockSync — runRepositoryCommitFlow', () => {
  function formData(overrides: Partial<{ recursive: boolean; comment: string; keepLocked: boolean; force: boolean }> = {}) {
    return { recursive: false, comment: 'Комментарий помещения', keepLocked: false, force: false, ...overrides };
  }

  test('guard занят — busy, CLI не вызывается', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const lease = harness.guard.tryAcquire('Синхронизация с хранилищем');
    const outcome = await runRepositoryCommitFlow(node, formData(), harness.services, baseDeps());
    assert.strictEqual(outcome, 'busy');
    lease?.release();
  });

  test('CLI провалился — failed, state не меняется', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'failed', message: 'сбой' }) });

    const outcome = await runRepositoryCommitFlow(node, formData(), harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), true);
  });

  test('keepLocked=true — объект остаётся захваченным, снимок пересоздаётся из проекта', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }) });

    const outcome = await runRepositoryCommitFlow(node, formData({ keepLocked: true }), harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), true);
  });

  test('keepLocked=false — объект освобождается (эквивалент unlock)', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }) });

    const outcome = await runRepositoryCommitFlow(node, formData({ keepLocked: false }), harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), false);
  });
});
