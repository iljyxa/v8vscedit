import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runRepositoryLockFlow } from '../../ui/commands/repository/RepositoryLockSync';
import { runRepositoryUnlockFlow } from '../../ui/commands/repository/RepositoryUnlockSync';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices } from '../../ui/commands/repository/RepositoryFileSyncShared';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { buildScopeKey, computeFileHash, saveHashCache } from '../../infra/cache/HashCache';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { createPartialDumpFixture, KNOWN_FIXTURE_UNITS } from './support/partialDumpFixture';
import { bumpConfigDumpInfoVersion, removeConfigDumpInfoEntry } from './support/configDumpInfoFixture';

/**
 * Сквозные сценарии `RepositoryLockSync`/`RepositoryUnlockSync` на РЕАЛЬНОЙ копии
 * `example/2.21/src/cf` (Контрагенты/Начисления/ИнтернетМагазин) через
 * `partialDumpFixture` — issue #1, раздел 10, критерии:
 *   10.1.2 — рекурсивный захват объекта с подчинёнными единицами;
 *   10.1.3 — нерекурсивный захват объекта, изоляция подчинённых от области владельца;
 *   10.1.4 — регресс D2b: единицы вне выгруженного состава (Recalculations/Tables/
 *            Cubes/DimensionTables) не удаляются как «сироты»;
 *   10.1.5 — раздельная довыгрузка подчинённых при пустом/непустом хеш-кэше и
 *            обработка единиц, удалённых из хранилища (Р4);
 *   10.1.7 — root-incremental по единицам (частичная выгрузка ровно по изменённой
 *            единице, удаление единицы, исчезнувшей из ConfigDumpInfo.xml);
 *   10.1.8 — отмена рекурсивного захвата корня по хеш-манифесту.
 * Здесь проверяется СБОРКА реальных строительных блоков (`buildRepositoryDumpPlan` →
 * `acquireObjectsDump` → `runDumpRounds`) в наблюдаемое число вызовов `dumpToTemp` и
 * состав снимков/захвата для настоящих объектов с подчинёнными единицами.
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
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
}

// N6: копии всей example/2.21/src/cf занимают заметное место на диске — teardown
// каждой suite ниже удаляет всё, что накопилось за её тесты (см. cleanupRealFixtureHarnesses).
const createdWorkspaceRoots: string[] = [];

/** Удаляет временные рабочие области, созданные createRealFixtureHarness() с прошлого вызова. */
function cleanupRealFixtureHarnesses(): void {
  createdWorkspaceRoots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
}

/** Рабочая область с РЕАЛЬНОЙ копией example/2.21/src/cf (не синтетическим стабом). */
function createRealFixtureHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-real-'));
  createdWorkspaceRoots.push(workspaceRoot);
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.cpSync(EXAMPLE_CF, configRoot, { recursive: true });

  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };
  const guard = new ConfigurationOperationGuard();
  const outputLines: string[] = [];

  const services: RepositoryFileSyncServices = {
    configurationOperationGuard: guard,
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

  return { workspaceRoot, configRoot, target, repositoryService, guard, services, outputLines };
}

function baseDeps(fixture: ReturnType<typeof createPartialDumpFixture>, overrides: Partial<RepositoryFileSyncDeps> = {}): RepositoryFileSyncDeps {
  return {
    runRepositoryCli: () => Promise.resolve({ status: 'done' }),
    dumpToTemp: (target, request, services) => fixture.dumpToTemp(target, request, services),
    chooseConflictResolution: () => { throw new Error('chooseConflictResolution не должен вызываться — выгрузка совпадает с проектом, конфликтов быть не должно.'); },
    confirmRollback: () => Promise.reject(new Error('confirmRollback не используется при lock')),
    openDiffs: () => Promise.reject(new Error('openDiffs не используется без диалога')),
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

function catalogNode(harness: Harness, folder: string, name: string): RepositoryNodeRef {
  return { nodeKind: 'Catalog', label: name, xmlPath: path.join(harness.configRoot, folder, `${name}.xml`) };
}

suite('RepositoryLockSync — реальная фикстура: рекурсивный захват объекта (issue #1, раздел 10, критерий 10.1.2)', () => {
  teardown(cleanupRealFixtureHarnesses);

  test('Справочник.Контрагенты рекурсивно: 1 вызов dumpToTemp, 4 единицы захвачены (mode:"recursive"), 4 снимка depth:"unit"', async () => {
    const harness = createRealFixtureHarness();
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    fixture.probeBusy = () => harness.guard.isBusy;
    const deps = baseDeps(fixture);

    const outcome = await runRepositoryLockFlow(catalogNode(harness, 'Catalogs', 'Контрагенты'), true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(fixture.calls.length, 1, 'Обычный случай (проект совпадает с хранилищем) — ровно один вызов dumpToTemp (диспетчер resolveUnitExpansion → expandSubordinateUnits, ветка "subordinates").');
    assert.strictEqual(fixture.calls[0].busy, true, 'Выгрузка должна идти внутри аренды guard.');

    const expectedUnits = [
      KNOWN_FIXTURE_UNITS.kontragenty,
      KNOWN_FIXTURE_UNITS.kontragentyFormaElementa,
      KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska,
      KNOWN_FIXTURE_UNITS.kontragentyMaket,
    ];
    for (const unit of expectedUnits) {
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, unit), true, `"${unit}" должна быть захвачена.`);
      assert.ok(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, unit), `У "${unit}" должен быть собственный снимок (depth:"unit").`);
      assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, unit)?.depth, 'unit');
    }
    assert.deepStrictEqual(
      [...(harness.repositoryService.lockState.getLockGroup(harness.target, KNOWN_FIXTURE_UNITS.kontragenty) ?? [])].sort(),
      [...expectedUnits].sort()
    );
    // Файлы формы/макета не изменились побайтово (выгрузка идентична проекту).
    assert.strictEqual(
      fs.readFileSync(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml')).equals(
        fs.readFileSync(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml'))
      ),
      true
    );
    fixture.disposeAll();
  });

  test('РегистрРасчета.Начисления рекурсивно: Перерасчеты не удаляются как сироты (регресс D2b, критерий 10.1.4)', async () => {
    const harness = createRealFixtureHarness();
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const deps = baseDeps(fixture);

    const node: RepositoryNodeRef = { nodeKind: 'CalculationRegister', label: 'Начисления', xmlPath: path.join(harness.configRoot, 'CalculationRegisters', 'Начисления.xml') };
    const outcome = await runRepositoryLockFlow(node, true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.nachisleniyaPererashchety), true);
    assert.strictEqual(
      fs.existsSync(path.join(harness.configRoot, 'CalculationRegisters', 'Начисления', 'Recalculations', 'Перерасчеты.xml')),
      true,
      'Recalculations владельца не должен удаляться как «сирота» области владельца (depth:"unit" его исключает из ЕГО области, но это отдельная единица со своей).'
    );
    fixture.disposeAll();
  });

  test('ВнешнийИсточникДанных.ИнтернетМагазин рекурсивно: Tables/Cubes/DimensionTables не удаляются как сироты (регресс D2b, критерий 10.1.4)', async () => {
    const harness = createRealFixtureHarness();
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const deps = baseDeps(fixture);

    const node: RepositoryNodeRef = { nodeKind: 'ExternalDataSource', label: 'ИнтернетМагазин', xmlPath: path.join(harness.configRoot, 'ExternalDataSources', 'ИнтернетМагазин.xml') };
    const outcome = await runRepositoryLockFlow(node, true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    for (const unit of [KNOWN_FIXTURE_UNITS.internetMagazinZakazy, KNOWN_FIXTURE_UNITS.internetMagazinProdazhi, KNOWN_FIXTURE_UNITS.internetMagazinTovary, KNOWN_FIXTURE_UNITS.internetMagazinRegiony]) {
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, unit), true, `"${unit}" должна быть захвачена.`);
    }
    assert.strictEqual(fs.existsSync(path.join(harness.configRoot, 'ExternalDataSources', 'ИнтернетМагазин', 'Tables', 'Заказы.xml')), true);
    assert.strictEqual(fs.existsSync(path.join(harness.configRoot, 'ExternalDataSources', 'ИнтернетМагазин', 'Cubes', 'Продажи.xml')), true);
    assert.strictEqual(
      fs.existsSync(path.join(harness.configRoot, 'ExternalDataSources', 'ИнтернетМагазин', 'Cubes', 'Продажи', 'DimensionTables', 'Товары.xml')),
      true
    );
    fixture.disposeAll();
  });

  test('ВнешнийИсточникДанных.ИнтернетМагазин НЕрекурсивно: Tables/Cubes/DimensionTables тоже не удаляются (критерий 10.1.4, объект-режим)', async () => {
    const harness = createRealFixtureHarness();
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const deps = baseDeps(fixture);

    const node: RepositoryNodeRef = { nodeKind: 'ExternalDataSource', label: 'ИнтернетМагазин', xmlPath: path.join(harness.configRoot, 'ExternalDataSources', 'ИнтернетМагазин.xml') };
    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.internetMagazin), true);
    // Нерекурсивный захват НЕ распространяется на подчинённые — но их файлы тем не менее целы.
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.internetMagazinZakazy), false);
    assert.strictEqual(fs.existsSync(path.join(harness.configRoot, 'ExternalDataSources', 'ИнтернетМагазин', 'Tables', 'Заказы.xml')), true);
    assert.strictEqual(fs.existsSync(path.join(harness.configRoot, 'ExternalDataSources', 'ИнтернетМагазин', 'Cubes', 'Продажи.xml')), true);
    fixture.disposeAll();
  });
});

suite('RepositoryLockSync — реальная фикстура: нерекурсивный захват объекта с подчинёнными (issue #1, раздел 10, критерий 10.1.3)', () => {
  teardown(cleanupRealFixtureHarnesses);

  test('Справочник.Контрагенты нерекурсивно: 1 вызов dumpToTemp только по владельцу, Forms/Templates побайтово не тронуты, isEditRestricted по единицам', async () => {
    const harness = createRealFixtureHarness();
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    fixture.probeBusy = () => harness.guard.isBusy;
    // Хеш-кэш "врёт" о состоянии формы — нерекурсивный захват НЕ обязан даже
    // заглядывать в файлы подчинённых: они вне области владельца (unit).
    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    saveHashCache(harness.workspaceRoot, {
      schemaVersion: 1, scopeKey, generatedAt: '',
      files: { 'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form.xml': 'заведомо неверный хеш' },
    });
    const deps = baseDeps(fixture);
    // isEditRestricted ограничивает редактирование только при АКТИВНОМ подключении
    // к хранилищу (привязка + connected) — так же, как в repositoryService.test.ts.
    // Привязка обязана быть установлена ДО lock-потока: saveBinding сбрасывает
    // состояние захватов ("новая привязка начинается с чистого состояния").
    await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
    harness.repositoryService.setConnected(harness.target, true);

    const outcome = await runRepositoryLockFlow(catalogNode(harness, 'Catalogs', 'Контрагенты'), false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(fixture.calls.length, 1, 'нерекурсивный захват — ровно один вызов dumpToTemp.');
    assert.deepStrictEqual(fixture.calls[0].names, [KNOWN_FIXTURE_UNITS.kontragenty]);
    assert.strictEqual(fixture.calls[0].busy, true);

    for (const rel of [
      'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml',
      'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form.xml',
      'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form/Module.bsl',
      'Catalogs/Контрагенты/Forms/ФормаСписка.xml',
      'Catalogs/Контрагенты/Templates/ЗагрузкаИзФайла.xml',
    ]) {
      assert.strictEqual(
        fs.readFileSync(path.join(harness.configRoot, rel)).equals(fs.readFileSync(path.join(EXAMPLE_CF, rel))),
        true,
        `"${rel}" вне области нерекурсивного захвата владельца — обязан остаться побайтово нетронутым (даже с "неверным" хешем в кэше).`
      );
    }

    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragenty), true);
    assert.strictEqual(
      harness.repositoryService.isEditRestricted(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml')),
      true,
      'форма НЕ захвачена нерекурсивной операцией — редактирование должно быть ограничено.'
    );
    assert.strictEqual(
      harness.repositoryService.isEditRestricted(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl')),
      true
    );
    assert.strictEqual(
      harness.repositoryService.isEditRestricted(path.join(harness.configRoot, 'Catalogs', 'Контрагенты.xml')),
      false,
      'сам владелец захвачен — его собственный XML редактируем.'
    );
    assert.strictEqual(
      harness.repositoryService.isEditRestricted(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl')),
      false
    );
    assert.strictEqual(
      harness.repositoryService.isEditRestricted(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Templates', 'ЗагрузкаИзФайла.xml')),
      true,
      'макет — подчинённая единица со своим захватом, нерекурсивная операция владельца её не касается.'
    );
    assert.strictEqual(
      harness.repositoryService.isEditRestricted(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Commands', 'Покупатели', 'Ext', 'CommandModule.bsl')),
      false,
      'команда не имеет собственного XML верхнего уровня в ConfigDumpInfo — она в составе владельца, а не отдельная единица.'
    );
    fixture.disposeAll();
  });
});

suite('RepositoryLockSync — реальная фикстура: раздельная довыгрузка подчинённых при пустом составе в хеш-кэше (issue #1, раздел 10, критерий 10.1.5)', () => {
  teardown(cleanupRealFixtureHarnesses);

  test('ВнешнийИсточникДанных.ИнтернетМагазин рекурсивно, хеш-кэш непуст, но БЕЗ подчинённых источника — 3 вызова dumpToTemp (владелец; таблица+куб; таблицы измерения)', async () => {
    const harness = createRealFixtureHarness();
    // Хеш-кэш НЕПУСТ (иначе фильтр по кэшу не применяется вовсе — ветка "хеш-кэш
    // пуст" уже покрыта соседним сценарием), но НЕ содержит ни одной единицы
    // ИнтернетМагазин — раунд 0 обязан ограничиться только якорем.
    const scopeKey = buildScopeKey('cf', harness.configRoot, '');
    saveHashCache(harness.workspaceRoot, {
      schemaVersion: 1, scopeKey, generatedAt: '',
      files: { 'Catalogs/Валюты.xml': computeFileHash(path.join(harness.configRoot, 'Catalogs', 'Валюты.xml')) },
    });
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    fixture.probeBusy = () => harness.guard.isBusy;
    const deps = baseDeps(fixture);

    const node: RepositoryNodeRef = { nodeKind: 'ExternalDataSource', label: 'ИнтернетМагазин', xmlPath: path.join(harness.configRoot, 'ExternalDataSources', 'ИнтернетМагазин.xml') };
    const outcome = await runRepositoryLockFlow(node, true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(
      fixture.calls.length,
      3,
      `хеш-кэш без подчинённых источника обязан вести к 3 раундам выгрузки (получено: ${JSON.stringify(fixture.calls.map((call) => call.names))}).`
    );
    assert.ok(fixture.calls.every((call) => call.busy));
    assert.deepStrictEqual(fixture.calls[0].names, [KNOWN_FIXTURE_UNITS.internetMagazin]);
    assert.deepStrictEqual(
      [...fixture.calls[1].names].sort(),
      [KNOWN_FIXTURE_UNITS.internetMagazinProdazhi, KNOWN_FIXTURE_UNITS.internetMagazinZakazy].sort()
    );
    assert.deepStrictEqual(
      [...fixture.calls[2].names].sort(),
      [KNOWN_FIXTURE_UNITS.internetMagazinRegiony, KNOWN_FIXTURE_UNITS.internetMagazinTovary].sort()
    );
    for (const unit of [
      KNOWN_FIXTURE_UNITS.internetMagazin,
      KNOWN_FIXTURE_UNITS.internetMagazinZakazy,
      KNOWN_FIXTURE_UNITS.internetMagazinProdazhi,
      KNOWN_FIXTURE_UNITS.internetMagazinTovary,
      KNOWN_FIXTURE_UNITS.internetMagazinRegiony,
    ]) {
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, unit), true, `"${unit}" должна быть захвачена.`);
    }
    fixture.disposeAll();
  });
});

/**
 * Р4: подчинённые, исчезнувшие из хранилища. Реальную фикстуру-«хранилище» с
 * удалённой формой синтетически не построить без изменения самого XML владельца
 * (единственный способ убрать ссылку на форму из `<ChildObjects>` — вырезать
 * строку `<Form>ФормаСписка</Form>` в КОПИИ реального `Контрагенты.xml`; сам
 * файл формы в «хранилище»-копии просто не создаётся). Это тот самый допустимый
 * минимальный случай точечной правки скопированного реального XML (нет
 * альтернативы без доступа к живому хранилищу — см. отчёт test-writer).
 */
suite('RepositoryLockSync — реальная фикстура: подчинённая единица удалена из хранилища (issue #1, раздел 10, Р4)', () => {
  teardown(cleanupRealFixtureHarnesses);

  function buildRepositoryStateWithoutFormaSpiska(): { root: string; dispose(): void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-repo-state-'));
    fs.cpSync(EXAMPLE_CF, root, { recursive: true });
    const ownerXmlPath = path.join(root, 'Catalogs', 'Контрагенты.xml');
    const original = fs.readFileSync(ownerXmlPath, 'utf-8');
    const withoutFormaSpiska = original.replace(/<Form>ФормаСписка<\/Form>/, '');
    assert.notStrictEqual(withoutFormaSpiska, original, 'В реальном Контрагенты.xml обязана быть ссылка <Form>ФормаСписка</Form> — иначе фикстура не соответствует ожиданию.');
    fs.writeFileSync(ownerXmlPath, withoutFormaSpiska, 'utf-8');
    fs.rmSync(path.join(root, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка.xml'), { force: true });
    return { root, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  test('рекурсивная операция: удалённая в хранилище форма стирается из проекта целиком (область "tree")', async () => {
    const harness = createRealFixtureHarness();
    const repoState = buildRepositoryStateWithoutFormaSpiska();
    try {
      const fixture = createPartialDumpFixture(repoState.root, harness.target.displayName);
      // Без хеш-кэша/снимка (первый захват) удаление подчинённого, отсутствующего
      // в отдельной "removed"-области, — законный конфликт (нет базы для сравнения);
      // "replace" по-прежнему выполняет удаление (applyRepositoryMerge удаляет
      // и по action:"delete", и по action:"conflict-delete" при любом choice ≠ keep-local).
      const deps = baseDeps(fixture, { chooseConflictResolution: () => Promise.resolve('replace') });

      const outcome = await runRepositoryLockFlow(catalogNode(harness, 'Catalogs', 'Контрагенты'), true, harness.services, deps);

      assert.strictEqual(outcome, 'done');
      assert.strictEqual(
        fs.existsSync(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка.xml')),
        false,
        'Рекурсивная операция обязана удалить подчинённого, исчезнувшего из хранилища.'
      );
      // Примечание: subject.members (состав захвата) считается ДО контакта с
      // хранилищем — по проектному XML владельца, который на момент вызова ещё
      // ссылается на ФормаСписка, — поэтому запись в state.json для неё остаётся
      // (сервер её тоже продолжает считать захваченной, P2-подобная асимметрия).
      // Критерий 10.1.5 — про файлы области, а не про состав захвата.
      fixture.disposeAll();
    } finally {
      repoState.dispose();
    }
  });

  test('нерекурсивная операция: удалённая в хранилище форма НЕ трогается, только предупреждение в журнале', async () => {
    const harness = createRealFixtureHarness();
    const repoState = buildRepositoryStateWithoutFormaSpiska();
    try {
      const fixture = createPartialDumpFixture(repoState.root, harness.target.displayName);
      const deps = baseDeps(fixture);

      const outcome = await runRepositoryLockFlow(catalogNode(harness, 'Catalogs', 'Контрагенты'), false, harness.services, deps);

      assert.strictEqual(outcome, 'done');
      assert.strictEqual(
        fs.existsSync(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка.xml')),
        true,
        'Нерекурсивная операция не должна трогать файлы подчинённых — сервер их не отдаёт и не захватывает.'
      );
      assert.ok(
        harness.outputLines.some((line) => line.includes('в хранилище нет') && line.includes(KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska)),
        'должно быть залогировано, что подчинённый отсутствует в хранилище при нерекурсивной операции.'
      );
      fixture.disposeAll();
    } finally {
      repoState.dispose();
    }
  });
});

function makeTempDump(seedFiles: Record<string, string>): { dir: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-real-dump-'));
  for (const [rel, content] of Object.entries(seedFiles)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function rootNode(harness: Harness): RepositoryNodeRef {
  return { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') };
}

suite('RepositoryLockSync — реальная фикстура: root-incremental по единицам (issue #1, раздел 10, критерий 10.1.7)', () => {
  teardown(cleanupRealFixtureHarnesses);

  test('изменена только форма Контрагенты.ФормаЭлемента, удалена ФормаСписка — частичная выгрузка ровно по изменённой единице, удалённая стирается', async () => {
    const harness = createRealFixtureHarness();
    const originalConfigDumpInfo = fs.readFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), 'utf-8');

    // «Новый» ConfigDumpInfo.xml — копия реального файла фикстуры с ТОЧЕЧНОЙ текстовой
    // правкой значений configVersion (не сборка XML): единица ФормаЭлемента изменена,
    // единица ФормаСписка исчезла из версии хранилища целиком.
    let nextConfigDumpInfo = originalConfigDumpInfo;
    nextConfigDumpInfo = bumpConfigDumpInfoVersion(nextConfigDumpInfo, 'Catalog.Контрагенты.Form.ФормаЭлемента', '0000000000000000000000000000000000000a');
    nextConfigDumpInfo = bumpConfigDumpInfoVersion(nextConfigDumpInfo, 'Catalog.Контрагенты.Form.ФормаЭлемента.Form', '0000000000000000000000000000000000000b');
    nextConfigDumpInfo = removeConfigDumpInfoEntry(nextConfigDumpInfo, 'Catalog.Контрагенты.Form.ФормаСписка');
    nextConfigDumpInfo = removeConfigDumpInfoEntry(nextConfigDumpInfo, 'Catalog.Контрагенты.Form.ФормаСписка.Form');

    const infoDump = makeTempDump({ 'ConfigDumpInfo.xml': nextConfigDumpInfo });
    const partialFixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const partialRequests: string[][] = [];
    const deps = baseDeps(partialFixture, {
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      chooseConflictResolution: () => Promise.resolve('replace'),
      dumpToTemp: (target, request, services) => {
        if (request.mode === 'update-info') {
          return Promise.resolve({ ok: true, dir: infoDump.dir, dispose: infoDump.dispose });
        }
        assert.strictEqual(request.mode, 'partial', 'root-incremental не должен запрашивать полную выгрузку в этом сценарии.');
        partialRequests.push([...request.fullNames]);
        return partialFixture.dumpToTemp(target, request, services);
      },
    });

    const outcome = await runRepositoryLockFlow(rootNode(harness), true, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(
      partialRequests,
      [[KNOWN_FIXTURE_UNITS.kontragentyFormaElementa]],
      'частичная выгрузка root-incremental обязана запросить РОВНО изменённую единицу, без владельца и без удалённой единицы.'
    );
    assert.strictEqual(
      fs.existsSync(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка.xml')),
      false,
      'единица, исчезнувшая из ConfigDumpInfo.xml версии хранилища, обязана быть удалена из проекта.'
    );
    assert.strictEqual(
      fs.existsSync(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка')),
      false,
      'каталог удалённой единицы тоже обязан быть удалён.'
    );
    assert.strictEqual(
      fs.existsSync(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml')),
      true,
      'изменённая (но не удалённая) единица должна остаться на месте.'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), 'utf-8'),
      nextConfigDumpInfo,
      'после применения всех владельцев проектный ConfigDumpInfo.xml обязан замениться версией из выгрузки.'
    );
    partialFixture.disposeAll();
  });
});

suite('RepositoryLockSync/UnlockSync — реальная фикстура: отмена рекурсивного захвата корня по хеш-манифесту (issue #1, раздел 10, критерий 10.1.8)', () => {
  teardown(cleanupRealFixtureHarnesses);

  async function lockRootRecursivelyWithoutChanges(harness: Harness): Promise<void> {
    const configDumpInfo = fs.readFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), 'utf-8');
    const dump = makeTempDump({ 'ConfigDumpInfo.xml': configDumpInfo });
    // Единственный запрос в этом сценарии — update-info; partialDumpFixture не нужен,
    // но baseDeps() этого файла требует передавать инстанс для типовой совместимости.
    const deps = baseDeps(createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName), {
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      dumpToTemp: () => Promise.resolve({ ok: true, dir: dump.dir, dispose: dump.dispose }),
    });
    const outcome = await runRepositoryLockFlow(rootNode(harness), true, harness.services, deps);
    assert.strictEqual(outcome, 'done');
    assert.ok(harness.repositoryService.snapshots.readRootManifestHashes(harness.target), 'предпосылка: хеш-манифест корня обязан быть снят при захвате.');
  }

  const formModuleRel = path.join('Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl');

  test('изменён только модуль формы — частичная выгрузка ровно по единице формы, откат восстанавливает версию хранилища', async () => {
    const harness = createRealFixtureHarness();
    await lockRootRecursivelyWithoutChanges(harness);

    const modulePath = path.join(harness.configRoot, formModuleRel);
    const originalModuleContent = fs.readFileSync(modulePath, 'utf-8');
    fs.writeFileSync(modulePath, `${originalModuleContent}\n// локальная правка после захвата`, 'utf-8');

    const partialFixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const partialRequests: string[][] = [];
    let confirmRollbackCalls = 0;
    const deps = baseDeps(partialFixture, {
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      confirmRollback: () => { confirmRollbackCalls += 1; return Promise.resolve(true); },
      dumpToTemp: (target, request, services) => {
        assert.strictEqual(request.mode, 'partial', 'отмена захвата корня по манифесту запрашивает только частичную выгрузку изменённых единиц.');
        partialRequests.push([...request.fullNames]);
        return partialFixture.dumpToTemp(target, request, services);
      },
    });

    const outcome = await runRepositoryUnlockFlow(rootNode(harness), { recursive: true, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(
      partialRequests,
      [[KNOWN_FIXTURE_UNITS.kontragentyFormaElementa]],
      'отмена захвата рекурсивного корня обязана выгружать РОВНО единицу с изменившимся файлом.'
    );
    assert.strictEqual(confirmRollbackCalls, 1);
    assert.strictEqual(
      fs.readFileSync(modulePath, 'utf-8'),
      originalModuleContent,
      'после отката модуль формы обязан вернуться к версии хранилища.'
    );
    partialFixture.disposeAll();
  });

  test('ничего не изменено — Конфигуратор для частичной выгрузки не запускается, диалог отката не показывается', async () => {
    const harness = createRealFixtureHarness();
    await lockRootRecursivelyWithoutChanges(harness);

    let dumpToTempCalls = 0;
    let confirmRollbackCalls = 0;
    const deps = baseDeps(createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName), {
      runRepositoryCli: () => Promise.resolve({ status: 'done' }),
      confirmRollback: () => { confirmRollbackCalls += 1; return Promise.resolve(true); },
      dumpToTemp: () => {
        dumpToTempCalls += 1;
        return Promise.reject(new Error('dumpToTemp не должен вызываться — файлы не менялись.'));
      },
    });

    const outcome = await runRepositoryUnlockFlow(rootNode(harness), { recursive: true, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(dumpToTempCalls, 0, 'без расхождений с манифестом Конфигуратор для файлов запускаться не должен.');
    assert.strictEqual(confirmRollbackCalls, 0, 'без расхождений диалог отката не показывается.');
  });
});
