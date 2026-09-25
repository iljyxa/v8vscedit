import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readChildObjectRefs } from '../../infra/xml/ChildObjectRefsReader';
import { ObjectXmlReader } from '../../infra/xml/ObjectXmlReader';

/**
 * `ChildObjectRefsReader` — узкий ридер `<ChildObjects>` корня объекта для семи
 * тегов подчинённых единиц хранилища (issue #1, раздел 10, Р2). НЕ расширяет
 * `ObjectXmlReader.parseChildren` (иначе `MetadataValidationService.validateChildTags`
 * начал бы выдавать `disallowed-child`/`unexpected-child` для Recalculation/Table/
 * Cube/DimensionTable — критерий приёмки 10.1.13), поэтому это отдельный модуль,
 * читающий ТОЛЬКО прямых детей `<ChildObjects>` с текстовым содержимым
 * (`<Form>Имя</Form>`), без структурных элементов (`<Command uuid="…">…</Command>`).
 *
 * Все проверки — на реальных объектах `example/2.21/src/cf`: Контрагенты (Form/
 * Template/Command вперемешку — реальная проверка «только текстовые ссылки»),
 * Начисления (Recalculation), ИнтернетМагазин и её Куб «Продажи» (Table/Cube/
 * DimensionTable — двойная вложенность), ПараметрФункциональныхОпций (лист без
 * подчинённых).
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const KONTRAGENTY_XML = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml');
const NACHISLENIYA_XML = path.join(EXAMPLE_CF, 'CalculationRegisters', 'Начисления.xml');
const INTERNET_MAGAZIN_XML = path.join(EXAMPLE_CF, 'ExternalDataSources', 'ИнтернетМагазин.xml');
const PRODAZHI_CUBE_XML = path.join(EXAMPLE_CF, 'ExternalDataSources', 'ИнтернетМагазин', 'Cubes', 'Продажи.xml');
const FUNCTIONAL_OPTION_PARAM_XML = path.join(EXAMPLE_CF, 'FunctionalOptionsParameters', 'ПараметрФункциональныхОпций.xml');

const SUBORDINATE_TAGS = new Set(['Form', 'Template', 'Recalculation', 'Table', 'Cube', 'DimensionTable', 'Subsystem']);

suite('ChildObjectRefsReader — readChildObjectRefs: реальные объекты example/2.21/src/cf', () => {
  test('Контрагенты: Form×2 + Template×1 в порядке появления в XML, Command НЕ попадает (не текстовая ссылка)', () => {
    const refs = readChildObjectRefs(KONTRAGENTY_XML, SUBORDINATE_TAGS);
    assert.deepStrictEqual(refs, [
      { tag: 'Form', name: 'ФормаЭлемента' },
      { tag: 'Form', name: 'ФормаСписка' },
      { tag: 'Template', name: 'ЗагрузкаИзФайла' },
    ]);
  });

  test('Контрагенты: запрошенный tags содержит Command — Command всё равно не возвращается (структурный элемент, не текстовая ссылка)', () => {
    const refs = readChildObjectRefs(KONTRAGENTY_XML, new Set(['Command']));
    assert.deepStrictEqual(refs, []);
  });

  test('Начисления: Recalculation "Перерасчеты"', () => {
    const refs = readChildObjectRefs(NACHISLENIYA_XML, SUBORDINATE_TAGS);
    assert.deepStrictEqual(refs, [{ tag: 'Recalculation', name: 'Перерасчеты' }]);
  });

  test('ИнтернетМагазин: Table "Заказы" + Cube "Продажи" в порядке появления, Function (структурный) не попадает', () => {
    const refs = readChildObjectRefs(INTERNET_MAGAZIN_XML, SUBORDINATE_TAGS);
    assert.deepStrictEqual(refs, [
      { tag: 'Table', name: 'Заказы' },
      { tag: 'Cube', name: 'Продажи' },
    ]);
  });

  test('Куб "Продажи": DimensionTable×2 (двойная вложенность подчинённых единиц)', () => {
    const refs = readChildObjectRefs(PRODAZHI_CUBE_XML, SUBORDINATE_TAGS);
    assert.deepStrictEqual(refs, [
      { tag: 'DimensionTable', name: 'Товары' },
      { tag: 'DimensionTable', name: 'Регионы' },
    ]);
  });

  test('лист без подчинённых (ПараметрФункциональныхОпций) → пустой список, не null (файл существует и разбирается)', () => {
    assert.deepStrictEqual(readChildObjectRefs(FUNCTIONAL_OPTION_PARAM_XML, SUBORDINATE_TAGS), []);
  });

  test('пустой набор запрошенных тегов → пустой список', () => {
    assert.deepStrictEqual(readChildObjectRefs(KONTRAGENTY_XML, new Set()), []);
  });

  test('запрошен только один тег из нескольких присутствующих — возвращается только он', () => {
    assert.deepStrictEqual(readChildObjectRefs(KONTRAGENTY_XML, new Set(['Template'])), [{ tag: 'Template', name: 'ЗагрузкаИзФайла' }]);
  });
});

suite('ChildObjectRefsReader — граничные случаи', () => {
  test('несуществующий файл → null', () => {
    assert.strictEqual(readChildObjectRefs(path.join(EXAMPLE_CF, 'Catalogs', 'НетТакогоФайла.xml'), SUBORDINATE_TAGS), null);
  });

  test('файл существует, но не разбирается как XML → null', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-child-refs-broken-'));
    try {
      const brokenPath = path.join(tempDir, 'Битый.xml');
      fs.writeFileSync(brokenPath, 'это не XML, а произвольный текст <не закрыт', 'utf-8');
      assert.strictEqual(readChildObjectRefs(brokenPath, SUBORDINATE_TAGS), null);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('корректный XML без корневого MetaDataObject → null (не найден корень объекта)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-child-refs-noroot-'));
    try {
      const noRootPath = path.join(tempDir, 'БезКорня.xml');
      fs.writeFileSync(noRootPath, '<?xml version="1.0" encoding="UTF-8"?>\n<ПростоТег/>', 'utf-8');
      assert.strictEqual(readChildObjectRefs(noRootPath, SUBORDINATE_TAGS), null);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * Критерий приёмки 10.1.13: `parseObjectXml` (через `ObjectXmlReader`, единственный
 * ридер, которым пользуется `MetadataValidationService.validateChildTags`) НЕ
 * расширен новыми тегами — иначе `validate_metadata` для Начисления/ИнтернетМагазин
 * начал бы сообщать `disallowed-child`/`unexpected-child` по Recalculation/Table/
 * Cube/DimensionTable, которых нет в `META_TYPES[kind].childTags`. Проверка на
 * реальных объектах: список `children`, который видит валидатор, не содержит эти
 * теги — поведение до и после задачи 10 идентично (ChildObjectRefsReader — ПОЛНОСТЬЮ
 * отдельный узкий ридер, не изменяющий `ObjectXmlReader.parseChildren`).
 */
suite('ChildObjectRefsReader — регресс: parseObjectXml/ObjectXmlReader не расширены (issue #1, критерий 10.1.13)', () => {
  const reader = new ObjectXmlReader();

  test('Начисления: ObjectXmlReader.read(...).children не содержит тег Recalculation', () => {
    const object = reader.read(NACHISLENIYA_XML);
    assert.ok(object);
    assert.ok(!object.children.some((child) => child.tag === 'Recalculation'), 'ObjectXmlReader не должен знать про Recalculation — это работа ChildObjectRefsReader.');
  });

  test('ИнтернетМагазин: ObjectXmlReader.read(...).children не содержит теги Table/Cube', () => {
    const object = reader.read(INTERNET_MAGAZIN_XML);
    assert.ok(object);
    assert.ok(!object.children.some((child) => child.tag === 'Table' || child.tag === 'Cube'));
  });

  test('Куб "Продажи": ObjectXmlReader.read(...).children не содержит тег DimensionTable', () => {
    const object = reader.read(PRODAZHI_CUBE_XML);
    assert.ok(object);
    assert.ok(!object.children.some((child) => child.tag === 'DimensionTable'));
  });
});
