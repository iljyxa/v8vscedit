import * as assert from 'assert';
import * as path from 'path';
import { planReadonlyTransitions } from '../../ui/readonly/readonlyTransitionPlan';

/**
 * `planReadonlyTransitions` — чистая (без vscode) функция, решающая, какие из
 * открытых вкладок нужно перевести в writable/readonly после события
 * `RepositoryLockState.onDidChangeLocks` (issue #1, критерий приёмки №13, план
 * архитектора, раздел «C. Readonly»). Только файлы объектов, затронутых
 * событием, попадают в результат — остальные открытые вкладки не трогаются.
 *
 * Решение (неоднозначность плана — оба поля `changedOwnerFullNames`/`allObjects`
 * в одной сигнатуре без явного описания их взаимодействия): файл считается
 * затронутым, если ХОТЯ БЫ ОДИН элемент его цепочки владения
 * (`ownerChainOf(path)`) присутствует ЛИБО в `changedOwnerFullNames`, ЛИБО в
 * `allObjects` — так поддерживается и точечное событие (`changedOwnerFullNames`
 * = один fullName), и «широкое» событие рекурсивного тумблера корня, где
 * конкретный список затронутых объектов не перечисляется, а актуальный охват
 * передаётся только через `allObjects`.
 *
 * Раздел 10, Р9: `ownerOf(path) => string | null` заменён на
 * `ownerChainOf(path) => string[]` — единица (форма/макет/…), затем её предки
 * до владельца верхнего уровня (`getRepositoryUnitAncestors`). Файл считается
 * затронутым, если В ЦЕПОЧКЕ есть хотя бы один элемент из объединения
 * `changedOwnerFullNames`/`allObjects` — событие владельца верхнего уровня
 * затрагивает и его подчинённые единицы (их цепочка содержит владельца), а
 * событие ОДНОЙ подчинённой единицы затрагивает только её собственные файлы
 * (критерий приёмки 10.1.12).
 *
 * Сценарий «модифицированная сторона диффа» (упомянут в плане тестов пункта 16)
 * перенесён в `editorReadonlyController.test.ts` — это забота СБОРА открытых
 * вкладок (`TabInputTextDiff.modified`), а не чистой логики планирования.
 */

const CONFIG_ROOT = path.join('/', 'ws', 'src', 'cf');

function filePath(...segments: string[]): string {
  return path.join(CONFIG_ROOT, ...segments);
}

function ownerChainOfCatalog(p: string): string[] {
  const match = /Catalogs[\\/]([^\\/]+)/.exec(p);
  return match ? [`Справочник.${match[1]}`] : [];
}

suite('readonlyTransitionPlan — planReadonlyTransitions', () => {
  test('захват объекта → файл становится writable (readonly:false), если поддержка не запрещает', () => {
    const result = planReadonlyTransitions({
      openFiles: [{ path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), visible: true }],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result.applyNow, [{ path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), readonly: false }]);
    assert.deepStrictEqual(result.defer, []);
  });

  test('захват объекта, но поддержка запрещает редактирование — файл остаётся readonly:true', () => {
    const result = planReadonlyTransitions({
      openFiles: [{ path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), visible: true }],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => true,
    });
    assert.deepStrictEqual(result.applyNow, [{ path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), readonly: true }]);
  });

  test('отмена захвата → файл переходит в readonly:true', () => {
    const result = planReadonlyTransitions({
      openFiles: [{ path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), visible: true }],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: [],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => true,
    });
    assert.deepStrictEqual(result.applyNow, [{ path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), readonly: true }]);
  });

  test('файл чужого (не затронутого событием) объекта не попадает ни в applyNow, ни в defer', () => {
    const result = planReadonlyTransitions({
      openFiles: [{ path: filePath('Catalogs', 'Б', 'Ext', 'ObjectModule.bsl'), visible: true }],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result.applyNow, []);
    assert.deepStrictEqual(result.defer, []);
  });

  test('allObjects тоже расширяет охват (не только changedOwnerFullNames) — «широкое» событие рекурсивного тумблера', () => {
    const result = planReadonlyTransitions({
      openFiles: [{ path: filePath('Catalogs', 'В', 'Ext', 'ObjectModule.bsl'), visible: true }],
      changedOwnerFullNames: [],
      allObjects: ['Справочник.В'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result.applyNow, [{ path: filePath('Catalogs', 'В', 'Ext', 'ObjectModule.bsl'), readonly: false }]);
  });

  test('видимая вкладка → applyNow, невидимая → defer', () => {
    const result = planReadonlyTransitions({
      openFiles: [
        { path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), visible: true },
        { path: filePath('Catalogs', 'А', 'Forms', 'Ф', 'Ext', 'Form', 'Module.bsl'), visible: false },
      ],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => false,
    });
    assert.strictEqual(result.applyNow.length, 1);
    assert.strictEqual(result.applyNow[0].path, filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'));
    assert.strictEqual(result.defer.length, 1);
    assert.strictEqual(result.defer[0].path, filePath('Catalogs', 'А', 'Forms', 'Ф', 'Ext', 'Form', 'Module.bsl'));
  });

  test('файл вне configRoot игнорируется, даже если формально владелец совпадает', () => {
    const outsidePath = path.join('/', 'другой', 'проект', 'Catalogs', 'А', 'Ext', 'ObjectModule.bsl');
    const result = planReadonlyTransitions({
      openFiles: [{ path: outsidePath, visible: true }],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result.applyNow, []);
    assert.deepStrictEqual(result.defer, []);
  });

  test('владелец не резолвится (ownerChainOf возвращает пустую цепочку) — файл не трогается', () => {
    const result = planReadonlyTransitions({
      openFiles: [{ path: filePath('Ext', 'SessionModule.bsl'), visible: true }],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: () => [],
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result.applyNow, []);
    assert.deepStrictEqual(result.defer, []);
  });

  test('пустой openFiles → пустой результат', () => {
    const result = planReadonlyTransitions({
      openFiles: [],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result, { applyNow: [], defer: [] });
  });

  test('один и тот же файл открыт в нескольких вкладках (видимая + скрытая) — одна запись, видимая побеждает', () => {
    const result = planReadonlyTransitions({
      openFiles: [
        { path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), visible: false },
        { path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), visible: true },
      ],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result.applyNow, [{ path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), readonly: false }]);
    assert.deepStrictEqual(result.defer, []);
  });

  test('несколько затронутых файлов одного объекта — все попадают в результат', () => {
    const result = planReadonlyTransitions({
      openFiles: [
        { path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), visible: true },
        { path: filePath('Catalogs', 'А', 'Ext', 'ManagerModule.bsl'), visible: true },
      ],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfCatalog,
      isRestricted: () => false,
    });
    assert.strictEqual(result.applyNow.length, 2);
  });
});

/**
 * Раздел 10, Р9 / критерий приёмки 10.1.12: цепочка владения из нескольких
 * уровней (форма → владелец). `ownerChainOfForm` возвращает `[formUnit,
 * ownerUnit]` для файлов внутри `Catalogs/<Owner>/Forms/<Form>/**`, иначе —
 * `[ownerUnit]` (файл самого владельца, например Ext/ObjectModule.bsl).
 */
function ownerChainOfForm(p: string): string[] {
  const formMatch = /Catalogs[\\/]([^\\/]+)[\\/]Forms[\\/]([^\\/]+)[\\/]/.exec(p);
  if (formMatch) {
    return [`Справочник.${formMatch[1]}.Форма.${formMatch[2]}`, `Справочник.${formMatch[1]}`];
  }
  const ownerMatch = /Catalogs[\\/]([^\\/]+)/.exec(p);
  return ownerMatch ? [`Справочник.${ownerMatch[1]}`] : [];
}

suite('readonlyTransitionPlan — ownerChainOf: многоуровневая цепочка владения (issue #1, раздел 10, критерий 10.1.12)', () => {
  test('событие владельца верхнего уровня затрагивает И его собственные файлы, И файлы подчинённой единицы (формы)', () => {
    const ownerFile = filePath('Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl');
    const formFile = filePath('Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl');
    const result = planReadonlyTransitions({
      openFiles: [{ path: ownerFile, visible: true }, { path: formFile, visible: true }],
      changedOwnerFullNames: ['Справочник.Контрагенты'],
      allObjects: ['Справочник.Контрагенты'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfForm,
      isRestricted: () => false,
    });
    assert.strictEqual(result.applyNow.length, 2, 'Событие владельца должно затронуть и владельца, и подчинённую единицу.');
  });

  test('событие ОДНОЙ подчинённой единицы (формы) затрагивает ТОЛЬКО её файлы, не остальные файлы владельца', () => {
    const ownerFile = filePath('Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl');
    const formFile = filePath('Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl');
    const otherFormFile = filePath('Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка', 'Ext', 'Form', 'Module.bsl');
    const result = planReadonlyTransitions({
      openFiles: [
        { path: ownerFile, visible: true },
        { path: formFile, visible: true },
        { path: otherFormFile, visible: true },
      ],
      changedOwnerFullNames: ['Справочник.Контрагенты.Форма.ФормаЭлемента'],
      allObjects: ['Справочник.Контрагенты.Форма.ФормаЭлемента'],
      configRoot: CONFIG_ROOT,
      ownerChainOf: ownerChainOfForm,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result.applyNow.map((t) => t.path), [formFile]);
  });
});
