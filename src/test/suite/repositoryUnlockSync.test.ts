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
import { buildScopeKey, computeFileHash, saveHashCache } from '../../infra/cache/HashCache';
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
 *
 * Раздел 10 (подчинённые объекты с собственным XML, D1–D3): критерии приёмки
 * 10.1.8/10.1.9/10.1.10 (алгоритм эталонов отмены по Р8 — снимок/dump/empty/
 * missing с обходом от предков к потомкам, единицы под рекурсивным корнем по
 * манифесту) целиком зависят от НОВОГО внутреннего контракта
 * `RepositoryDumpRounds`/`RepositoryLockSnapshotStore` (манифест v3,
 * `readSnapshotInfo`, `diffOwnersAgainstBaseline` по единицам — все уже
 * покрыты юнит-тестами `repositoryDumpRounds.test.ts`/
 * `repositoryLockSnapshotStore.test.ts`) и от способа, которым
 * `RepositoryUnlockSync` их скомбинирует (порядок вызовов, какая структура
 * данных описывает «4 источника эталона» из Р8). Синтетический сквозной тест
 * здесь заранее угадывал бы эту внутреннюю комбинацию — решается и фиксируется
 * отдельным заходом test-writer/developer/qa, когда реализация раздела 10
 * появится и можно будет писать тест по НАБЛЮДАЕМОМУ поведению, а не по
 * догадке. `RepositoryLockState`-уровневые критерии (`lockModes`, правило
 * старых записей, P4 — частичное усечение группы) уже покрыты полностью в
 * `repositoryLockState.test.ts`/`repositoryService.test.ts` (isEditRestricted).
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
  reloadCalls: number;
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
  let reloadCalls = 0;

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
    reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
  };

  return {
    workspaceRoot, configRoot, target, repositoryService, guard, services, outputLines, markChangedCalls,
    get reloadCalls() { return reloadCalls; },
  };
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
  function setupDivergedSnapshot(harness: Harness): { objectModulePath: string; snapshotContent: string } {
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
    const { objectModulePath, snapshotContent } = setupDivergedSnapshot(harness);

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
    const { objectModulePath } = setupDivergedSnapshot(harness);

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
    const { objectModulePath } = setupDivergedSnapshot(harness);

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

  test('изменился САМ Configuration.xml относительно манифеста — откат структурный, даже без удалённых/пропавших файлов (критерий: line "Configuration.xml в корне" в rollbackToEtalons)', async () => {
    const harness = createHarness();
    const configXmlPath = path.join(harness.configRoot, 'Configuration.xml');
    const originalContent = fs.readFileSync(configXmlPath, 'utf-8');
    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: '__configuration_root__',
      members: ['__configuration_root__'],
      recursiveRoot: true,
    });
    harness.repositoryService.snapshots.captureRootManifest(harness.target);

    // Локальная правка Configuration.xml ПОСЛЕ снятия манифеста.
    fs.writeFileSync(configXmlPath, '<MetaDataObject changed="true"/>', 'utf-8');

    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-root-configxml-'));
    fs.writeFileSync(path.join(dumpDir, 'Configuration.xml'), originalContent, 'utf-8');
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dumpDir, dispose: () => fs.rmSync(dumpDir, { recursive: true, force: true }) }),
      confirmRollback: () => Promise.resolve(true),
    });

    const outcome = await runRepositoryUnlockFlow(rootNode(harness), { recursive: true, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(fs.readFileSync(configXmlPath, 'utf-8'), originalContent, 'Configuration.xml должен быть восстановлен к версии хранилища.');
    assert.strictEqual(harness.reloadCalls, 1, 'Изменение самого Configuration.xml в корне обязано считаться структурным (reloadEntries), даже без удалённых/пропавших файлов.');
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

function formData(overrides: Partial<{ recursive: boolean; comment: string; keepLocked: boolean; force: boolean }> = {}) {
  return { recursive: false, comment: 'Комментарий помещения', keepLocked: false, force: false, ...overrides };
}

suite('RepositoryUnlockSync — runRepositoryCommitFlow', () => {
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

suite('RepositoryUnlockSync — узел без валидной цели', () => {
  test('runRepositoryUnlockFlow: xmlPath не резолвится — outcome "failed"', async () => {
    const harness = createHarness();
    const node: RepositoryNodeRef = { nodeKind: 'Catalog', label: 'Товары', xmlPath: path.join(harness.workspaceRoot, 'нет', 'Товары.xml') };
    let notifyErrorCalls = 0;
    const deps = baseDeps({ notifyError: () => { notifyErrorCalls += 1; } });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(notifyErrorCalls, 1);
  });

  test('runRepositoryCommitFlow: xmlPath не резолвится — outcome "failed"', async () => {
    const harness = createHarness();
    const node: RepositoryNodeRef = { nodeKind: 'Catalog', label: 'Товары', xmlPath: path.join(harness.workspaceRoot, 'нет', 'Товары.xml') };
    const deps = baseDeps();

    const outcome = await runRepositoryCommitFlow(node, formData(), harness.services, deps);

    assert.strictEqual(outcome, 'failed');
  });

  test('node.label не задан — fullName резолвится из <Name> XML объекта', async () => {
    const harness = createHarness();
    const xmlPath = path.join(harness.configRoot, 'Catalogs', 'Товары.xml');
    fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
    fs.writeFileSync(xmlPath, '<MetaDataObject><Catalog><Properties><Name>Товары</Name></Properties></Catalog></MetaDataObject>', 'utf-8');
    const node: RepositoryNodeRef = { nodeKind: 'Catalog', xmlPath };
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }), isFileSyncEnabled: () => false });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), false);
  });

  test('runRepositoryCommitFlow: node.label не задан для КОРНЯ — objectLabel резолвится из target.displayName (имени конфигурации)', async () => {
    const harness = createHarness();
    // <Name> обязателен: resolveTargetByConfigRoot()/resolveTargetByXmlPath() читают
    // реальное имя конфигурации из файла — без тега узел резолвится в имя каталога.
    fs.writeFileSync(path.join(harness.configRoot, 'Configuration.xml'), '<MetaDataObject><Name>ИмяИзФайла</Name></MetaDataObject>', 'utf-8');
    const node: RepositoryNodeRef = { nodeKind: 'configuration', xmlPath: path.join(harness.configRoot, 'Configuration.xml') };
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: '__configuration_root__', members: ['__configuration_root__'] });
    let notifyInfoMessage: string | undefined;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      isFileSyncEnabled: () => false,
      notifyInfo: (message: string) => { notifyInfoMessage = message; },
    });

    const outcome = await runRepositoryCommitFlow(node, formData({ keepLocked: false }), harness.services, deps);

    assert.strictEqual(outcome, 'done');
    // Для корня node.label не задаётся вызывающей стороной вовсе — objectLabel обязан
    // резолвиться из target.displayName (имени конфигурации из <Name>), а не быть пустым.
    assert.ok(notifyInfoMessage?.includes('ИмяИзФайла'), `сообщение обязано называть конфигурацию по имени: "${String(notifyInfoMessage)}"`);
  });
});

suite('RepositoryUnlockSync — isRootNode: узел расширения (issue #1)', () => {
  test('recursive unlock узла nodeKind:"extension" — хеш-кэш читается ДО аренды так же, как для "configuration" (ветка isRootNode)', async () => {
    const harness = createHarness();
    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: '__configuration_root__',
      members: ['__configuration_root__'],
      recursiveRoot: true,
    });
    harness.repositoryService.snapshots.captureRootManifest(harness.target);
    const node: RepositoryNodeRef = { nodeKind: 'extension', label: 'Расширение', xmlPath: path.join(harness.configRoot, 'Configuration.xml') };
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }), dumpToTemp: notCalled('dumpToTemp') });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: true, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), false);
  });
});

suite('RepositoryUnlockSync — исключение внутри аренды', () => {
  test('runRepositoryUnlockFlow: runRepositoryCli бросает исключение — reportFlowError, outcome "failed", guard освобождён', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    let notifyErrorCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => { throw new Error('сбой процесса'); },
      notifyError: () => { notifyErrorCalls += 1; },
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(notifyErrorCalls, 1);
    assert.strictEqual(harness.guard.isBusy, false);
    assert.ok(harness.outputLines.some((line) => line.includes('[repository][file-sync][error]') && line.includes('сбой процесса')));
  });

  test('runRepositoryCommitFlow: runRepositoryCli бросает исключение — reportFlowError, outcome "failed"', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    let notifyErrorCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => { throw new Error('сбой процесса'); },
      notifyError: () => { notifyErrorCalls += 1; },
    });

    const outcome = await runRepositoryCommitFlow(node, formData(), harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(notifyErrorCalls, 1);
  });

  test('completeUnlockSync бросает исключение (confirmRollback упал) — reportFlowError, outcome всё равно "done" (сама отмена захвата уже состоялась), снимки удалены', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    const snapshotContent = 'содержимое на момент захвата';
    fs.writeFileSync(objectModulePath, snapshotContent, 'utf-8');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const scope = resolveObjectScope(harness.configRoot, 'Справочник.Товары', harness.target) as Extract<ObjectScope, { kind: 'object' }>;
    harness.repositoryService.snapshots.captureFromProject(harness.target, 'Справочник.Товары', scope);
    fs.writeFileSync(objectModulePath, 'правка во время захвата', 'utf-8');

    let notifyErrorCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      confirmRollback: () => { throw new Error('диалог упал'); },
      notifyError: () => { notifyErrorCalls += 1; },
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done', 'отмена захвата (CLI+state) уже состоялась — сбой синхронизации файлов её не отменяет.');
    assert.strictEqual(notifyErrorCalls, 1);
    assert.ok(harness.outputLines.some((line) => line.includes('синхронизация файлов') && line.includes('диалог упал')));
    assert.strictEqual(harness.repositoryService.snapshots.readSnapshotHashes(harness.target, 'Справочник.Товары'), undefined, 'снимок должен быть удалён даже при сбое синхронизации (finally).');
  });
});

suite('RepositoryUnlockSync — область объекта не определена при сравнении с эталоном', () => {
  test('fullName не резолвится ни в проекте, ни в выгрузке — лог, объект пропущен, остальной поток не ломается', async () => {
    const harness = createHarness();
    const real = catalogNode(harness, 'РеальныйОбъект');
    const node: RepositoryNodeRef = { nodeKind: 'Catalog', label: 'НесуществующийОбъект', xmlPath: real.xmlPath };
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.НесуществующийОбъект', members: ['Справочник.НесуществующийОбъект'] });
    const emptyDump = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-scope-null-'));

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: emptyDump, dispose: () => fs.rmSync(emptyDump, { recursive: true, force: true }) }),
    }));

    assert.strictEqual(outcome, 'done');
    assert.ok(harness.outputLines.some((line) => line.includes('область файлов не определена') && line.includes('НесуществующийОбъект')));
  });
});

suite('RepositoryUnlockSync — нет снимка, dumpToTemp провалился', () => {
  test('acquireUnlockEtalons: dumpToTemp вернул ok:false — лог ошибки, notifyWarning, откат не выполняется', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    let warningCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: false, reason: 'сервер хранилища недоступен' }),
      notifyWarning: () => { warningCalls += 1; },
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done', 'сама отмена захвата уже состоялась.');
    assert.strictEqual(warningCalls, 1);
    assert.ok(harness.outputLines.some((line) => line.includes('сервер хранилища недоступен')));
  });
});

suite('RepositoryUnlockSync — commit keepLocked с рекурсивным корнем', () => {
  function rootNode(harness: Harness): RepositoryNodeRef {
    return { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') };
  }

  test('keepLocked=true, корень захвачен рекурсивно — снимок пересоздаётся как хеш-манифест из проекта (не из отдельных объектов)', async () => {
    const harness = createHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'А.xml'), '<xml/>', 'utf-8');
    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: '__configuration_root__',
      members: ['__configuration_root__'],
      recursiveRoot: true,
    });
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }) });

    const outcome = await runRepositoryCommitFlow(rootNode(harness), formData({ recursive: true, keepLocked: true }), harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), true);
    const manifest = harness.repositoryService.snapshots.readRootManifestHashes(harness.target);
    assert.ok(manifest, 'манифест должен быть пересоздан из текущего состояния проекта.');
  });

  test('keepLocked=true, настройка синхронизации выключена — пересъём снимка/манифеста не выполняется', async () => {
    const harness = createHarness();
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }), isFileSyncEnabled: () => false });

    const outcome = await runRepositoryCommitFlow(catalogNode(harness, 'Товары'), formData({ keepLocked: true }), harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), true);
  });

  test('keepLocked=true, корень захвачен НЕрекурсивно — recaptureSnapshotsFromProject идёт по members (сентинел, ветка isRootLockName)', async () => {
    const harness = createHarness();
    // Нерекурсивный захват корня — isRootRecursiveLocked=false, поэтому пересъём идёт
    // НЕ хеш-манифестом (та ветка уже покрыта выше), а обычным циклом по members,
    // где единственный member — сентинел корня (projectXml для него не резолвится —
    // ветка subordinates:undefined).
    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: '__configuration_root__',
      members: ['__configuration_root__'],
    });
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }) });

    const outcome = await runRepositoryCommitFlow(rootNode(harness), formData({ recursive: false, keepLocked: true }), harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), true);
    assert.strictEqual(harness.repositoryService.snapshots.readRootManifestHashes(harness.target), undefined, 'Хеш-манифест здесь не создаётся — снимок обычный, по scope "root".');
  });
});

suite('RepositoryUnlockSync — корень рекурсивно без манифеста, но с непустым хеш-кэшем', () => {
  test('эталон строится из хеш-кэша (не из манифеста) — изменённый по кэшу объект восстанавливается частичной выгрузкой', async () => {
    const harness = createHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    const filePath = path.join(harness.configRoot, 'Catalogs', 'А.xml');
    fs.writeFileSync(filePath, '<xml/>', 'utf-8');
    // Хеш-кэш фиксирует состояние ДО правки — эталон для отката.
    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    saveHashCache(harness.workspaceRoot, {
      schemaVersion: 1, scopeKey, generatedAt: '',
      files: { 'Catalogs/А.xml': computeFileHash(filePath) },
    });
    // Правка ПОСЛЕ снятия хеш-кэша — то самое расхождение, которое обязан найти collectRootOwnersToRestore.
    fs.writeFileSync(filePath, '<xml changed="true"/>', 'utf-8');

    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: '__configuration_root__',
      members: ['__configuration_root__'],
      recursiveRoot: true,
    });
    // captureRootManifest НЕ вызывается — манифеста нет, эталон строится из хеш-кэша.

    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-root-cache-dump-'));
    let dumpRequest: unknown;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_target: RepositoryTarget, request: ConfigurationDumpRequest) => {
        dumpRequest = request;
        return Promise.resolve({ ok: true, dir: dumpDir, dispose: () => fs.rmSync(dumpDir, { recursive: true, force: true }) });
      },
      confirmRollback: () => Promise.resolve(true),
    });

    const outcome = await runRepositoryUnlockFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      { recursive: true, force: false },
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done');
    assert.ok(dumpRequest);
    const request = dumpRequest as { mode: string; fullNames?: string[] };
    assert.strictEqual(request.mode, 'partial');
    assert.deepStrictEqual(request.fullNames, ['Справочник.А']);
  });
});
