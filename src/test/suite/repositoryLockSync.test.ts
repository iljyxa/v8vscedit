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
import { buildRootDumpListName } from '../../infra/repository/RepositoryObjectNames';
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
 *
 * Раздел 10 (подчинённые объекты с собственным XML, D1–D3): та же оговорка —
 * критерии приёмки 10.1.2/10.1.3/10.1.5/10.1.6/10.1.7 (оптимистичная выгрузка
 * подчинённых единиц раундами, root-incremental по единицам, D3 для рекурсивной
 * подсистемы) целиком зависят от НОВОГО внутреннего контракта между
 * `RepositoryLockSync` и `RepositoryDumpRounds`/`RepositoryDumpPlan.anchors`/
 * `expansion` (см. решение test-writer в `repositoryDumpPlan.test.ts` — форма
 * плана намеренно не зафиксирована синтетическим тестом заранее). Сами
 * строительные блоки (раскрытие подчинённых единиц, раунды, откат до якорей,
 * `MAX_DUMP_ROUNDS`, D1/D3 грамматика имён) уже покрыты ПОЛНОСТЬЮ и
 * параметризованно на уровне чистых функций: `repositoryObjectNames.test.ts`
 * (D1, D3, единицы), `repositoryDumpRounds.test.ts` (раунды, guard.isBusy,
 * оптимистичный список, откат до якорей, missing), `repositoryObjectScope.test.ts`
 * (`depth:'unit'`/`'tree'`, единицы в `resolveObjectScope`/`resolveUnitXmlRel`/
 * `resolveLockUnitByRelativePath`), `repositoryMergePlanner.test.ts` (регресс
 * D2b), `repositoryLockState.test.ts` (`lockModes`, правило старых записей),
 * `repositoryService.test.ts` (`isEditRestricted` по единицам, критерии
 * 10.1.3/10.1.9). Сквозная сборка этих блоков в наблюдаемое число вызовов
 * `dumpToTemp` для конкретных узлов (Контрагенты/Начисления/ИнтернетМагазин) —
 * предмет отдельного захода после того, как разработчик реализует конкретную
 * внутреннюю комбинацию (`RepositoryDumpPlan.buildRepositoryDumpPlan` →
 * `RepositoryLockSync.acquireObjectsDump` → `runDumpRounds`), а не до неё.
 * `partialDumpFixture` (`support/partialDumpFixture.ts`) — готовый детерминированный
 * дабл выгрузки для этих будущих сценариев, независимый от production-кода.
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
  // <Name> обязателен: resolveTargetByConfigRoot() читает реальное имя из
  // Configuration.xml (не из RepositoryTarget.displayName, задаваемого ниже
  // отдельно только для isLocked/isRootLocked-проверок) — без тега displayName
  // при резолве узла становится именем каталога ("cf"), а не "Тест".
  fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject><Name>Тест</Name></MetaDataObject>', 'utf-8');

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
  function setupConflict(harness: Harness) {
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
    const { objectModulePath, dump } = setupConflict(harness);

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
    const { objectModulePath, dump } = setupConflict(harness);

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
    const { objectModulePath, dump } = setupConflict(harness);
    // Хеш версии хранилища снимается ДО прогона потока: `runRepositoryLockFlow`
    // обязан удалить временный каталог выгрузки (`dispose()`) в finally, поэтому
    // после await-а каталога уже не существует.
    const repositoryHash = computeFileHash(path.join(dump.dir, 'Catalogs/Товары/Ext/ObjectModule.bsl'));

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
    assert.strictEqual(cache.files['Catalogs/Товары/Ext/ObjectModule.bsl'], repositoryHash);
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
    assert.ok(observedExtraArgs?.includes('-Force') ?? observedExtraArgs?.includes('-force'));
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

suite('RepositoryLockSync — runRepositoryLockFlow: узел без валидной цели', () => {
  test('xmlPath не резолвится в корень конфигурации — outcome "failed", state не меняется', async () => {
    const harness = createHarness();
    const node: RepositoryNodeRef = {
      nodeKind: 'Catalog',
      label: 'Товары',
      xmlPath: path.join(harness.workspaceRoot, 'нет-такого-каталога', 'Товары.xml'),
    };
    let notifyErrorCalls = 0;
    const deps = baseDeps({ notifyError: () => { notifyErrorCalls += 1; } });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(notifyErrorCalls, 1);
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: узел без label и сбой внутри аренды', () => {
  test('node.label не задан — fullName резолвится из <Name> XML объекта, метка операции берётся из target.displayName', async () => {
    const harness = createHarness();
    // Без node.label resolveFullName() падает обратно на <Name> из самого XML объекта
    // (RepositoryService.buildRootObjectFullName) — простая заглушка '<MetaDataObject/>'
    // без <Name> для этого сценария не годится.
    const xmlPath = path.join(harness.configRoot, 'Catalogs', 'Товары.xml');
    fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
    fs.writeFileSync(xmlPath, '<MetaDataObject><Catalog><Properties><Name>Товары</Name></Properties></Catalog></MetaDataObject>', 'utf-8');
    const node: RepositoryNodeRef = { nodeKind: 'Catalog', xmlPath };
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }), isFileSyncEnabled: () => false });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Товары'), true);
  });

  test('runRepositoryCli бросает исключение внутри аренды — reportFlowError, outcome "failed", guard освобождён', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    let notifyErrorCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => { throw new Error('сбой процесса'); },
      notifyError: () => { notifyErrorCalls += 1; },
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(notifyErrorCalls, 1);
    assert.strictEqual(harness.guard.isBusy, false);
    assert.ok(harness.outputLines.some((line) => line.includes('[repository][file-sync][error]') && line.includes('сбой процесса')));
  });

  test('completeFetchSync бросает исключение (chooseConflictResolution упал) — outcome всё равно "done" (захват уже состоялся)', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Товары');
    const { objectModulePath, dump } = setupConflict(harness);
    let notifyErrorCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
      chooseConflictResolution: () => { throw new Error('диалог упал'); },
      notifyError: () => { notifyErrorCalls += 1; },
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done', 'захват (CLI+state) уже состоялся — сбой синхронизации файлов его не отменяет.');
    assert.strictEqual(notifyErrorCalls, 1);
    assert.ok(harness.outputLines.some((line) => line.includes('синхронизация файлов') && line.includes('диалог упал')));
    assert.strictEqual(fs.readFileSync(objectModulePath, 'utf-8'), 'локальная правка', 'слияние не должно было применяться при сбое диалога.');
  });
});

function setupConflict(harness: Harness) {
  const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
  fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
  fs.writeFileSync(objectModulePath, 'локальная правка', 'utf-8');
  const scopeKey = buildScopeKey('cf', harness.configRoot, '');
  saveHashCache(harness.workspaceRoot, {
    schemaVersion: 1, scopeKey, generatedAt: '',
    files: { 'Catalogs/Товары/Ext/ObjectModule.bsl': 'какой-то-другой-хеш-базы' },
  });
  const dump = makeTempDump({ 'Catalogs/Товары/Ext/ObjectModule.bsl': 'версия хранилища' });
  return { objectModulePath, dump };
}

function buildSubsystemXml(name: string, refs: string[], childSubsystems: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MetaDataObject>
  <Subsystem>
    <Properties>
      <Name>${name}</Name>
      <Synonym/>
      ${refs.length > 0
        ? `<Content>${refs.map((ref) => `<xr:Item xsi:type="xr:MDObjectRef">${ref}</xr:Item>`).join('')}</Content>`
        : '<Content/>'}
    </Properties>
    ${childSubsystems.length > 0
      ? `<ChildObjects>${childSubsystems.map((child) => `<Subsystem>${child}</Subsystem>`).join('')}</ChildObjects>`
      : '<ChildObjects/>'}
  </Subsystem>
</MetaDataObject>`;
}

function subsystemNode(harness: Harness, name: string): RepositoryNodeRef {
  const xmlPath = path.join(harness.configRoot, 'Subsystems', `${name}.xml`);
  return { nodeKind: 'Subsystem', label: name, xmlPath };
}

suite('RepositoryLockSync — runRepositoryLockFlow: рекурсивная подсистема — довыгрузка недостающих участников', () => {
  test('несколько раундов довыгрузки до неподвижной точки: новый объект найден в раунде 1, раунд 2 ничего не находит — 2 вызова dumpToTemp', async () => {
    const harness = createHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', ['Catalog.Товары'], []),
      'utf-8'
    );
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Товары.xml'), '<MetaDataObject/>', 'utf-8');

    let calls = 0;
    // Версия хранилища подсистемы (Subsystems/Продажи.xml) отличается от локальной —
    // это законный конфликт по её СОБСТВЕННОМУ XML (без хеш-кэша нет способа отличить
    // «локально не менялось» от «изменилось»), поэтому choice="replace" — принять версию
    // хранилища (в проекте правок не было, сценарий проверяет сам механизм довыгрузки).
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      chooseConflictResolution: () => Promise.resolve('replace'),
      dumpToTemp: () => {
        calls += 1;
        if (calls === 1) {
          // Первая (основная) выгрузка подсистемы: сервер уже содержит новый объект "Новый",
          // ещё не известный локальному проекту.
          const dump = makeTempDump({
            'Subsystems/Продажи.xml': buildSubsystemXml('Продажи', ['Catalog.Товары', 'Catalog.Новый'], []),
            'Catalogs/Товары.xml': '<MetaDataObject/>',
          });
          return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
        }
        // Раунд довыгрузки: приходит только сам новый объект, без обновлённой подсистемы —
        // следующий раунд не найдёт в нём ничего нового и завершит цикл.
        const dump = makeTempDump({ 'Catalogs/Новый.xml': '<MetaDataObject/>' });
        return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(subsystemNode(harness, 'Продажи'), true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(calls, 2, 'основная выгрузка + ровно один продуктивный раунд довыгрузки.');
    assert.strictEqual(fs.existsSync(path.join(harness.configRoot, 'Catalogs', 'Новый.xml')), true, 'найденный довыгрузкой объект должен быть слит в проект.');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Новый'), true, 'найденный довыгрузкой участник должен попасть в состав захвата.');
  });

  test('лимит 5 раундов: участники находятся бесконечной цепочкой — довыгрузка останавливается ровно на 4-м раунде', async () => {
    const harness = createHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', ['Catalog.Товары'], []),
      'utf-8'
    );
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Товары.xml'), '<MetaDataObject/>', 'utf-8');

    let calls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      // Собственный XML подсистемы каждый раунд отличается от локального — законный
      // конфликт без хеш-кэша; "replace" принимает версию хранилища.
      chooseConflictResolution: () => Promise.resolve('replace'),
      dumpToTemp: () => {
        calls += 1;
        if (calls === 1) {
          const dump = makeTempDump({
            'Subsystems/Продажи.xml': buildSubsystemXml('Продажи', ['Catalog.Товары', 'Catalog.New1'], []),
            'Catalogs/Товары.xml': '<MetaDataObject/>',
          });
          return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
        }
        // Каждый раунд «сервер» вдобавок сообщает об ОДНОМ ещё более новом участнике —
        // патологический, но допустимый с т.з. интерфейса ответ, которым проверяется
        // защитный предел MAX_SUBSYSTEM_DUMP_ROUNDS (иначе цикл был бы бесконечным.
        const round = calls - 1;
        const refs = ['Catalog.Товары', ...Array.from({ length: round + 1 }, (_v, i) => `Catalog.New${String(i + 1)}`)];
        const dump = makeTempDump({
          [`Catalogs/New${String(round)}.xml`]: '<MetaDataObject/>',
          'Subsystems/Продажи.xml': buildSubsystemXml('Продажи', refs, []),
        });
        return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(subsystemNode(harness, 'Продажи'), true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(calls, 5, 'основная выгрузка + ровно 4 раунда (MAX_SUBSYSTEM_DUMP_ROUNDS-1) — дальше цикл обязан остановиться.');
    ['New1', 'New2', 'New3', 'New4'].forEach((name) => {
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, `Справочник.${name}`), true, `${name} должен быть найден в пределах лимита раундов.`);
      assert.strictEqual(fs.existsSync(path.join(harness.configRoot, 'Catalogs', `${name}.xml`)), true, `${name} должен быть слит в проект.`);
    });
  });

  test('раунд довыгрузки провалился — цикл останавливается с предупреждением в журнале, ранее найденное сохраняется', async () => {
    const harness = createHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', ['Catalog.Товары'], []),
      'utf-8'
    );
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Товары.xml'), '<MetaDataObject/>', 'utf-8');

    let calls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      chooseConflictResolution: () => Promise.resolve('replace'),
      dumpToTemp: () => {
        calls += 1;
        if (calls === 1) {
          const dump = makeTempDump({
            'Subsystems/Продажи.xml': buildSubsystemXml('Продажи', ['Catalog.Товары', 'Catalog.New1'], []),
            'Catalogs/Товары.xml': '<MetaDataObject/>',
          });
          return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
        }
        if (calls === 2) {
          // Раунд 1 успешен и сообщает ещё об одном новом участнике — иначе цикл
          // остановился бы после первого же раунда и сбой довыгрузки не был бы достигнут.
          const dump = makeTempDump({
            'Catalogs/New1.xml': '<MetaDataObject/>',
            'Subsystems/Продажи.xml': buildSubsystemXml('Продажи', ['Catalog.Товары', 'Catalog.New1', 'Catalog.New2'], []),
          });
          return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
        }
        // Раунд 2 — сбой выгрузки.
        return Promise.resolve({ ok: false, reason: 'сеть недоступна' });
      },
    });

    const outcome = await runRepositoryLockFlow(subsystemNode(harness, 'Продажи'), true, harness.services, deps);

    assert.strictEqual(outcome, 'done', 'сбой довыгрузки НЕ отменяет уже выполненный захват.');
    assert.strictEqual(calls, 3, 'основная выгрузка + успешный раунд 1 + провалившийся раунд 2.');
    assert.ok(
      harness.outputLines.some((line) => line.includes('довыгрузка участников подсистемы не удалась') && line.includes('сеть недоступна')),
      'должен быть залогирован факт сбоя довыгрузки.'
    );
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.New1'), true, 'участник, найденный до сбоя, остаётся в составе захвата.');
    assert.strictEqual(fs.existsSync(path.join(harness.configRoot, 'Catalogs', 'New1.xml')), true, 'участник, найденный до сбоя, должен быть слит в проект.');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.New2'), false, 'участник, обнаруженный только в провалившемся раунде, не может быть довыгружен.');
  });

  test('вложенная дочерняя подсистема: собственная область НЕ мержится отдельно (её файлы уже покрыты областью корневой подсистемы)', async () => {
    const harness = createHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', ['Catalog.Товары'], ['Розница']),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница', 'Розница.xml'),
      buildSubsystemXml('Розница', ['Document.ЗаказПокупателя'], []),
      'utf-8'
    );
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Товары.xml'), '<MetaDataObject/>', 'utf-8');
    fs.mkdirSync(path.join(harness.configRoot, 'Documents', 'ЗаказПокупателя'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Documents', 'ЗаказПокупателя', 'ЗаказПокупателя.xml'),
      '<MetaDataObject/>',
      'utf-8'
    );

    const dump = makeTempDump({
      'Subsystems/Продажи.xml': buildSubsystemXml('Продажи', ['Catalog.Товары'], ['Розница']),
      'Subsystems/Продажи/Subsystems/Розница/Розница.xml': buildSubsystemXml('Розница', ['Document.ЗаказПокупателя'], []),
      'Catalogs/Товары.xml': '<MetaDataObject/>',
      'Documents/ЗаказПокупателя/ЗаказПокупателя.xml': '<MetaDataObject/>',
    });
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
    });

    const outcome = await runRepositoryLockFlow(subsystemNode(harness, 'Продажи'), true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.ok(
      !harness.outputLines.some((line) => line.includes('область файлов не определена') && line.includes('Розница')),
      'дочерняя подсистема пропускается через isNestedSubsystemMember ДО попытки резолва области, а не из-за ошибки резолва.'
    );
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Подсистема.Розница'), true, 'состав захвата (state) всё равно включает дочернюю подсистему.');
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: область объекта не определена', () => {
  test('fullName узла не резолвится ни в проекте, ни в выгрузке — лог, объект пропущен, остальной поток не ломается', async () => {
    const harness = createHarness();
    // xmlPath указывает на РЕАЛЬНЫЙ существующий файл (чтобы резолвился корень конфигурации),
    // но label подставлен так, что итоговый fullName не соответствует никакому реальному объекту.
    const real = catalogNode(harness, 'РеальныйОбъект');
    const node: RepositoryNodeRef = { nodeKind: 'Catalog', label: 'НесуществующийОбъект', xmlPath: real.xmlPath };
    const dump = makeTempDump({});
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.ok(harness.outputLines.some((line) => line.includes('область файлов не определена') && line.includes('НесуществующийОбъект')));
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: корень рекурсивно — режим "partial" (изменённые/добавленные/удалённые владельцы)', () => {
  function configDumpInfoXml(entries: { name: string; version: string }[]): string {
    const items = entries.map((entry) => `<Metadata name="${entry.name}" id="${entry.name}-id" configVersion="${entry.version}"/>`).join('');
    return `<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo">${items}</ConfigDumpInfo>`;
  }

  test('изменён один владелец (доля ниже порога) — частичная выгрузка ровно по нему, ConfigDumpInfo.xml заменён', async () => {
    const harness = createHarness();
    // Ещё 3 "молчаливых" владельца нужны только для знаменателя decideRootIncrementalStrategy
    // (доля изменений должна остаться <=50%, иначе стратегия перейдёт на "full").
    const projectInfo = configDumpInfoXml([
      { name: 'Catalog.Изменяемый.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий1.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий2.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий3.ObjectModule', version: '1' },
    ]);
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), projectInfo, 'utf-8');
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Изменяемый.xml'), '<MetaDataObject>старое</MetaDataObject>', 'utf-8');

    const nextInfo = configDumpInfoXml([
      { name: 'Catalog.Изменяемый.ObjectModule', version: '2' },
      { name: 'Catalog.Тихий1.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий2.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий3.ObjectModule', version: '1' },
    ]);
    const infoDump = makeTempDump({ 'ConfigDumpInfo.xml': nextInfo });
    const partialDump = makeTempDump({ 'Catalogs/Изменяемый.xml': '<MetaDataObject>новое из хранилища</MetaDataObject>' });

    const requests: ConfigurationDumpRequest[] = [];
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      // Локальная копия объекта отличается от версии хранилища и хеш-кэш пуст — законный
      // конфликт по правилам трёхстороннего слияния; "replace" принимает версию хранилища.
      chooseConflictResolution: () => Promise.resolve('replace'),
      dumpToTemp: (_target, request) => {
        requests.push(request);
        return Promise.resolve(request.mode === 'update-info'
          ? { ok: true, dir: infoDump.dir, dispose: infoDump.dispose }
          : { ok: true, dir: partialDump.dir, dispose: partialDump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      true,
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(requests.map((r) => r.mode), ['update-info', 'partial']);
    assert.deepStrictEqual(requests[1], { mode: 'partial', fullNames: ['Справочник.Изменяемый'] });
    assert.strictEqual(fs.readFileSync(path.join(harness.configRoot, 'Catalogs', 'Изменяемый.xml'), 'utf-8'), '<MetaDataObject>новое из хранилища</MetaDataObject>');
    assert.strictEqual(fs.readFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), 'utf-8'), nextInfo, 'проектный ConfigDumpInfo.xml обязан замениться версией из выгрузки.');
    assert.strictEqual(harness.repositoryService.isRootLocked(harness.target), true);
  });

  test('добавленный владелец → ChildObjects Configuration.xml пополняется; неопознанный владелец в diff — пропускается с логом', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-root-added-'));
    try {
      fs.cpSync(path.resolve(__dirname, '../../../example/2.21/src/cf'), tempRoot, { recursive: true });
      const guard = new ConfigurationOperationGuard();
      const outputLines: string[] = [];
      const suppressCalls: string[][] = [];
      const markChangedCalls: string[][] = [];
      let reloadCalls = 0;
      const workspaceRootForTarget = tempRoot;
      const repositoryService = new RepositoryService(workspaceRootForTarget, new ProjectSecretStorage(createFakeSecretStore(), workspaceRootForTarget));
      const target = repositoryService.resolveTargetByConfigRoot(tempRoot);
      assert.ok(target, 'предпосылка: реальная фикстура example/2.21/src/cf должна резолвиться в target.');
      const services: RepositoryFileSyncServices = {
        configurationOperationGuard: guard,
        workspaceFolder: { uri: vscode.Uri.file(workspaceRootForTarget), name: 'test', index: 0 },
        outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
        repositoryService,
        projectSecretStorage: {} as unknown as RepositoryFileSyncServices['projectSecretStorage'],
        supportService: undefined,
        suppressConfigurationReloadForFiles: (files: string[]) => suppressCalls.push(files),
        markChangedConfigurationByFiles: (files: string[]) => markChangedCalls.push(files),
        treeProvider: { refresh: () => undefined, refreshCacheForFiles: () => true } as unknown as MetadataTreeProvider,
        refreshActionsView: () => undefined,
        reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
      };

      const projectConfigDumpInfo = fs.readFileSync(path.join(tempRoot, 'ConfigDumpInfo.xml'), 'utf-8');
      // "Неопознанный" владелец — префикс, которого нет в таблице соответствия типов,
      // проверяет ветку toFullName(...)===null (лог и фильтрация, а не исключение).
      const nextConfigDumpInfo = projectConfigDumpInfo.replace('</ConfigDumpInfo>', '') +
        '<Metadata name="Catalog.НовыйКорневойСправочник.ObjectModule" id="new-id" configVersion="1"/>' +
        '<Metadata name="НеизвестныйПрефикс.Что-то.ObjectModule" id="unknown-id" configVersion="1"/>' +
        '</ConfigDumpInfo>';
      const infoDump = makeTempDump({ 'ConfigDumpInfo.xml': nextConfigDumpInfo });
      const partialDump = makeTempDump({ 'Catalogs/НовыйКорневойСправочник.xml': '<MetaDataObject/>' });

      const deps = baseDeps({
        runRepositoryCli: () => Promise.resolve({ status: 'done' }),
        dumpToTemp: (_t, request) => Promise.resolve(request.mode === 'update-info'
          ? { ok: true, dir: infoDump.dir, dispose: infoDump.dispose }
          : { ok: true, dir: partialDump.dir, dispose: partialDump.dispose }),
      });

      const outcome = await runRepositoryLockFlow(
        { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(tempRoot, 'Configuration.xml') },
        true,
        services,
        deps
      );

      assert.strictEqual(outcome, 'done');
      assert.strictEqual(fs.existsSync(path.join(tempRoot, 'Catalogs', 'НовыйКорневойСправочник.xml')), true);
      const configXmlText = fs.readFileSync(path.join(tempRoot, 'Configuration.xml'), 'utf-8');
      assert.ok(configXmlText.includes('<Catalog>НовыйКорневойСправочник</Catalog>'), 'новый владелец должен появиться в ChildObjects Configuration.xml.');
      assert.ok(
        outputLines.some((line) => line.includes('владелец') && line.includes('не распознан') && line.includes('НеизвестныйПрефикс')),
        'нераспознанный владелец из diff обязан быть залогирован, а не привести к исключению.'
      );
      assert.strictEqual(reloadCalls, 1, 'структурное изменение (новый ChildObjects) требует полного reloadEntries.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('частичная выгрузка изменённых владельцев провалилась — outcome "done" (захват уже состоялся), лог сбоя', async () => {
    const harness = createHarness();
    const projectInfo = '<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo">' +
      '<Metadata name="Catalog.Изменяемый.ObjectModule" id="a" configVersion="1"/>' +
      '<Metadata name="Catalog.Тихий1.ObjectModule" id="b" configVersion="1"/>' +
      '<Metadata name="Catalog.Тихий2.ObjectModule" id="c" configVersion="1"/>' +
      '<Metadata name="Catalog.Тихий3.ObjectModule" id="d" configVersion="1"/>' +
      '</ConfigDumpInfo>';
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), projectInfo, 'utf-8');
    const nextInfo = projectInfo.replace('configVersion="1"/>\n    <Metadata name="Catalog.Тихий1', 'configVersion="2"/><Metadata name="Catalog.Тихий1')
      .replace('name="Catalog.Изменяемый.ObjectModule" id="a" configVersion="1"', 'name="Catalog.Изменяемый.ObjectModule" id="a" configVersion="2"');
    const infoDump = makeTempDump({ 'ConfigDumpInfo.xml': nextInfo });
    let partialCalls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_t, request) => {
        if (request.mode === 'update-info') {
          return Promise.resolve({ ok: true, dir: infoDump.dir, dispose: infoDump.dispose });
        }
        partialCalls += 1;
        return Promise.resolve({ ok: false, reason: 'сервер хранилища недоступен' });
      },
    });

    const outcome = await runRepositoryLockFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      true,
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done', 'сама операция захвата корня уже выполнена CLI-командой — сбой довыгрузки объектов её не отменяет.');
    assert.strictEqual(partialCalls, 1);
    assert.ok(harness.outputLines.some((line) => line.includes('сервер хранилища недоступен')));
  });

  test('сбой выгрузки update-info (ConfigDumpInfo.xml) — fallback на full, лог причины', async () => {
    const harness = createHarness();
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), configDumpInfoXml([{ name: 'Catalog.А.ObjectModule', version: '1' }]), 'utf-8');
    const fullDump = makeTempDump({});
    const modes: string[] = [];
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_t, request) => {
        modes.push(request.mode);
        if (request.mode === 'update-info') {
          return Promise.resolve({ ok: false, reason: 'сеть недоступна' });
        }
        return Promise.resolve({ ok: true, dir: fullDump.dir, dispose: fullDump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      true,
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(modes, ['update-info', 'full']);
    assert.ok(harness.outputLines.some((line) => line.includes('сбой выгрузки ConfigDumpInfo.xml') && line.includes('сеть недоступна')));
  });

  test('новый ConfigDumpInfo.xml из базы не разбирается (пуст при непустом проектном) — fallback на full', async () => {
    const harness = createHarness();
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), configDumpInfoXml([{ name: 'Catalog.А.ObjectModule', version: '1' }]), 'utf-8');
    const infoDump = makeTempDump({ 'ConfigDumpInfo.xml': 'битый-не-xml' });
    const fullDump = makeTempDump({});
    const modes: string[] = [];
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_t, request) => {
        modes.push(request.mode);
        return Promise.resolve(request.mode === 'update-info'
          ? { ok: true, dir: infoDump.dir, dispose: infoDump.dispose }
          : { ok: true, dir: fullDump.dir, dispose: fullDump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      true,
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(modes, ['update-info', 'full']);
    assert.ok(harness.outputLines.some((line) => line.includes('ConfigDumpInfo.xml из базы не разобран')));
  });

  test('доля изменённых владельцев выше порога — fallback на full; сбой полной выгрузки — outcome "done" (захват уже состоялся)', async () => {
    const harness = createHarness();
    // Единственный владелец в проекте и в базе — доля изменений 100% (> 50%), даже без превышения абсолютного порога.
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), configDumpInfoXml([{ name: 'Catalog.А.ObjectModule', version: '1' }]), 'utf-8');
    const infoDump = makeTempDump({ 'ConfigDumpInfo.xml': configDumpInfoXml([{ name: 'Catalog.А.ObjectModule', version: '2' }]) });
    const modes: string[] = [];
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: (_t, request) => {
        modes.push(request.mode);
        if (request.mode === 'update-info') {
          return Promise.resolve({ ok: true, dir: infoDump.dir, dispose: infoDump.dispose });
        }
        // Fallback-выгрузка (full) тоже проваливается — сама операция захвата уже состоялась.
        return Promise.resolve({ ok: false, reason: 'диск переполнен' });
      },
    });

    const outcome = await runRepositoryLockFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      true,
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(modes, ['update-info', 'full']);
    assert.ok(harness.outputLines.some((line) => line.includes('изменено владельцев больше порога')));
    assert.ok(harness.outputLines.some((line) => line.includes('диск переполнен')));
  });
});
