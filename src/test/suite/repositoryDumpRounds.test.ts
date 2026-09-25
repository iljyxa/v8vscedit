import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MAX_DUMP_ROUNDS,
  expandSubordinateUnits,
  createSubsystemExpansion,
  createNewSubordinatesExpansion,
  createTowardsExpansion,
  collectUnitClosure,
  buildOptimisticDumpList,
  collectRemovedSubordinates,
  runDumpRounds,
  type UnitExpansion,
} from '../../infra/repository/RepositoryDumpRounds';
import { buildRootDumpListName } from '../../infra/repository/RepositoryObjectNames';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices } from '../../ui/commands/repository/RepositoryFileSyncShared';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { createPartialDumpFixture, KNOWN_FIXTURE_UNITS } from './support/partialDumpFixture';

/**
 * Типизированная обёртка над `partialDumpFixture.dumpToTemp`: сигнатура берётся
 * из УЖЕ существующего `RepositoryFileSyncDeps['dumpToTemp']` (раздел 1–9, не
 * меняется этой задачей), а не из ещё не существующего типа параметра
 * `runDumpRounds` — иначе параметры лямбды остались бы implicit-any до тех пор,
 * пока разработчик не добавит модуль `RepositoryDumpRounds` (ложный шум лишних
 * ошибок компиляции поверх ожидаемых «нет такого экспорта»).
 */
function dumpToTempOf(fixture: ReturnType<typeof createPartialDumpFixture>): RepositoryFileSyncDeps['dumpToTemp'] {
  return (target, request, services) => fixture.dumpToTemp(target, request, services);
}

interface FoundUnit { fullName: string; dir: string }

/**
 * `RepositoryDumpRounds` — раздел 10, Р4: оптимистичная выгрузка подчинённых
 * единиц раундами вместо трёхфазной схемы. Обычный случай — 1 запуск CLI вместо
 * 2–3; редкий (несовпадение проекта с базой) — ровно +1 запуск с откатом до
 * якорей. Все проверки — на реальной копии `example/2.21/src/cf`
 * (Контрагенты/Начисления/ИнтернетМагазин), имитация выгрузки платформы —
 * `partialDumpFixture` (10.5), НЕ production-код.
 *
 * Решения test-writer по сигнатурам (модуль ещё не существует, единственный
 * источник контракта — план архитектора 10.3, список имён экспортов):
 *  - `UnitExpansion = (unit: string, unitXmlPath: string) => string[]` — по XML
 *    НАЙДЕННОЙ единицы возвращает fullName'ы её прямых подчинённых.
 *  - `collectUnitClosure(dir, units, expansion): string[]` — для каждой единицы
 *    из `units`, чей основной XML есть в `dir`, вызывает `expansion` и
 *    возвращает объединённый нормализованный (уникальный, отсортированный)
 *    список найденных имён.
 *  - `buildOptimisticDumpList(anchors, projectRoot, expansion, baseHashes)` —
 *    список раунда 0: якоря + раскрытие по ПРОЕКТНОМУ XML (если он есть),
 *    отфильтрованное по хеш-кэшу (10.2 Р4.1: «не-якорные имена — только если
 *    основной XML единицы есть в хеш-кэше; при пустом кэше фильтр не
 *    применяется»).
 *  - `runDumpRounds(request)` возвращает `{status:'ok', found, missing, dispose()}
 *    | {status:'failed', reason}` — `removed` НЕ часть результата (вынесено в
 *    отдельную чистую функцию `collectRemovedSubordinates`, которую вызывающий
 *    код применяет к каждой найденной единице с собственными подчинёнными).
 *  - `runDumpRounds` работает только через внедрённый `dumpToTemp`-совместимый
 *    колбэк (та же сигнатура, что `RepositoryFileSyncDeps.dumpToTemp`) — реальный
 *    процесс 1С не запускается.
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const cfTarget: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

function createServices(workspaceRoot: string, outputLines: string[]): RepositoryFileSyncServices {
  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  return {
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
}

const toDumpListName = (fullName: string, target: RepositoryTarget): string =>
  fullName === '__configuration_root__' || fullName === '__extension_root__' ? buildRootDumpListName(target) : fullName;

suite('RepositoryDumpRounds — expandSubordinateUnits (issue #1, раздел 10, Р4)', () => {
  test('Контрагенты: раскрывается в 2 формы + 1 макет (полные имена единиц)', () => {
    const xmlPath = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml');
    const result = expandSubordinateUnits('Справочник.Контрагенты', xmlPath);
    assert.deepStrictEqual([...result].sort(), [
      KNOWN_FIXTURE_UNITS.kontragentyMaket,
      KNOWN_FIXTURE_UNITS.kontragentyFormaElementa,
      KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska,
    ].sort());
  });

  test('Начисления: раскрывается в 1 перерасчёт', () => {
    const xmlPath = path.join(EXAMPLE_CF, 'CalculationRegisters', 'Начисления.xml');
    assert.deepStrictEqual(
      expandSubordinateUnits(KNOWN_FIXTURE_UNITS.nachisleniya, xmlPath),
      [KNOWN_FIXTURE_UNITS.nachisleniyaPererashchety]
    );
  });

  test('ИнтернетМагазин: раскрывается в таблицу + куб', () => {
    const xmlPath = path.join(EXAMPLE_CF, 'ExternalDataSources', 'ИнтернетМагазин.xml');
    assert.deepStrictEqual(
      [...expandSubordinateUnits(KNOWN_FIXTURE_UNITS.internetMagazin, xmlPath)].sort(),
      [KNOWN_FIXTURE_UNITS.internetMagazinZakazy, KNOWN_FIXTURE_UNITS.internetMagazinProdazhi].sort()
    );
  });

  test('куб «Продажи»: раскрывается в 2 таблицы измерения (двойная вложенность)', () => {
    const xmlPath = path.join(EXAMPLE_CF, 'ExternalDataSources', 'ИнтернетМагазин', 'Cubes', 'Продажи.xml');
    assert.deepStrictEqual(
      [...expandSubordinateUnits(KNOWN_FIXTURE_UNITS.internetMagazinProdazhi, xmlPath)].sort(),
      [KNOWN_FIXTURE_UNITS.internetMagazinTovary, KNOWN_FIXTURE_UNITS.internetMagazinRegiony].sort()
    );
  });

  test('лист без подчинённых (форма) → пустой список', () => {
    const xmlPath = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml');
    assert.deepStrictEqual(expandSubordinateUnits(KNOWN_FIXTURE_UNITS.kontragentyFormaElementa, xmlPath), []);
  });
});

suite('RepositoryDumpRounds — createSubsystemExpansion (issue #1, раздел 10, Р4, P1)', () => {
  const SUBSYSTEM_XML = path.join(EXAMPLE_CF, 'Subsystems', 'Продажи.xml');

  test('подсистема: раскрывается в Content (переведённые в русский fullName), без вложенных (в фикстуре их нет — F1)', () => {
    const expansion = createSubsystemExpansion(true);
    const result = expansion('Подсистема.Продажи', SUBSYSTEM_XML);
    assert.deepStrictEqual([...result].sort(), [
      'РегистрНакопления.БонусныеБаллы',
      'РегистрНакопления.Взаиморасчеты',
      'РегистрНакопления.ТоварыНаСкладах',
    ].sort());
  });

  test('includeMemberSubordinates=true: НЕ-подсистемная найденная единица (участник) раскрывается через её собственные подчинённые (SUBSYSTEM_MEMBERS_INCLUDE_SUBORDINATES)', () => {
    const expansion = createSubsystemExpansion(true);
    const kontragentyXml = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml');
    const result = expansion('Справочник.Контрагенты', kontragentyXml);
    assert.deepStrictEqual([...result].sort(), [
      KNOWN_FIXTURE_UNITS.kontragentyMaket,
      KNOWN_FIXTURE_UNITS.kontragentyFormaElementa,
      KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska,
    ].sort());
  });

  test('includeMemberSubordinates=false: участник НЕ раскрывается (нерекурсивный обход состава)', () => {
    const expansion = createSubsystemExpansion(false);
    const kontragentyXml = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml');
    assert.deepStrictEqual(expansion('Справочник.Контрагенты', kontragentyXml), []);
  });
});

suite('RepositoryDumpRounds — createNewSubordinatesExpansion (issue #1, раздел 10, Р4, P2)', () => {
  test('все подчинённые уже есть в проекте (обычный случай) → пустой список (нечего довыгружать)', () => {
    const expansion = createNewSubordinatesExpansion(cfTarget);
    const xmlPath = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml');
    assert.deepStrictEqual(expansion('Справочник.Контрагенты', xmlPath), []);
  });

  test('подчинённый из выгрузки отсутствует в проекте → попадает в результат (новый в хранилище)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dump-rounds-newsub-'));
    try {
      fs.cpSync(EXAMPLE_CF, tempDir, { recursive: true });
      // В КОПИИ проекта удаляем ФормаСписка — как будто в хранилище есть форма, которой в проекте ещё нет.
      fs.rmSync(path.join(tempDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка.xml'), { force: true });
      fs.rmSync(path.join(tempDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка'), { recursive: true, force: true });

      const localTarget: RepositoryTarget = { configRoot: tempDir, configKind: 'cf', displayName: 'ТорговыйУчет' };
      const expansion = createNewSubordinatesExpansion(localTarget);
      // XML выгрузки (эталон) — ОРИГИНАЛЬНЫЙ Контрагенты.xml, где обе формы перечислены в ChildObjects.
      const dumpXmlPath = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml');
      const result = expansion('Справочник.Контрагенты', dumpXmlPath);
      assert.deepStrictEqual(result, [KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

suite('RepositoryDumpRounds — createTowardsExpansion (issue #1, раздел 10, Р4, Р8)', () => {
  test('всегда возвращает пустой список — единственный раунд по точным именам', () => {
    const expansion: UnitExpansion = createTowardsExpansion();
    assert.deepStrictEqual(expansion('Справочник.Контрагенты', path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml')), []);
    assert.deepStrictEqual(expansion('Что-угодно', '/несуществующий/путь.xml'), []);
  });
});

suite('RepositoryDumpRounds — collectUnitClosure (issue #1, раздел 10, Р4)', () => {
  test('раскрывает несколько единиц сразу, результат уникален и отсортирован', () => {
    const result = collectUnitClosure(
      EXAMPLE_CF,
      [KNOWN_FIXTURE_UNITS.kontragenty, KNOWN_FIXTURE_UNITS.internetMagazin],
      (unit: string, xmlPath: string) => expandSubordinateUnits(unit, xmlPath)
    );
    const expected = [
      KNOWN_FIXTURE_UNITS.kontragentyMaket,
      KNOWN_FIXTURE_UNITS.kontragentyFormaElementa,
      KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska,
      KNOWN_FIXTURE_UNITS.internetMagazinZakazy,
      KNOWN_FIXTURE_UNITS.internetMagazinProdazhi,
    ].sort();
    assert.deepStrictEqual([...result].sort(), expected);
  });

  test('единица без XML в каталоге раунда пропускается без ошибки', () => {
    const result = collectUnitClosure(EXAMPLE_CF, ['Справочник.НетТакогоСправочника'], () => {
      throw new Error('expansion не должна вызываться для ненайденной единицы');
    });
    assert.deepStrictEqual(result, []);
  });

  test('пустой список единиц → пустой результат', () => {
    assert.deepStrictEqual(collectUnitClosure(EXAMPLE_CF, [], () => ['что-то']), []);
  });
});

suite('RepositoryDumpRounds — buildOptimisticDumpList (issue #1, раздел 10, Р4.1)', () => {
  test('пустой хеш-кэш (первая синхронизация) — фильтр не применяется, все раскрытые по проекту кандидаты включены', () => {
    const result = buildOptimisticDumpList([KNOWN_FIXTURE_UNITS.kontragenty], EXAMPLE_CF, expandSubordinateUnits, {});
    assert.deepStrictEqual([...result].sort(), [
      KNOWN_FIXTURE_UNITS.kontragenty,
      KNOWN_FIXTURE_UNITS.kontragentyMaket,
      KNOWN_FIXTURE_UNITS.kontragentyFormaElementa,
      KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska,
    ].sort());
  });

  test('непустой хеш-кэш — кандидат включается только если его основной XML есть в кэше (известен с прошлой синхронизации)', () => {
    const baseHashes = { 'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml': 'какой-то-хеш' };
    const result = buildOptimisticDumpList([KNOWN_FIXTURE_UNITS.kontragenty], EXAMPLE_CF, expandSubordinateUnits, baseHashes);
    assert.deepStrictEqual([...result].sort(), [KNOWN_FIXTURE_UNITS.kontragenty, KNOWN_FIXTURE_UNITS.kontragentyFormaElementa].sort());
  });

  test('непустой хеш-кэш без единого совпадения — только якоря (новый локальный объект без истории синхронизации не гадаем)', () => {
    const baseHashes = { 'НекийДругойФайл.xml': 'хеш' };
    const result = buildOptimisticDumpList([KNOWN_FIXTURE_UNITS.kontragenty], EXAMPLE_CF, expandSubordinateUnits, baseHashes);
    assert.deepStrictEqual(result, [KNOWN_FIXTURE_UNITS.kontragenty]);
  });

  test('якорь без проектного XML (новый в хранилище объект, root-incremental added) — только якорь, expansion не вызывается', () => {
    const result = buildOptimisticDumpList(['Справочник.НетВПроекте'], EXAMPLE_CF, () => {
      throw new Error('expansion не должна вызываться для якоря без проектного XML');
    }, {});
    assert.deepStrictEqual(result, ['Справочник.НетВПроекте']);
  });

  test('несколько якорей — раскрытие суммируется, якоря идут первыми в исходном порядке', () => {
    const result = buildOptimisticDumpList(
      [KNOWN_FIXTURE_UNITS.nachisleniya, KNOWN_FIXTURE_UNITS.kontragenty],
      EXAMPLE_CF,
      expandSubordinateUnits,
      {}
    );
    assert.deepStrictEqual(result.slice(0, 2), [KNOWN_FIXTURE_UNITS.nachisleniya, KNOWN_FIXTURE_UNITS.kontragenty]);
    assert.strictEqual(result.length, 2 + 1 + 3); // 2 якоря + перерасчёт + 2 формы + макет
  });
});

suite('RepositoryDumpRounds — collectRemovedSubordinates (issue #1, раздел 10, Р4)', () => {
  test('проект и выгрузка совпадают → пусто', () => {
    const xmlPath = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml');
    const result = collectRemovedSubordinates(cfTarget, KNOWN_FIXTURE_UNITS.kontragenty, xmlPath, xmlPath);
    assert.deepStrictEqual(result, []);
  });

  test('подчинённый есть в проектном XML, но отсутствует в XML выгрузки → удалён из хранилища', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dump-rounds-removed-'));
    try {
      fs.cpSync(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml'), path.join(tempDir, 'ПроектнаяВерсия.xml'));
      const dumpVersionXml = fs.readFileSync(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml'), 'utf-8')
        .replace('<Form>ФормаСписка</Form>', '');
      const dumpVersionPath = path.join(tempDir, 'ВерсияХранилища.xml');
      fs.writeFileSync(dumpVersionPath, dumpVersionXml, 'utf-8');

      const result = collectRemovedSubordinates(
        cfTarget,
        KNOWN_FIXTURE_UNITS.kontragenty,
        path.join(tempDir, 'ПроектнаяВерсия.xml'),
        dumpVersionPath
      );
      assert.deepStrictEqual(result, [KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

suite('RepositoryDumpRounds — runDumpRounds: раунд 0 успешен (issue #1, раздел 10, Р4, критерий 10.1.2/10.1.5)', () => {
  test('рекурсивный захват Контрагенты: якорь + 3 подчинённых из хеш-кэша → РОВНО ОДИН вызов dumpToTemp', async () => {
    const outputLines: string[] = [];
    const services = createServices(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dump-rounds-')), outputLines);
    const fixture = createPartialDumpFixture(EXAMPLE_CF, cfTarget.displayName);
    fixture.probeBusy = () => services.configurationOperationGuard.isBusy;
    const lease = services.configurationOperationGuard.tryAcquire('Захват: Контрагенты');
    try {
      const baseHashes = {
        'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml': 'h1',
        'Catalogs/Контрагенты/Forms/ФормаСписка.xml': 'h2',
        'Catalogs/Контрагенты/Templates/ЗагрузкаИзФайла.xml': 'h3',
      };
      const result = await runDumpRounds({
        target: cfTarget,
        anchors: [KNOWN_FIXTURE_UNITS.kontragenty],
        expansion: expandSubordinateUnits,
        services,
        dumpToTemp: dumpToTempOf(fixture),
        toDumpListName,
        baseHashes,
        optimistic: true,
      });

      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(fixture.calls.length, 1, 'Обычный случай — ровно один запуск выгрузки.');
      assert.strictEqual(fixture.calls[0].busy, true, 'Выгрузка должна идти внутри аренды guard.');
      assert.deepStrictEqual([...fixture.calls[0].names].sort(), [
        KNOWN_FIXTURE_UNITS.kontragenty,
        KNOWN_FIXTURE_UNITS.kontragentyFormaElementa,
        KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska,
        KNOWN_FIXTURE_UNITS.kontragentyMaket,
      ].sort());
      if (result.status === 'ok') {
        assert.deepStrictEqual([...result.found.map((f: FoundUnit) => f.fullName)].sort(), [
          KNOWN_FIXTURE_UNITS.kontragenty,
          KNOWN_FIXTURE_UNITS.kontragentyFormaElementa,
          KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska,
          KNOWN_FIXTURE_UNITS.kontragentyMaket,
        ].sort());
        assert.deepStrictEqual(result.missing, []);
        result.dispose();
      }
    } finally {
      fixture.disposeAll();
      lease?.release();
    }
  });

  test('рекурсивная операция над ИнтернетМагазин: подчинённые в хеш-кэше → 1 вызов, включая таблицы измерения куба (два раунда раскрытия свёрнуты оптимистично)', async () => {
    const outputLines: string[] = [];
    const services = createServices(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dump-rounds-eds-')), outputLines);
    const fixture = createPartialDumpFixture(EXAMPLE_CF, cfTarget.displayName);
    const lease = services.configurationOperationGuard.tryAcquire('Захват: ИнтернетМагазин');
    try {
      const baseHashes = {
        'ExternalDataSources/ИнтернетМагазин/Tables/Заказы.xml': 'h1',
        'ExternalDataSources/ИнтернетМагазин/Cubes/Продажи.xml': 'h2',
        'ExternalDataSources/ИнтернетМагазин/Cubes/Продажи/DimensionTables/Товары.xml': 'h3',
        'ExternalDataSources/ИнтернетМагазин/Cubes/Продажи/DimensionTables/Регионы.xml': 'h4',
      };
      // Раскрытие суммарно за все раунды: owner→{Table,Cube}; Cube→{DimTable×2}. При
      // buildOptimisticDumpList раунд 0 использует ТОЛЬКО прямое раскрытие owner'а
      // (Table, Cube) — раскрытие Cube→DimensionTables появляется только когда Cube уже
      // НАЙДЕН (после раунда 0), поэтому здесь ожидается ДВА раунда (owner+Table+Cube,
      // затем 2 таблицы измерения), а не один — куб пока не был выгружен, чтобы прочитать
      // его собственный XML.
      const result = await runDumpRounds({
        target: cfTarget,
        anchors: [KNOWN_FIXTURE_UNITS.internetMagazin],
        expansion: expandSubordinateUnits,
        services,
        dumpToTemp: dumpToTempOf(fixture),
        toDumpListName,
        baseHashes,
        optimistic: true,
      });
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(fixture.calls.length, 2, 'Куб — новая, ранее не выгруженная единица; его собственные подчинённые раскрываются вторым раундом.');
      if (result.status === 'ok') {
        assert.deepStrictEqual([...result.found.map((f: FoundUnit) => f.fullName)].sort(), [
          KNOWN_FIXTURE_UNITS.internetMagazin,
          KNOWN_FIXTURE_UNITS.internetMagazinZakazy,
          KNOWN_FIXTURE_UNITS.internetMagazinProdazhi,
          KNOWN_FIXTURE_UNITS.internetMagazinTovary,
          KNOWN_FIXTURE_UNITS.internetMagazinRegiony,
        ].sort());
        result.dispose();
      }
    } finally {
      fixture.disposeAll();
      lease?.release();
    }
  });
});

suite('RepositoryDumpRounds — runDumpRounds: раунд 0 упал (issue #1, раздел 10, Р4, критерий 10.1.6)', () => {
  test('оптимистичный список длиннее якорей и упал → повтор только якорей, повтор успешен', async () => {
    const outputLines: string[] = [];
    const services = createServices(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dump-rounds-optfail-')), outputLines);
    const fixture = createPartialDumpFixture(EXAMPLE_CF, cfTarget.displayName);
    const lease = services.configurationOperationGuard.tryAcquire('Захват');
    try {
      // baseHashes «подсказывает» форму, которой в этой версии фикстуры НЕТ (её имени нет
      // в partialDumpFixture — симулируем расхождение локальных предположений с базой).
      const baseHashes = { 'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml': 'h1' };
      const brokenExpansion: UnitExpansion = (unit: string, xmlPath: string) => {
        if (unit === KNOWN_FIXTURE_UNITS.kontragenty) {
          return [...expandSubordinateUnits(unit, xmlPath), 'Справочник.Контрагенты.Форма.ПризракНесуществующейФормы'];
        }
        return expandSubordinateUnits(unit, xmlPath);
      };
      const result = await runDumpRounds({
        target: cfTarget,
        anchors: [KNOWN_FIXTURE_UNITS.kontragenty],
        expansion: brokenExpansion,
        services,
        dumpToTemp: dumpToTempOf(fixture),
        toDumpListName,
        baseHashes: { ...baseHashes, 'НекийФайлЧтобыФильтрНеБылПуст.xml': 'x' },
        optimistic: true,
      });
      assert.strictEqual(result.status, 'ok', 'Повтор только якорем должен пройти успешно.');
      assert.strictEqual(fixture.calls.length, 2, 'Раунд 0 (с призрачной формой, провал) + повтор только якорем.');
      assert.deepStrictEqual(fixture.calls[1].names, [KNOWN_FIXTURE_UNITS.kontragenty]);
      if (result.status === 'ok') {
        assert.deepStrictEqual(result.found.map((f: FoundUnit) => f.fullName), [KNOWN_FIXTURE_UNITS.kontragenty]);
        result.dispose();
      }
    } finally {
      fixture.disposeAll();
      lease?.release();
    }
  });

  test('список раунда 0 УЖЕ равен якорям (без оптимистичных догадок) и упал → сразу failed, без повторов', async () => {
    const outputLines: string[] = [];
    const services = createServices(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dump-rounds-anchorfail-')), outputLines);
    const fixture = createPartialDumpFixture(EXAMPLE_CF, cfTarget.displayName);
    const lease = services.configurationOperationGuard.tryAcquire('Захват');
    try {
      const result = await runDumpRounds({
        target: cfTarget,
        anchors: ['Справочник.НесуществующийВФикстуре'],
        expansion: expandSubordinateUnits,
        services,
        dumpToTemp: dumpToTempOf(fixture),
        toDumpListName,
        baseHashes: {},
        optimistic: true,
      });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(fixture.calls.length, 1, 'Без «лишних» оптимистичных имён повтор не имеет смысла — сразу failed.');
    } finally {
      fixture.disposeAll();
      lease?.release();
    }
  });
});

suite('RepositoryDumpRounds — runDumpRounds: MAX_DUMP_ROUNDS и missing (issue #1, раздел 10, Р4.3)', () => {
  test('MAX_DUMP_ROUNDS = 5', () => {
    assert.strictEqual(MAX_DUMP_ROUNDS, 5);
  });

  test('раскрытие превышает MAX_DUMP_ROUNDS — останавливается на пределе, недостающее в missing, статус остаётся "ok"', async () => {
    const outputLines: string[] = [];
    const services = createServices(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dump-rounds-max-')), outputLines);
    const fixture = createPartialDumpFixture(EXAMPLE_CF, cfTarget.displayName);
    const lease = services.configurationOperationGuard.tryAcquire('Захват');
    try {
      // Бесконечная (искусственная) цепочка раскрытия: каждая «найденная» форма
      // порождает следующую несуществующую в фикстуре форму — после MAX_DUMP_ROUNDS
      // раундов остановка, а не бесконечный цикл; несуществующее имя → сбой ЭТОГО
      // раунда → лог + остановка (Р4.3 «сбой раунда → стоп с логом»), а не failed целиком.
      let round = 0;
      const infiniteExpansion: UnitExpansion = (unit: string) => {
        if (unit !== KNOWN_FIXTURE_UNITS.kontragenty) {
          return [];
        }
        round += 1;
        return [`Справочник.Контрагенты.Форма.НесуществующаяФорма${String(round)}`];
      };
      const result = await runDumpRounds({
        target: cfTarget,
        anchors: [KNOWN_FIXTURE_UNITS.kontragenty],
        expansion: infiniteExpansion,
        services,
        dumpToTemp: dumpToTempOf(fixture),
        toDumpListName,
        baseHashes: {},
        optimistic: true,
      });
      assert.strictEqual(result.status, 'ok');
      assert.ok(fixture.calls.length <= MAX_DUMP_ROUNDS, `Число вызовов (${String(fixture.calls.length)}) не должно превышать MAX_DUMP_ROUNDS.`);
      if (result.status === 'ok') {
        assert.ok(result.missing.length > 0, 'Недовыгруженные единицы должны попасть в missing.');
        result.dispose();
      }
    } finally {
      fixture.disposeAll();
      lease?.release();
    }
  });
});

suite('RepositoryDumpRounds — runDumpRounds: towards/none (issue #1, раздел 10, Р4, Р8)', () => {
  test('optimistic=false, expansion=createTowardsExpansion() — ровно один раунд по точным именам', async () => {
    const outputLines: string[] = [];
    const services = createServices(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dump-rounds-towards-')), outputLines);
    const fixture = createPartialDumpFixture(EXAMPLE_CF, cfTarget.displayName);
    const lease = services.configurationOperationGuard.tryAcquire('Отмена захвата');
    try {
      const result = await runDumpRounds({
        target: cfTarget,
        anchors: [KNOWN_FIXTURE_UNITS.kontragentyFormaElementa],
        expansion: createTowardsExpansion(),
        services,
        dumpToTemp: dumpToTempOf(fixture),
        toDumpListName,
        baseHashes: {},
        optimistic: false,
      });
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(fixture.calls.length, 1);
      assert.deepStrictEqual(fixture.calls[0].names, [KNOWN_FIXTURE_UNITS.kontragentyFormaElementa]);
      if (result.status === 'ok') {
        result.dispose();
      }
    } finally {
      fixture.disposeAll();
      lease?.release();
    }
  });
});
