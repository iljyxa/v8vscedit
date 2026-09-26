import * as assert from 'assert';
import * as path from 'path';
import {
  isImmediatelyApplicable,
  selectReadonlyApplyRoute,
  type ReadonlyTabCandidate,
  type ReadonlyTabRole,
} from '../../ui/readonly/readonlyTabSelection';

/**
 * Issue #63 — выбор способа применить readonly к файлу по его открытым вкладкам.
 * Файл проекта теперь может быть открыт только левой стороной сравнения, а
 * readonly-команды VS Code действуют лишь на правую сторону активного редактора.
 */

interface Tab extends ReadonlyTabCandidate {
  id: string;
}

const ROOT = path.resolve('/проект/src/cf');
const FILE = path.join(ROOT, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
const OTHER = path.join(ROOT, 'Catalogs', 'Товары', 'Ext', 'ManagerModule.bsl');

function tab(id: string, role: ReadonlyTabRole, visible: boolean, viewColumn = 1, filePath = FILE): Tab {
  return { id, path: filePath, role, visible, viewColumn };
}

suite('readonlyTabSelection — selectReadonlyApplyRoute (issue #63)', () => {
  test('нет вкладок этого файла → undefined', () => {
    assert.strictEqual(selectReadonlyApplyRoute([tab('x', 'text', true, 1, OTHER)], FILE), undefined);
    assert.strictEqual(selectReadonlyApplyRoute([], FILE), undefined);
  });

  test('видимая обычная вкладка → activate её', () => {
    const route = selectReadonlyApplyRoute([tab('other', 'text', true, 1, OTHER), tab('t', 'text', true, 2)], FILE);
    assert.deepStrictEqual(route && { kind: route.kind, id: route.tab.id }, { kind: 'activate', id: 't' });
  });

  test('видимая правая сторона сравнения → activate её', () => {
    const route = selectReadonlyApplyRoute([tab('m', 'diff-modified', true, 3)], FILE);
    assert.deepStrictEqual(route && { kind: route.kind, id: route.tab.id }, { kind: 'activate', id: 'm' });
  });

  test('видимая обычная вкладка важнее левой стороны сравнения → activate', () => {
    const route = selectReadonlyApplyRoute([tab('o', 'diff-original', true, 1), tab('t', 'text', true, 2)], FILE);
    assert.deepStrictEqual(route && { kind: route.kind, id: route.tab.id }, { kind: 'activate', id: 't' });
  });

  test('скрытая обычная + левая сторона сравнения → temporary в колонке сравнения', () => {
    const route = selectReadonlyApplyRoute([tab('t', 'text', false, 1), tab('o', 'diff-original', true, 2)], FILE);
    assert.deepStrictEqual(route && { kind: route.kind, id: route.tab.id, column: route.tab.viewColumn }, { kind: 'temporary', id: 'o', column: 2 });
  });

  test('только скрытая левая сторона сравнения → temporary (не defer)', () => {
    const route = selectReadonlyApplyRoute([tab('o', 'diff-original', false, 1)], FILE);
    assert.deepStrictEqual(route && { kind: route.kind, id: route.tab.id }, { kind: 'temporary', id: 'o' });
  });

  test('две левые стороны сравнения — выбирается видимая', () => {
    const route = selectReadonlyApplyRoute([tab('hidden', 'diff-original', false, 1), tab('shown', 'diff-original', true, 2)], FILE);
    assert.deepStrictEqual(route && { kind: route.kind, id: route.tab.id }, { kind: 'temporary', id: 'shown' });
  });

  test('только скрытые основные вкладки → defer по первой', () => {
    const route = selectReadonlyApplyRoute([tab('t', 'text', false, 1), tab('m', 'diff-modified', false, 2)], FILE);
    assert.deepStrictEqual(route && { kind: route.kind, id: route.tab.id }, { kind: 'defer', id: 't' });
  });

  test('сравнение путей не зависит от регистра и сегментов ".."', () => {
    const variant = path.join(ROOT, 'Catalogs', 'Лишнее', '..', 'Товары', 'Ext', 'OBJECTMODULE.BSL');
    const route = selectReadonlyApplyRoute([tab('t', 'text', true, 1, variant)], FILE);
    assert.strictEqual(route?.tab.id, 't');
  });
});

suite('readonlyTabSelection — isImmediatelyApplicable (issue #63)', () => {
  const cases: { role: ReadonlyTabRole; visible: boolean; expected: boolean }[] = [
    { role: 'text', visible: true, expected: true },
    { role: 'text', visible: false, expected: false },
    { role: 'diff-modified', visible: true, expected: true },
    { role: 'diff-modified', visible: false, expected: false },
    { role: 'diff-original', visible: true, expected: true },
    { role: 'diff-original', visible: false, expected: true },
  ];
  for (const { role, visible, expected } of cases) {
    test(`${role}, visible=${String(visible)} → ${String(expected)}`, () => {
      assert.strictEqual(isImmediatelyApplicable({ role, visible }), expected);
    });
  }
});
