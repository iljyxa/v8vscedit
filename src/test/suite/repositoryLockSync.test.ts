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
import { buildRootDumpListName, getRootLockName, subordinateUnitFullName } from '../../infra/repository/RepositoryObjectNames';
import { MAX_DUMP_ROUNDS } from '../../infra/repository/RepositoryDumpRounds';
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

/** Корень реальной выгрузки-эталона (см. CLAUDE.md TDD п.3 — только реальные фикстуры). */
const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

/**
 * Рабочая область — РЕАЛЬНАЯ копия `example/2.21/src/cf` (displayName в
 * Configuration.xml — «ТорговыйУчет»). Тесты используют реальный `Справочник.Валюты`
 * (плоский XML, `Ext/ObjectModule.bsl`, без подчинённых с собственным XML) как
 * простой объект для happy-path/конфликтных сценариев, не завязанных на состав
 * подчинённых единиц.
 */
function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.cpSync(EXAMPLE_CF, configRoot, { recursive: true });
  return buildHarnessAround(workspaceRoot, configRoot, 'ТорговыйУчет');
}

/**
 * ВРЕМЕННАЯ СИНТЕТИКА (issue #1, раздел 10.7, фикстура F1 — issue #48 форка):
 * реальной фикстуры вложенных подсистем (`Подсистема.A.Подсистема.B`) в `example/`
 * ещё нет — её должен добавить пользователь через Конфигуратор. До появления F1
 * механика раундов довыгрузки рекурсивной подсистемы (участники `<Content>`,
 * вложенные `<ChildObjects>`, предел `MAX_DUMP_ROUNDS`, D3-имя вложенной
 * подсистемы) проверяется на минимальном синтетическом дереве
 * подсистем/справочников — единственное узкое место, где правило «только
 * реальные фикстуры» временно не соблюдается (см. отчёт test-writer).
 */
function createSyntheticSubsystemHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-synthetic-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(configRoot, { recursive: true });
  // <Name> обязателен: resolveTargetByConfigRoot() читает реальное имя из
  // Configuration.xml (не из RepositoryTarget.displayName, задаваемого ниже
  // отдельно только для isLocked/isRootLocked-проверок) — без тега displayName
  // при резолве узла становится именем каталога ("cf"), а не "Тест".
  fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject><Name>Тест</Name></MetaDataObject>', 'utf-8');
  return buildHarnessAround(workspaceRoot, configRoot, 'Тест');
}

function buildHarnessAround(workspaceRoot: string, configRoot: string, displayName: string): Harness {
  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName };
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

/** Узел РЕАЛЬНОГО справочника фикстуры (по умолчанию — 'Валюты', см. createHarness). */
function catalogNode(harness: Harness, objectName: string): RepositoryNodeRef {
  const xmlPath = path.join(harness.configRoot, 'Catalogs', `${objectName}.xml`);
  assert.ok(fs.existsSync(xmlPath), `ожидался реальный объект фикстуры Catalogs/${objectName}.xml`);
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
    const node = catalogNode(harness, 'Валюты');
    const lease = harness.guard.tryAcquire('Синхронизация с хранилищем');
    const deps = baseDeps();

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'busy');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Валюты'), false);
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
    const node = catalogNode(harness, 'Валюты');
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
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Валюты'), false);
  });

  test('CLI status:"interrupted" → outcome "interrupted", state не изменён', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Валюты');
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'interrupted', message: 'отменено пользователем' }),
      notifyWarning: () => undefined,
      notifyInfo: () => undefined,
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'interrupted');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Валюты'), false);
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: happy path без конфликтов', () => {
  test('без локальных изменений — молчаливое применение, снимок из temp, suppress до и после записи, refreshCacheForFiles, markChanged НЕ вызван', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Валюты');
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Валюты', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    fs.writeFileSync(objectModulePath, 'старое содержимое', 'utf-8');

    // Хеш-кэш соответствует ТЕКУЩЕМУ локальному содержимому — "не менялся с базы".
    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    saveHashCache(harness.workspaceRoot, {
      schemaVersion: 1, scopeKey, generatedAt: '',
      files: { 'Catalogs/Валюты/Ext/ObjectModule.bsl': computeFileHash(objectModulePath) },
    });

    const dump = makeTempDump({ 'Catalogs/Валюты/Ext/ObjectModule.bsl': 'новое содержимое из хранилища' });
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
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Валюты'), true);
    assert.ok(harness.markChangedCalls.length === 0, 'Без расхождения от базы markChangedConfigurationByFiles не должен вызываться.');
    assert.ok(harness.suppressCalls.length >= 1, 'suppressConfigurationReloadForFiles должен вызываться до записи файлов.');
    assert.ok(harness.refreshCacheForFilesCalls.length >= 1 || harness.treeRefreshCalls >= 1);
    assert.strictEqual(harness.actionsViewCalls >= 1, true);
    assert.strictEqual(harness.guard.isBusy, false);

    const cache = loadHashCache(harness.workspaceRoot, scopeKey);
    assert.strictEqual(cache.files['Catalogs/Валюты/Ext/ObjectModule.bsl'], computeFileHash(objectModulePath));
  });

  test('настройка синхронизации выключена — CLI и state применяются, но выгрузка/слияние не выполняются', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Валюты');
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      isFileSyncEnabled: () => false,
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Валюты'), true);
  });
});

// `setupConflict` — общая функция уровня модуля, объявлена ниже (hoisting).
suite('RepositoryLockSync — runRepositoryLockFlow: конфликт × {compare, replace, keep-local}', () => {
  test('choice="replace" — файл перезаписывается версией хранилища, диалог показан ВНЕ аренды (guard.isBusy=false)', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Валюты');
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
    const node = catalogNode(harness, 'Валюты');
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
    const node = catalogNode(harness, 'Валюты');
    const { objectModulePath, dump } = setupConflict(harness);
    // Хеш версии хранилища снимается ДО прогона потока: `runRepositoryLockFlow`
    // обязан удалить временный каталог выгрузки (`dispose()`) в finally, поэтому
    // после await-а каталога уже не существует.
    const repositoryHash = computeFileHash(path.join(dump.dir, 'Catalogs/Валюты/Ext/ObjectModule.bsl'));

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
    assert.strictEqual(cache.files['Catalogs/Валюты/Ext/ObjectModule.bsl'], repositoryHash);
  });

  test('несохранённый редактор (getDirtyFilePaths) принудительно даёт конфликт даже при отсутствии расхождения по хешу', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Валюты');
    const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Валюты', 'Ext', 'ObjectModule.bsl');
    fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
    fs.writeFileSync(objectModulePath, 'содержимое', 'utf-8');
    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    saveHashCache(harness.workspaceRoot, {
      schemaVersion: 1, scopeKey, generatedAt: '',
      files: { 'Catalogs/Валюты/Ext/ObjectModule.bsl': computeFileHash(objectModulePath) },
    });
    const dump = makeTempDump({ 'Catalogs/Валюты/Ext/ObjectModule.bsl': 'содержимое' });

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
    const node = catalogNode(harness, 'Валюты');
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Валюты', members: ['Справочник.Валюты'] });

    let observedExtraArgs: string[] | undefined;
    const dump = makeTempDump({ 'Catalogs/Валюты/Ext/ObjectModule.bsl': 'из хранилища v125' });
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
    const node = catalogNode(harness, 'Валюты');
    const dump = makeTempDump({ 'Catalogs/Валюты/Ext/ObjectModule.bsl': 'из хранилища' });
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
    });

    const outcome = await runRepositoryUpdateFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Валюты'), false, 'update не должен сам захватывать объект.');
  });

  test('выгрузка после update провалилась (dumpToTemp вернул ok:false) — CLI/state уже применены, ошибка выгрузки не откатывает update', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Валюты');
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
      label: 'Валюты',
      xmlPath: path.join(harness.workspaceRoot, 'нет-такого-каталога', 'Валюты.xml'),
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
    // (RepositoryService.buildRootObjectFullName) — реальный Catalogs/Валюты.xml фикстуры
    // содержит настоящий <Catalog><Properties><Name>Валюты</Name>, синтетический XML не нужен.
    const xmlPath = path.join(harness.configRoot, 'Catalogs', 'Валюты.xml');
    const node: RepositoryNodeRef = { nodeKind: 'Catalog', xmlPath };
    const deps = baseDeps({ runRepositoryCli: () => Promise.resolve({ status: 'done' }), isFileSyncEnabled: () => false });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Валюты'), true);
  });

  test('runRepositoryCli бросает исключение внутри аренды — reportFlowError, outcome "failed", guard освобождён', async () => {
    const harness = createHarness();
    const node = catalogNode(harness, 'Валюты');
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
    const node = catalogNode(harness, 'Валюты');
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
  const objectModulePath = path.join(harness.configRoot, 'Catalogs', 'Валюты', 'Ext', 'ObjectModule.bsl');
  fs.mkdirSync(path.dirname(objectModulePath), { recursive: true });
  fs.writeFileSync(objectModulePath, 'локальная правка', 'utf-8');
  const scopeKey = buildScopeKey('cf', harness.configRoot, '');
  saveHashCache(harness.workspaceRoot, {
    schemaVersion: 1, scopeKey, generatedAt: '',
    files: { 'Catalogs/Валюты/Ext/ObjectModule.bsl': 'какой-то-другой-хеш-базы' },
  });
  const dump = makeTempDump({ 'Catalogs/Валюты/Ext/ObjectModule.bsl': 'версия хранилища' });
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

// временно синтетика: ждёт фикстуру F1 (issue #48) — заменить на реальную вложенную подсистему
suite('RepositoryLockSync — runRepositoryLockFlow: рекурсивная подсистема — довыгрузка недостающих участников (временно синтетика: ждёт фикстуру F1, issue #48)', () => {
  test('несколько раундов довыгрузки до неподвижной точки: новый объект найден в раунде 1, раунд 2 ничего не находит — 2 вызова dumpToTemp', async () => {
    const harness = createSyntheticSubsystemHarness();
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

  /**
   * Р4.3: раунд N+1 раскрывается ТОЛЬКО по XML единиц, найденных именно в раунде N
   * (из каталога ЭТОГО раунда), а не повторным перечитыванием owner'а — поэтому
   * бесконечная цепочка строится не через повторные Content подсистемы-владельца
   * (как было раньше), а через цепочку ВЛОЖЕННЫХ подсистем: XML каждого уровня,
   * попавший в раунд, ссылается на следующий уровень в СВОИХ ChildObjects.
   */
  function nestedSubsystemXmlRel(chain: readonly string[]): string {
    const tail = chain.slice(1).flatMap((name) => ['Subsystems', name]);
    return `${['Subsystems', chain[0], ...tail].join('/')}/${chain[chain.length - 1]}.xml`;
  }

  test(`лимит ${String(MAX_DUMP_ROUNDS)} раундов: цепочка вложенных подсистем длиннее лимита — довыгрузка останавливается на границе`, async () => {
    const harness = createSyntheticSubsystemHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', ['Catalog.Товары'], []),
      'utf-8'
    );
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Товары.xml'), '<MetaDataObject/>', 'utf-8');

    // Уровней в цепочке заведомо больше лимита раундов, чтобы дойти до обрыва.
    const levels = Array.from({ length: MAX_DUMP_ROUNDS + 1 }, (_v, i) => `Level${String(i + 1)}`);
    let calls = 0;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      // Собственный XML корневой подсистемы отличается от локального (в ChildObjects
      // появляется первый уровень цепочки) — законный конфликт без хеш-кэша.
      chooseConflictResolution: () => Promise.resolve('replace'),
      dumpToTemp: () => {
        calls += 1;
        if (calls === 1) {
          const dump = makeTempDump({
            'Subsystems/Продажи.xml': buildSubsystemXml('Продажи', ['Catalog.Товары'], [levels[0]]),
            'Catalogs/Товары.xml': '<MetaDataObject/>',
          });
          return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
        }
        // Раунд K находит уровень levels[K-1] и сразу выгружает его собственный XML
        // со ссылкой на следующий уровень цепочки — раскрытие продолжается неограниченно.
        const levelIndex = calls - 2;
        const chain = ['Продажи', ...levels.slice(0, levelIndex + 1)];
        const dump = makeTempDump({
          [nestedSubsystemXmlRel(chain)]: buildSubsystemXml(levels[levelIndex], [], [levels[levelIndex + 1]]),
        });
        return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
      },
    });

    const outcome = await runRepositoryLockFlow(subsystemNode(harness, 'Продажи'), true, harness.services, deps);

    assert.strictEqual(outcome, 'done', 'достижение предела раундов не отменяет уже выполненный захват.');
    assert.strictEqual(calls, MAX_DUMP_ROUNDS, `основная выгрузка + ровно ${String(MAX_DUMP_ROUNDS - 1)} продуктивных раунда — дальше цикл обязан остановиться.`);
    assert.ok(
      harness.outputLines.some((line) => line.includes('достигнут предел') && line.includes(String(MAX_DUMP_ROUNDS))),
      'должен быть залогирован факт достижения предела раундов.'
    );
    let fullName = 'Подсистема.Продажи';
    // Найдены и слиты все уровни, кроме последнего (найденного бы только в раунде MAX_DUMP_ROUNDS+1).
    for (let index = 0; index < MAX_DUMP_ROUNDS - 1; index += 1) {
      fullName = subordinateUnitFullName(fullName, 'Subsystem', levels[index]);
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, fullName), true, `${levels[index]} должен быть найден в пределах лимита раундов.`);
      const chain = ['Продажи', ...levels.slice(0, index + 1)];
      assert.strictEqual(fs.existsSync(path.join(harness.configRoot, nestedSubsystemXmlRel(chain))), true, `${levels[index]} должен быть слит в проект.`);
    }
    const beyondLimit = subordinateUnitFullName(fullName, 'Subsystem', levels[MAX_DUMP_ROUNDS - 1]);
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, beyondLimit), false, 'уровень за пределом лимита раундов не может быть найден.');
  });

  test('раунд довыгрузки провалился — цикл останавливается с предупреждением в журнале, ранее найденное сохраняется', async () => {
    const harness = createSyntheticSubsystemHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', ['Catalog.Товары'], []),
      'utf-8'
    );
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Товары.xml'), '<MetaDataObject/>', 'utf-8');

    const level1 = subordinateUnitFullName('Подсистема.Продажи', 'Subsystem', 'Level1');
    const level2 = subordinateUnitFullName(level1, 'Subsystem', 'Level2');
    let calls = 0;
    const notifyWarningCalls: { message: string; guardBusy: boolean }[] = [];
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      chooseConflictResolution: () => Promise.resolve('replace'),
      notifyWarning: (message: string) => { notifyWarningCalls.push({ message, guardBusy: harness.guard.isBusy }); },
      dumpToTemp: () => {
        calls += 1;
        if (calls === 1) {
          const dump = makeTempDump({
            'Subsystems/Продажи.xml': buildSubsystemXml('Продажи', ['Catalog.Товары'], ['Level1']),
            'Catalogs/Товары.xml': '<MetaDataObject/>',
          });
          return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
        }
        if (calls === 2) {
          // Раунд 1 успешен и находит Level1, чей собственный XML ссылается на Level2 —
          // иначе цикл остановился бы после первого же раунда и сбой довыгрузки Level2 не был бы достигнут.
          const dump = makeTempDump({
            [nestedSubsystemXmlRel(['Продажи', 'Level1'])]: buildSubsystemXml('Level1', [], ['Level2']),
          });
          return Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose });
        }
        // Раунд 2 (довыгрузка Level2) — сбой выгрузки.
        return Promise.resolve({ ok: false, reason: 'сеть недоступна' });
      },
    });

    const outcome = await runRepositoryLockFlow(subsystemNode(harness, 'Продажи'), true, harness.services, deps);

    assert.strictEqual(outcome, 'done', 'сбой довыгрузки НЕ отменяет уже выполненный захват.');
    assert.strictEqual(calls, 3, 'основная выгрузка + успешный раунд Level1 + провалившийся раунд Level2.');
    assert.ok(
      harness.outputLines.some((line) => line.includes('довыгрузка') && line.includes('не удалась') && line.includes('сеть недоступна')),
      'должен быть залогирован факт сбоя довыгрузки.'
    );
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, level1), true, 'участник, найденный до сбоя, остаётся в составе захвата.');
    assert.strictEqual(fs.existsSync(path.join(harness.configRoot, nestedSubsystemXmlRel(['Продажи', 'Level1']))), true, 'участник, найденный до сбоя, должен быть слит в проект.');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, level2), false, 'участник, обнаруженный только в провалившемся раунде, не может быть довыгружен.');
    assert.strictEqual(notifyWarningCalls.length, 1, 'о недовыгруженном участнике должно быть выдано ровно одно предупреждение пользователю.');
    assert.ok(notifyWarningCalls[0].message.includes('1'), 'сообщение должно называть число недовыгруженных единиц.');
    assert.strictEqual(notifyWarningCalls[0].guardBusy, false, 'предупреждение о missing показывается ПОСЛЕ освобождения аренды guard.');
  });

  test('вложенная дочерняя подсистема: единица с каноничным D3-именем находится и захватывается отдельно от корневой', async () => {
    const harness = createSyntheticSubsystemHarness();
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
      'вложенная подсистема — обычная единица со своей областью (Р10/D3), резолв не должен падать.'
    );
    // D3: вложенная подсистема называется по цепочке предков, а не коротким именем.
    const nestedFullName = subordinateUnitFullName('Подсистема.Продажи', 'Subsystem', 'Розница');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, nestedFullName), true, 'состав захвата (state) включает дочернюю подсистему под каноничным D3-именем.');
  });
});

suite('RepositoryLockSync — runRepositoryLockFlow: область объекта не определена', () => {
  test('fullName узла не резолвится ни в проекте, ни в выгрузке — лог, объект пропущен, остальной поток не ломается', async () => {
    const harness = createHarness();
    // xmlPath указывает на РЕАЛЬНЫЙ существующий файл (чтобы резолвился корень конфигурации),
    // но label подставлен так, что итоговый fullName не соответствует никакому реальному объекту.
    const real = catalogNode(harness, 'Валюты');
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

  test('изменён владелец, choice="keep-local" — хеш-манифест корня получает хеш ХРАНИЛИЩА через overrides, а не оставленного локального содержимого', async () => {
    const harness = createHarness();
    const projectInfo = configDumpInfoXml([
      { name: 'Catalog.Изменяемый.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий1.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий2.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий3.ObjectModule', version: '1' },
    ]);
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), projectInfo, 'utf-8');
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Изменяемый.xml'), '<MetaDataObject>локальная правка</MetaDataObject>', 'utf-8');

    const nextInfo = configDumpInfoXml([
      { name: 'Catalog.Изменяемый.ObjectModule', version: '2' },
      { name: 'Catalog.Тихий1.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий2.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий3.ObjectModule', version: '1' },
    ]);
    const infoDump = makeTempDump({ 'ConfigDumpInfo.xml': nextInfo });
    const partialDump = makeTempDump({ 'Catalogs/Изменяемый.xml': '<MetaDataObject>версия хранилища</MetaDataObject>' });
    // Хеш version-хранилища снимается ДО запуска потока: applyMergeWithPostMutation
    // вызывает dump.dispose() в finally, temp-каталог выгрузки к концу теста уже удалён.
    const repositoryHash = computeFileHash(path.join(partialDump.dir, 'Catalogs', 'Изменяемый.xml'));

    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      chooseConflictResolution: () => Promise.resolve('keep-local'),
      dumpToTemp: (_target, request) => Promise.resolve(request.mode === 'update-info'
        ? { ok: true, dir: infoDump.dir, dispose: infoDump.dispose }
        : { ok: true, dir: partialDump.dir, dispose: partialDump.dispose }),
    });

    const outcome = await runRepositoryLockFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      true,
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(fs.readFileSync(path.join(harness.configRoot, 'Catalogs', 'Изменяемый.xml'), 'utf-8'), '<MetaDataObject>локальная правка</MetaDataObject>', 'keep-local — локальный файл не трогается.');
    const manifestHashes = harness.repositoryService.snapshots.readRootManifestHashes(harness.target);
    assert.ok(manifestHashes);
    assert.strictEqual(
      manifestHashes['Catalogs/Изменяемый.xml'],
      repositoryHash,
      'Эталон отмены обязан отражать версию ХРАНИЛИЩА для keep-local файла, а не оставленную локальную (иначе изменения будут потеряны при следующем сравнении с базой).'
    );
  });

  /**
   * Reviewer #4 (issue #1, раздел 10): keep-local на "conflict-delete" — локальный файл,
   * которого НЕТ в версии хранилища (repositoryHash===null). Такой файл не должен
   * попадать в манифест корня вовсе: если его хеш просто зафиксировать как "эталон",
   * следующая отмена захвата (unlock) навсегда "простит" файл, которого хранилище
   * никогда не содержало, и не предложит его удалить при откате.
   */
  test('Р4: keep-local на conflict-delete — локальный файл без версии хранилища исключается из манифеста корня', async () => {
    const harness = createHarness();
    const projectInfo = configDumpInfoXml([
      { name: 'Catalog.Изменяемый.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий1.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий2.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий3.ObjectModule', version: '1' },
    ]);
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), projectInfo, 'utf-8');
    fs.mkdirSync(path.join(harness.configRoot, 'Catalogs'), { recursive: true });
    // Собственный XML владельца совпадает с версией хранилища — единственный конфликт
    // в сценарии обязан быть только из-за "осиротевшего" локального файла ниже.
    fs.writeFileSync(path.join(harness.configRoot, 'Catalogs', 'Изменяемый.xml'), '<MetaDataObject>версия хранилища v2</MetaDataObject>', 'utf-8');
    // Локальный файл, которого НИКОГДА не было и нет в версии хранилища (нет хеш-кэша,
    // поэтому localHash !== baseHash===null) — законный "conflict-delete".
    const orphanPath = path.join(harness.configRoot, 'Catalogs', 'Изменяемый', 'Ext', 'ЧерновыеЗаметки.txt');
    fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
    fs.writeFileSync(orphanPath, 'локальный черновик, которого никогда не было в хранилище', 'utf-8');

    const nextInfo = configDumpInfoXml([
      { name: 'Catalog.Изменяемый.ObjectModule', version: '2' },
      { name: 'Catalog.Тихий1.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий2.ObjectModule', version: '1' },
      { name: 'Catalog.Тихий3.ObjectModule', version: '1' },
    ]);
    const infoDump = makeTempDump({ 'ConfigDumpInfo.xml': nextInfo });
    const partialDump = makeTempDump({ 'Catalogs/Изменяемый.xml': '<MetaDataObject>версия хранилища v2</MetaDataObject>' });
    let conflictCount = -1;
    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      chooseConflictResolution: (summary) => {
        conflictCount = summary.conflictCount;
        return Promise.resolve('keep-local');
      },
      dumpToTemp: (_target, request) => Promise.resolve(request.mode === 'update-info'
        ? { ok: true, dir: infoDump.dir, dispose: infoDump.dispose }
        : { ok: true, dir: partialDump.dir, dispose: partialDump.dispose }),
    });

    const outcome = await runRepositoryLockFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      true,
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(conflictCount, 1, 'предпосылка: единственный конфликт в сценарии — осиротевший локальный файл (главный XML совпадает с хранилищем).');
    assert.strictEqual(fs.existsSync(orphanPath), true, 'keep-local не должен удалять локальный файл.');

    const diff = harness.repositoryService.snapshots.diffRootManifest(harness.target);
    assert.ok(diff.hasManifest);
    assert.ok(
      diff.owners.includes('Справочник.Изменяемый'),
      `владелец локального файла без версии хранилища обязан считаться расхождением сразу после захвата, иначе он «прощён» навсегда (получено owners=${JSON.stringify(diff.owners)}).`
    );
  });
});

suite('RepositoryLockSync — runRepositoryUpdateFlow: корень рекурсивно, ранее захваченный (issue #1)', () => {
  test('получение (update) без изменений на уже рекурсивно захваченном корне — хеш-манифест всё равно пересоздаётся (shouldCaptureRootManifest по isRootRecursiveLocked)', async () => {
    const harness = createHarness();
    const configDumpInfoContent = '<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo"><ConfigVersions/></ConfigDumpInfo>';
    fs.writeFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), configDumpInfoContent, 'utf-8');
    const dump = makeTempDump({ 'ConfigDumpInfo.xml': configDumpInfoContent });
    // Корень уже захвачен рекурсивно РАНЕЕ (в этом сценарии проверяется именно
    // update, а не сам захват) — operation==='update', поэтому shouldCaptureRootManifest
    // обязан сработать через ВТОРОЙ операнд (isRootRecursiveLocked), не через первый.
    harness.repositoryService.lockState.applyLock(harness.target, {
      anchor: getRootLockName(harness.target),
      members: [getRootLockName(harness.target)],
      recursiveRoot: true,
    });

    const deps = baseDeps({
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
    });

    const outcome = await runRepositoryUpdateFlow(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') },
      { recursive: true, force: false },
      harness.services,
      deps
    );

    assert.strictEqual(outcome, 'done');
    assert.ok(harness.repositoryService.snapshots.readRootManifestHashes(harness.target), 'Манифест обязан быть создан даже для update — операция всё ещё держит корень захваченным рекурсивно.');
  });
});
