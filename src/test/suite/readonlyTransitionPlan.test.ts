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
 * затронутым, если его владелец (`ownerOf(path)`) присутствует ЛИБО в
 * `changedOwnerFullNames`, ЛИБО в `allObjects` — так поддерживается и точечное
 * событие (`changedOwnerFullNames` = один fullName), и «широкое» событие
 * рекурсивного тумблера корня, где конкретный список затронутых объектов не
 * перечисляется, а актуальный охват передаётся только через `allObjects`.
 *
 * Сценарий «модифицированная сторона диффа» (упомянут в плане тестов пункта 16)
 * перенесён в `editorReadonlyController.test.ts` — это забота СБОРА открытых
 * вкладок (`TabInputTextDiff.modified`), а не чистой логики планирования.
 */

const CONFIG_ROOT = path.join('/', 'ws', 'src', 'cf');

function filePath(...segments: string[]): string {
  return path.join(CONFIG_ROOT, ...segments);
}

function ownerOfCatalog(p: string): string | null {
  const match = /Catalogs[\\/]([^\\/]+)/.exec(p);
  return match ? `Справочник.${match[1]}` : null;
}

suite('readonlyTransitionPlan — planReadonlyTransitions', () => {
  test('захват объекта → файл становится writable (readonly:false), если поддержка не запрещает', () => {
    const result = planReadonlyTransitions({
      openFiles: [{ path: filePath('Catalogs', 'А', 'Ext', 'ObjectModule.bsl'), visible: true }],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerOf: ownerOfCatalog,
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
      ownerOf: ownerOfCatalog,
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
      ownerOf: ownerOfCatalog,
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
      ownerOf: ownerOfCatalog,
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
      ownerOf: ownerOfCatalog,
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
      ownerOf: ownerOfCatalog,
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
      ownerOf: ownerOfCatalog,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result.applyNow, []);
    assert.deepStrictEqual(result.defer, []);
  });

  test('владелец не резолвится (ownerOf возвращает null) — файл не трогается', () => {
    const result = planReadonlyTransitions({
      openFiles: [{ path: filePath('Ext', 'SessionModule.bsl'), visible: true }],
      changedOwnerFullNames: ['Справочник.А'],
      allObjects: ['Справочник.А'],
      configRoot: CONFIG_ROOT,
      ownerOf: () => null,
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
      ownerOf: ownerOfCatalog,
      isRestricted: () => false,
    });
    assert.deepStrictEqual(result, { applyNow: [], defer: [] });
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
      ownerOf: ownerOfCatalog,
      isRestricted: () => false,
    });
    assert.strictEqual(result.applyNow.length, 2);
  });
});
