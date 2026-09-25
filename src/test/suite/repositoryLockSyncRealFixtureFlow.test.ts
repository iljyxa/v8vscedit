import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runRepositoryLockFlow } from '../../ui/commands/repository/RepositoryLockSync';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices } from '../../ui/commands/repository/RepositoryFileSyncShared';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { createPartialDumpFixture, KNOWN_FIXTURE_UNITS } from './support/partialDumpFixture';

/**
 * Сквозные сценарии `RepositoryLockSync` на РЕАЛЬНОЙ копии `example/2.21/src/cf`
 * (Контрагенты/Начисления/ИнтернетМагазин) через `partialDumpFixture` — issue #1,
 * раздел 10, критерии 10.1.2/10.1.4/10.1.5. В отличие от `repositoryLockSync.test.ts`
 * (синтетические `<MetaDataObject/>`/`buildSubsystemXml`, узкие сценарии guard/
 * конфликтов/раундов), здесь проверяется СБОРКА реальных строительных блоков
 * (`buildRepositoryDumpPlan` → `acquireObjectsDump` → `runDumpRounds`) в
 * наблюдаемое число вызовов `dumpToTemp` и состав снимков/захвата для настоящих
 * объектов с подчинёнными единицами.
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

/** Рабочая область с РЕАЛЬНОЙ копией example/2.21/src/cf (не синтетическим стабом). */
function createRealFixtureHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-sync-real-'));
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

  test('РегистрРасчета.Начисления рекурсивно: Pererascheты не удаляются как сироты (регресс D2b, критерий 10.1.4)', async () => {
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
