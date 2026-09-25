import * as assert from 'assert';
import {
  extractDumpInfoOwner,
  diffConfigDumpInfo,
  decideRootIncrementalStrategy,
  ROOT_INCREMENTAL_MAX_OWNERS,
  ROOT_INCREMENTAL_MAX_SHARE,
  type ConfigDumpInfoDiffResult,
} from '../../infra/repository/ConfigDumpInfoDiff';

/**
 * `extractDumpInfoOwner` группирует «сырое» имя записи ConfigDumpInfo (английский
 * префикс + произвольная вложенность модулей/форм/макетов) к владельцу — ровно
 * первым двум точечным сегментам (`<Kind>.<Имя>`). Это тот же алгоритм, что
 * неявно подразумевался в `RepositoryDumpPlan`/`RepositoryLockSync` для группировки
 * изменённых узлов ConfigDumpInfo по объекту-владельцу при инкрементальном
 * обновлении корня (issue #1, п.10 плана архитектора).
 */
suite('ConfigDumpInfoDiff — extractDumpInfoOwner', () => {
  const OWNER_CASES: readonly [string, string][] = [
    ['Catalog.Контрагенты.ObjectModule', 'Catalog.Контрагенты'],
    ['Catalog.Контрагенты.Form.ФормаСписка.Form', 'Catalog.Контрагенты'],
    ['Catalog.Контрагенты.Template.ЗагрузкаИзФайла.Template', 'Catalog.Контрагенты'],
    ['Catalog.Контрагенты.Command.Покупатели.CommandModule', 'Catalog.Контрагенты'],
    ['Configuration.ТорговыйУчет.SessionModule', 'Configuration.ТорговыйУчет'],
    ['Subsystem.Продажи.Subsystem.Розница', 'Subsystem.Продажи'],
    ['AccumulationRegister.Взаиморасчеты.RecordSetModule', 'AccumulationRegister.Взаиморасчеты'],
    // Топ-уровневая запись без вложенности — владелец совпадает с самим именем.
    ['Catalog.Контрагенты', 'Catalog.Контрагенты'],
    ['Configuration.ТорговыйУчет', 'Configuration.ТорговыйУчет'],
  ];

  OWNER_CASES.forEach(([name, expectedOwner]) => {
    test(`"${name}" → владелец "${expectedOwner}"`, () => {
      assert.strictEqual(extractDumpInfoOwner(name), expectedOwner);
    });
  });

  test('имя без точки трактуется как владелец самого себя (защитная ветка)', () => {
    assert.strictEqual(extractDumpInfoOwner('БезТочки'), 'БезТочки');
  });
});

function mapOf(entries: readonly [string, string][]): ReadonlyMap<string, string> {
  return new Map(entries);
}

suite('ConfigDumpInfoDiff — diffConfigDumpInfo', () => {
  test('идентичные карты → все три списка пусты', () => {
    const map = mapOf([
      ['Catalog.Контрагенты', 'h1'],
      ['Catalog.Контрагенты.ObjectModule', 'h2'],
    ]);
    const diff = diffConfigDumpInfo(map, map);
    assert.deepStrictEqual(diff, { changedOwners: [], addedOwners: [], removedOwners: [] });
  });

  test('изменён модуль существующего владельца → он в changedOwners, не в added/removed', () => {
    const prev = mapOf([
      ['Catalog.Контрагенты', 'root-h1'],
      ['Catalog.Контрагенты.ObjectModule', 'module-h1'],
    ]);
    const next = mapOf([
      ['Catalog.Контрагенты', 'root-h1'],
      ['Catalog.Контрагенты.ObjectModule', 'module-h2'],
    ]);
    const diff = diffConfigDumpInfo(prev, next);
    assert.deepStrictEqual(diff, { changedOwners: ['Catalog.Контрагенты'], addedOwners: [], removedOwners: [] });
  });

  test('изменён корень (Configuration.*.SessionModule) → владелец "Configuration.X" в changedOwners', () => {
    const prev = mapOf([
      ['Configuration.ТорговыйУчет', 'root-h1'],
      ['Configuration.ТорговыйУчет.SessionModule', 'session-h1'],
    ]);
    const next = mapOf([
      ['Configuration.ТорговыйУчет', 'root-h1'],
      ['Configuration.ТорговыйУчет.SessionModule', 'session-h2'],
    ]);
    const diff = diffConfigDumpInfo(prev, next);
    assert.deepStrictEqual(diff, { changedOwners: ['Configuration.ТорговыйУчет'], addedOwners: [], removedOwners: [] });
  });

  test('новый объект-владелец → он в addedOwners, не порождает false-positive changedOwners', () => {
    const prev = mapOf([['Catalog.Контрагенты', 'root-h1']]);
    const next = mapOf([
      ['Catalog.Контрагенты', 'root-h1'],
      ['Catalog.Новый', 'root-new'],
      ['Catalog.Новый.ObjectModule', 'module-new'],
    ]);
    const diff = diffConfigDumpInfo(prev, next);
    assert.deepStrictEqual(diff, { changedOwners: [], addedOwners: ['Catalog.Новый'], removedOwners: [] });
  });

  test('удалённый объект-владелец → он в removedOwners', () => {
    const prev = mapOf([
      ['Catalog.Контрагенты', 'root-h1'],
      ['Catalog.Удалённый', 'root-h2'],
      ['Catalog.Удалённый.ObjectModule', 'module-h2'],
    ]);
    const next = mapOf([['Catalog.Контрагенты', 'root-h1']]);
    const diff = diffConfigDumpInfo(prev, next);
    assert.deepStrictEqual(diff, { changedOwners: [], addedOwners: [], removedOwners: ['Catalog.Удалённый'] });
  });

  test('несколько владельцев затронуты одновременно — результат отсортирован', () => {
    const prev = mapOf([
      ['Catalog.Б', 'h1'],
      ['Catalog.А', 'h2'],
      ['Catalog.Г', 'h3'],
    ]);
    const next = mapOf([
      ['Catalog.Б', 'h1-changed'],
      ['Catalog.А', 'h2'],
      ['Catalog.В', 'new'],
    ]);
    const diff = diffConfigDumpInfo(prev, next);
    assert.deepStrictEqual(diff.changedOwners, ['Catalog.Б']);
    assert.deepStrictEqual(diff.addedOwners, ['Catalog.В']);
    assert.deepStrictEqual(diff.removedOwners, ['Catalog.Г']);
  });

  test('пустая карта в обе стороны → пустой diff', () => {
    const diff = diffConfigDumpInfo(mapOf([]), mapOf([]));
    assert.deepStrictEqual(diff, { changedOwners: [], addedOwners: [], removedOwners: [] });
  });
});

function ownersOf(count: number, prefix = 'Catalog.О'): ConfigDumpInfoDiffResult {
  return {
    changedOwners: Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`),
    addedOwners: [],
    removedOwners: [],
  };
}

suite('ConfigDumpInfoDiff — decideRootIncrementalStrategy', () => {
  test('diff===null (нет проектного ConfigDumpInfo.xml/ошибка UpdateInfo) → всегда "full"', () => {
    assert.strictEqual(decideRootIncrementalStrategy(null, 1000), 'full');
    assert.strictEqual(decideRootIncrementalStrategy(null, 0), 'full');
  });

  test('diff без изменений (0 владельцев) → "none"', () => {
    assert.strictEqual(decideRootIncrementalStrategy(ownersOf(0), 1000), 'none');
  });

  test(`ровно ${String(ROOT_INCREMENTAL_MAX_OWNERS)} изменённых владельцев (граница count) при малой доле → "partial"`, () => {
    assert.strictEqual(decideRootIncrementalStrategy(ownersOf(ROOT_INCREMENTAL_MAX_OWNERS), 100000), 'partial');
  });

  test(`${String(ROOT_INCREMENTAL_MAX_OWNERS + 1)} изменённых владельцев (за границей count) → "full", даже если доля мала`, () => {
    assert.strictEqual(decideRootIncrementalStrategy(ownersOf(ROOT_INCREMENTAL_MAX_OWNERS + 1), 100000), 'full');
  });

  test(`доля ровно ${String(ROOT_INCREMENTAL_MAX_SHARE * 100)}% (граница включительно) → "partial"`, () => {
    // 50 из 100 = ровно порог доли, но меньше порога по абсолютному числу.
    assert.strictEqual(decideRootIncrementalStrategy(ownersOf(50), 100), 'partial');
  });

  test(`доля ${String(ROOT_INCREMENTAL_MAX_SHARE * 100 + 1)}% (за границей доли) → "full"`, () => {
    assert.strictEqual(decideRootIncrementalStrategy(ownersOf(51), 100), 'full');
  });

  test('totalOwners=0 при непустом diff — доля не определена (деление на 0), решение по абсолютному числу', () => {
    // Есть хотя бы одна затронутая запись, но общее число владельцев конфигурации 0
    // (пограничный/вырожденный случай) — абсолютное число ниже порога, поэтому "partial".
    assert.strictEqual(decideRootIncrementalStrategy(ownersOf(1), 0), 'partial');
  });

  test('addedOwners/removedOwners тоже учитываются в общем количестве затронутых владельцев', () => {
    const diff: ConfigDumpInfoDiffResult = {
      changedOwners: ['Catalog.А'],
      addedOwners: ['Catalog.Б'],
      removedOwners: ['Catalog.В'],
    };
    // 3 затронутых из 100 — заведомо ниже обоих порогов.
    assert.strictEqual(decideRootIncrementalStrategy(diff, 100), 'partial');
  });
});
