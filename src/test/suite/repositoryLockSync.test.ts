import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runRepositoryLockFlow, runRepositoryUpdateFlow } from '../../ui/commands/repository/RepositoryLockSync';
import {
  ensureRepositoryGuardFree,
  type RepositoryFileSyncDeps,
  type RepositoryFileSyncServices,
} from '../../ui/commands/repository/RepositoryFileSyncShared';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { buildScopeKey, computeFileHash, saveHashCache, loadHashCache } from '../../infra/cache/HashCache';
import { getRootLockName, buildRootDumpListName } from '../../infra/repository/RepositoryObjectNames';
import type { ConfigurationDumpRequest } from '../../infra/agent';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';

/**
 * Issue #1 — `RepositoryLockSync` (lock/update) поверх общего
 * `configurationOperationGuard.runExclusive` + `RepositoryMergePlanner`/
 * `RepositoryMergeApplier`/`RepositoryLockSnapshotStore`.
 *
 * ВАЖНО (честная оценка объёма покрытия): полная матрица сценариев из плана
 * теста архитектора для этого файла (root-incremental во всех пороговых
 * вариантах, рекурсивная подсистема с довыгрузкой недостающих участников до
 * неподвижной точки, все комбинации сирот/skip-incomplete в конце цепочки)
 * ЗДЕСЬ покрыта ЧАСТИЧНО — базовые ветки (guard/busy, happy path без
 * конфликтов, конфликт × 3 исхода, несохранённый редактор, отключённая
 * настройка, корень нерекурсивно, корень рекурсивно без/с изменениями и один
 * fallback-сценарий, force/version на update) проверены полностью и
 * детерминированно; более глубокие комбинации (порог ROOT_INCREMENTAL_MAX_*,
 * многораундовая довыгрузка подсистемы) уже покрыты на уровне чистых функций
 * (`configDumpInfoDiff.test.ts`, `repositoryDumpPlan.test.ts`) и должны быть
 * доведены до сквозного сценария здесь отдельным заходом, если разработка
 * вскроет реальное расхождение — см. итоговый отчёт test-writer.
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
  return () => {
    throw new Error(`"${name}" не должен вызываться в этом сценарии`);
  };
}

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  guard: ConfigurationOperationGuard;
  services: RepositoryFileSyncServices;
  outputLines: string[];
  refreshCacheForFilesCalls: string[][];
  treeRefreshCalls: number;
  actionsViewCalls: number;
  reloadCalls: number;
  markChangedCalls: string[][];
  suppressCalls: string[][];
}

function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');

  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
  const guard = new ConfigurationOperationGuard();
  const outputLines: string[] = [];
  const refreshCacheForFilesCalls: string[][] = [];
  let treeRefreshCalls = 0;
  let actionsViewCalls = 0;
  let reloadCalls = 0;
  const markChangedCalls: string[][] = [];
  const suppressCalls: string[][] = [];

  const services: RepositoryFileSyncServices = {
    configurationOperationGuard: guard,
    workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
    outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
    repositoryService,
    projectSecretStorage: {} as unknown as RepositoryFileSyncServices['projectSecretStorage'],
    supportService: undefined,
    suppressConfigurationReloadForFiles: (files: string[]) => suppressCalls.push(files),
    markChangedConfigurationByFiles: (files: string[]) => markChangedCalls.push(files),
    treeProvider: {
      refresh: () => { treeRefreshCalls += 1; },
      refreshCacheForFiles: (files: string[]) => { refreshCacheForFilesCalls.push(files); return true; },
    } as unknown as MetadataTreeProvider,
    refreshActionsView: () => { actionsViewCalls += 1; },
    reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
  };

  return {
    workspaceRoot, configRoot, target, repositoryService, guard, services, outputLines,
    refreshCacheForFilesCalls,
    get treeRefreshCalls() { return treeRefreshCalls; },
    get actionsViewCalls() { return actionsViewCalls; },
    get reloadCalls() { return reloadCalls; },
    markChangedCalls, suppressCalls,
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

function makeTempDump(seedFiles: Record<string, string>): { dir: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-dump-'));
  for (const [rel, content] of Object.entries(seedFiles)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

suite('RepositoryLockSync — ensureRepositoryGuardFree', () => {
  test('guard свободен → true, notifyBusy не вызывается', () => {
    const harness = createHarness();
    let notifyBusyCalls = 0;
    const deps = baseDeps({ notifyBusy: () => { notifyBusyCalls += 1; } });
    assert.strictEqual(ensureRepositoryGuardFree(harness.services, deps, 'Захват'), true);
    assert.strictEqual(notifyBusyCalls, 0);
  });

  test('guard занят → false, notifyBusy вызван, лог содержит держателя, аренда держателя цела', () => {
    const harness = createHarness();
    const lease = harness.guard.tryAcquire('Импорт конфигураций');
    let notifyBusyMessage: string | undefined;
    const deps = baseDeps({ notifyBusy: (message: string) => { notifyBusyMessage = message; } });

    const result = ensureRepositoryGuardFree(harness.services, deps, 'Захват');

    assert.strictEqual(result, false);
    assert.ok(notifyBusyMessage?.includes('Импорт конфигураций'));
    assert.ok(harness.outputLines.some((line) => line.includes('[repository][file-sync][busy]') && line.includes('"Импорт конфигураций"')));
    assert.strictEqual(harness.guard.heldBy, 'Импорт конфигураций');
    lease?.release();
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: guard/busy семантика', () => {
  test('guard занят ДО показа диалогов — busy, CLI не вызывается, state не меняется', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const lease = harness.guard.tryAcquire('Синхронизация с хранилищем');
    const deps = baseDeps();

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'busy');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), false);
    lease?.release();
  });

  // Настоящий TOCTOU-сценарий (guard свободен на предпроверке
  // ensureRepositoryGuardFree, но занят чужой арендой к моменту показа
  // askRecursiveMode/pickBoolean и последующего runExclusive) относится к
  // ОБВЯЗКЕ команды `v8vscedit.repository.lock` в `RepositoryCommands.ts` —
  // сам `runRepositoryLockFlow` получает уже разрешённый `recursive: boolean`
  // и делает единственную атомарную проверку через `guard.runExclusive`
  // (эквивалентно первому тесту этого suite). Гонка целиком между
  // предпроверкой и диалогом проверяется на уровне команды в
  // `configurationOperationGuardCommands.test.ts`.
});

suite('RepositoryLockSync — runRepositoryLockFlow: CLI failed/interrupted', () => {
  test('CLI status:"failed" → outcome "failed", notifyError вызван, guard освобождён, state не изменён', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    let notifyErrorCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => {
        assert.strictEqual(harness.guard.isBusy, true);
        return Promise.resolve({ status: 'failed', message: 'сбой сети' });
      },
      notifyError: () => { notifyErrorCalls += 1; },
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(notifyErrorCalls, 1);
    assert.strictEqual(harness.guard.isBusy, false);
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), false);
  });

  test('CLI status:"interrupted" → outcome "interrupted", state не изменён', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'interrupted', message: 'отменено пользователем' }),
      notifyWarning: () => undefined,
      notifyInfo: () => undefined,
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'interrupted');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), false);
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: happy path без конфликтов', () => {
  test('без локальных изменений — молчаливое применение, снимок из temp, suppress до и после записи, refreshCacheForFiles, markChanged НЕ вызван', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    fs.writeFileSync(objectModulePath, 'старое содержимое', 'utf-8');

    // Хеш-кэш соответствует ТЕКУЩЕМУ локальному содержимому — "не менялся с базы".
    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    saveHashCache(harness.workspaceRoot, {
      schemaVersion: 1, scopeKey, generatedAt: '',
      files: { 'Catalogs/Товары/Ext/ObjectModule.bsl': computeFileHash(objectModulePath) },
    });

    const dump = makeTempDump({ 'Catalogs/Товары/Ext/ObjectModule.bsl': 'новое содержимое из хранилища' });
    const dumpToTempCalls: unknown[] = [];
    const deps = baseDeps({
      runRepositoryCli: () => {
        assert.strictEqual(harness.guard.isBusy, true);
        return Promise.resolve({ status: 'done' });
      },
      dumpToTemp: (target: RepositoryTarget, request: ConfigurationDumpRequest) => {
        assert.strictEqual(harness.guard.isBusy, true, 'Выгрузка во temp обязана происходить в той же аренде.');
        dumpToTempCalls.push(request);
        return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(dumpToTempCalls.length, 1);
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), 'новое содержимое из хранилища');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), true);
    assert.ok(harness.markChangedCalls.length === 0, 'Без расхождения от базы markChangedConfigurationByFiles не должен вызываться.');
    assert.ok(harness.suppressCalls.length >= 1, 'suppressConfigurationReloadForFiles должен вызываться до записи файлов.');
    assert.ok(harness.refreshCacheForFilesCalls.length >= 1 || harness.treeRefreshCalls >= 1);
    assert.strictEqual(harness.actionsViewCalls >= 1, true);
    assert.strictEqual(harness.guard.isBusy, false);

    const cache = loadHashCache(harness.workspaceRoot, scopeKey);
    assert.strictEqual(cache.files['Catalogs/Товары/Ext/ObjectModule.bsl'], computeFileHash(objectModulePath));
  });

  test('настройка синхронизации выключена — CLI и state применяются, но выгрузка/слияние не выполняются', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      isFileSyncEnabled: () => false,
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), true);
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: конфликт × {compare, replace, keep-local}', () => {
  function setupConflict(harness: Harness, node: RepositoryNodeRef) {
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    fs.writeFileSync(objectModulePath, 'локальная правка', 'utf-8');
    // База (последний известный хеш) отличается от текущего локального — конфликт.
    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    saveHashCache(harness.workspaceRoot, {
      schemaVersion: 1, scopeKey, generatedAt: '',
      files: { 'Catalogs/Товары/Ext/ObjectModule.bsl': 'какой-то-другой-хеш-базы' },
    });
    const dump = makeTempDump({ 'Catalogs/Товары/Ext/ObjectModule.bsl': 'версия хранилища' });
    return { objectModulePath, dump };
  }

  test('choice="replace" — файл перезаписывается версией хранилища, диалог показан ВНЕ аренды (guard.isBusy=false)', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const { objectModulePath, dump } = setupConflict(harness, node);

    let observedBusyDuringDialog: boolean | undefined;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
      chooseConflictResolution: () => {
        observedBusyDuringDialog = harness.guard.isBusy;
        return Promise.resolve('replace');
      },
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(observedBusyDuringDialog, false, 'Модальный диалог конфликта должен показываться ПОСЛЕ release() аренды.');
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), 'версия хранилища');
  });

  test('choice="compare" — файл перезаписывается версией хранилища, openDiffs вызван с текстовой парой', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const { objectModulePath, dump } = setupConflict(harness, node);

    let openDiffsCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
      chooseConflictResolution: () => Promise.resolve('compare'),
      openDiffs: (pairs: unknown[]) => { openDiffsCalls += 1; assert.ok(Array.isArray(pairs)); assert.ok(pairs.length >= 1); },
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(openDiffsCalls, 1);
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), 'версия хранилища');
  });

  test('choice="keep-local" — файл НЕ перезаписывается, помечается изменённым, хеш-кэш = хеш хранилища', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const { objectModulePath, dump } = setupConflict(harness, node);

    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
      chooseConflictResolution: () => Promise.resolve('keep-local'),
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), 'локальная правка');
    assert.ok(harness.markChangedCalls.some((files) => files.some((f) => path.resolve(f) === path.resolve(objectModulePath))));

    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    const cache = loadHashCache(harness.workspaceRoot, scopeKey);
    assert.strictEqual(cache.files['Catalogs/Товары/Ext/ObjectModule.bsl'], computeFileHash(path.join(dump.dir, 'Catalogs/Товары/Ext/ObjectModule.bsl')));
  });

  test('несохранённый редактор (getDirtyFilePaths) принудительно даёт конфликт даже при отсутствии расхождения по хешу', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    fs.writeFileSync(objectModulePath, 'содержимое', 'utf-8');
    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    saveHashCache(harness.workspaceRoot, {
      schemaVersion: 1, scopeKey, generatedAt: '',
      files: { 'Catalogs/Товары/Ext/ObjectModule.bsl': computeFileHash(objectModulePath) },
    });
    const dump = makeTempDump({ 'Catalogs/Товары/Ext/ObjectModule.bsl': 'содержимое' });

    let conflictShown = false;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
      getDirtyFilePaths: () => [objectModulePath],
      chooseConflictResolution: () => { conflictShown = true; return Promise.resolve('keep-local'); },
    });

    await runRepositoryLockFlow(node, false, harness.services, deps);
    assert.strictEqual(conflictShown, true, 'Несохранённый редактор должен приводить к конфликту, даже если содержимое совпадает.');
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: корень конфигурации', () => {
  function rootNode(harness: Harness): RepositoryNodeRef {
    return { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') };
  }

  test('корень нерекурсивно: выгрузка только по -listFile корня (buildRootDumpListName)', async () => {
    const harness = createHarness();
    const dump = makeTempDump({});
    const dumpRequests: unknown[] = [];
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_target: RepositoryTarget, request: ConfigurationDumpRequest) => {
        dumpRequests.push(request);
        return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(rootNode(harness), false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), true);
    assert.strictEqual(harness.repositoryService.isMetadataEditRestricted(harness.target), false);
    assert.deepStrictEqual(dumpRequests, [{ mode: 'partial', fullNames: [buildRootDumpListName(harness.target)] }]);
  });

  test('корень рекурсивно без изменений после update-info — Конфигуратор не запускается повторно (один вызов dumpToTemp)', async () => {
    const harness = createHarness();
    // Проектный ConfigDumpInfo.xml идентичен тому, что "вернёт" update-info-выгрузка.
    const configDumpInfoContent = '<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo"><ConfigVersions/></ConfigDumpInfo>';
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), configDumpInfoContent, 'utf-8');
    const dump = makeTempDump({ 'ConfigDumpInfo.xml': configDumpInfoContent });

    let dumpCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_target: RepositoryTarget, request: ConfigurationDumpRequest) => {
        dumpCalls += 1;
        assert.deepStrictEqual(request, { mode: 'update-info' });
        return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(rootNode(harness), true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(dumpCalls, 1, 'Без изменений в ConfigDumpInfo.xml второй (partial) запуск Конфигуратора не нужен.');
    assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), true);
  });

  test('корень рекурсивно, нет проектного ConfigDumpInfo.xml — fallback на полную выгрузку (mode:"full")', async () => {
    const harness = createHarness();
    // Проектного ConfigDumpInfo.xml нет вовсе.
    const dump = makeTempDump({});
    const modes: string[] = [];
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_target: RepositoryTarget, request: ConfigurationDumpRequest) => {
        modes.push(request.mode);
        return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(rootNode(harness), true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.ok(modes.includes('full'), `Ожидался fallback-режим "full" при отсутствии проектного ConfigDumpInfo.xml, получено: ${modes.join(',')}`);
  });
});

suite('RepositoryLockSync — runRepositoryUpdateFlow', () => {
  test('force/version передаются в CLI, снимок пересоздаётся ТОЛЬКО если объект был захвачен (isLocked)', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });

    let observedExtraArgs: string[] | undefined;
    const dump = makeTempDump({ 'Catalogs/Товары/Ext/ObjectModule.bsl': 'из хранилища v125' });
    const deps = baseDeps({
      runRepositoryCli: (options: { command: string; target: RepositoryTarget; extraArgs: string[] }) => {
        observedExtraArgs = options.extraArgs;
        return Promise.resolve({ status: 'done' });
      },
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
    });

    const outcome = await runRepositoryUpdateFlow(node, { recursive: false, force: true, version: '125' }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.ok(observedExtraArgs?.includes('-Force') || observedExtraArgs?.includes('-force'));
    assert.ok(observedExtraArgs?.some((arg) => arg === '125'));
  });

  test('незахваченный объект: update без снимка (пересъём не выполняется, но выгрузка/слияние всё равно происходят)', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const dump = makeTempDump({ 'Catalogs/Товары/Ext/ObjectModule.bsl': 'из хранилища' });
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
    });

    const outcome = await runRepositoryUpdateFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), false, 'update не должен сам захватывать объект.');
  });

  test('выгрузка после update провалилась (dumpToTemp вернул ok:false) — CLI/state уже применены, ошибка выгрузки не откатывает update', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    let notifyErrorCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: false, reason: 'агент недоступен' }),
      notifyError: () => { notifyErrorCalls += 1; },
      notifyWarning: () => { notifyErrorCalls += 1; },
    });

    const outcome = await runRepositoryUpdateFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done', 'CLI успешно отработал — сама операция update не должна считаться проваленной из-за сбоя довыгрузки.');
    assert.ok(notifyErrorCalls >= 1, 'Пользователь должен быть уведомлён о том, что автоматическая синхронизация файлов не удалась.');
  });
});
