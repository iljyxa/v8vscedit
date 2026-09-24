import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';
import {
  extractChildMetaElementXml,
  extractColumnXmlFromTabularSection,
  findChildMetaElementRange,
} from '../../infra/xml/XmlUtils';

/**
 * Доимствование реквизита/формы/макета/команды в объект расширения, у которого уже заимствована
 * табличная часть, обязано попадать в главный `<ChildObjects>` объекта, а не во вложенный
 * `<ChildObjects>` ТЧ (issue #25). Поиск без учёта вложенности по всему файлу находил первое
 * совпадение как раз внутри ТЧ — поэтому цепочки «ТЧ → дочерний» проверяются на обоих видах
 * вложенного блока: пустом `<ChildObjects/>` и непустом, с колонками.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example/2.21/src');
const CF_DIR = path.join(EXAMPLE_ROOT, 'cf');
const EVOLC_DIR = path.join(EXAMPLE_ROOT, 'cfe', 'EVOLC');
const BOM = '﻿';

/**
 * Минимальная оболочка Configuration.xml расширения — LF без BOM, как отдаёт `writeFileSync` без
 * сохранения формата платформы. Нужна только для сценариев с АвансовыйОтчет, где сам объект
 * (Documents/АвансовыйОтчет.xml) создаёт `CfeBorrowService.borrowObject` при первом заимствовании;
 * готового расширения с заимствованным документом в `example/` нет — EVOLC заимствует только
 * Справочники.
 */
const MINIMAL_EXT_CONFIGURATION_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.21">',
  '\t<Configuration uuid="7a7bf1b9-1eed-4ad9-900d-dcf993f26869">',
  '\t\t<Properties>',
  '\t\t\t<Name>EVOLC</Name>',
  '\t\t</Properties>',
  '\t\t<ChildObjects/>',
  '\t</Configuration>',
  '</MetaDataObject>',
].join('\n');

function countBareLineFeeds(text: string): number {
  return (text.match(/(?<!\r)\n/g) ?? []).length;
}

/**
 * Проверяет, что `actual` — это `original`, в котором ровно участок `[start, end)` заменён
 * вставкой: всё до и после участка совпадает байт-в-байт. Возвращает саму вставку.
 * (Локальная копия helper'а из `cfeBorrowServiceEol.test.ts` — тот файл не правится этой задачей.)
 */
function insertedBetween(original: string, actual: string, start: number, end: number): string {
  const prefix = original.slice(0, start);
  const suffix = original.slice(end);
  assert.ok(actual.startsWith(prefix), 'байты до места вставки должны остаться исходными');
  assert.ok(actual.endsWith(suffix), 'байты после места вставки должны остаться исходными');
  assert.ok(actual.length >= prefix.length + suffix.length);
  return actual.slice(prefix.length, actual.length - suffix.length);
}

suite('CfeBorrowService — вложенные ChildObjects ТЧ', () => {
  suite('Контрагенты (EVOLC, CRLF+BOM) — доимствование после ТЧ КонтактныеЛица', () => {
    let extDir: string;
    let service: CfeBorrowService;
    let file: string;

    setup(() => {
      extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-cfe-nesting-'));
      fs.cpSync(EVOLC_DIR, extDir, { recursive: true });
      service = new CfeBorrowService();
      file = path.join(extDir, 'Catalogs', 'Контрагенты.xml');
    });

    teardown(() => {
      fs.rmSync(extDir, { recursive: true, force: true });
    });

    /** Опорная точка для всех последующих проверок: позиция главного закрывающего `</ChildObjects>`. */
    function mainCloseAt(snapshot: string): number {
      // lastIndexOf('\t\t</ChildObjects>') непригоден: та же подстрока — суффикс вложенного
      // '\t\t\t\t</ChildObjects>' табличной части. Якоримся на паре с закрытием <Catalog>.
      const at = snapshot.indexOf('\r\n\t\t</ChildObjects>\r\n\t</Catalog>');
      assert.ok(at > 0, 'в снимке должен быть главный закрывающий тег ChildObjects перед </Catalog>');
      return at + 2;
    }

    test('предпосылка: после заимствования ТЧ вложенный <ChildObjects/> пустой', () => {
      service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'TabularSection', 'КонтактныеЛица');
      const snapshot = fs.readFileSync(file, 'utf-8');
      assert.ok(snapshot.includes('\t\t\t\t<ChildObjects/>\r\n\t\t\t</TabularSection>'));
    });

    test('форма ФормаСписка после доимствования ТЧ регистрируется в главном ChildObjects объекта', () => {
      service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'TabularSection', 'КонтактныеЛица');
      const snapshot = fs.readFileSync(file, 'utf-8');
      const at = mainCloseAt(snapshot);

      // Список files намеренно не проверяется: он зависит от #26 (borrowForm пока не добавляет
      // objFile в files даже при успешной регистрации) — вне рамок текущей задачи.
      service.borrowForm(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'ФормаСписка');

      const actual = fs.readFileSync(file, 'utf-8');
      const expected = snapshot.slice(0, at) + '\t\t\t<Form>ФормаСписка</Form>\r\n' + snapshot.slice(at);
      assert.strictEqual(actual, expected);
    });

    test('реквизит ИНН после доимствования ТЧ регистрируется в главном ChildObjects объекта', () => {
      service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'TabularSection', 'КонтактныеЛица');
      const snapshot = fs.readFileSync(file, 'utf-8');
      const at = mainCloseAt(snapshot);

      const result = service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'Attribute', 'ИНН');
      assert.strictEqual(result.alreadyBorrowed, false);

      const actual = fs.readFileSync(file, 'utf-8');
      const inserted = insertedBetween(snapshot, actual, at, at);
      assert.match(inserted, /^\t\t\t<Attribute uuid="[0-9a-f-]{36}">\r\n/);
      assert.ok(inserted.includes('\t\t\t\t\t<Name>ИНН</Name>\r\n'));
      assert.ok(inserted.endsWith('\t\t\t</Attribute>\r\n'));
      assert.strictEqual(countBareLineFeeds(actual), 0);
      assert.ok(actual.startsWith(BOM) && !actual.startsWith(BOM + BOM));
    });

    test('макет ЗагрузкаИзФайла после доимствования ТЧ регистрируется в главном ChildObjects объекта', () => {
      service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'TabularSection', 'КонтактныеЛица');
      const snapshot = fs.readFileSync(file, 'utf-8');
      const at = mainCloseAt(snapshot);

      const result = service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'Template', 'ЗагрузкаИзФайла');
      assert.strictEqual(result.alreadyBorrowed, false);

      const actual = fs.readFileSync(file, 'utf-8');
      const expected = snapshot.slice(0, at) + '\t\t\t<Template>ЗагрузкаИзФайла</Template>\r\n' + snapshot.slice(at);
      assert.strictEqual(actual, expected);
    });

    test('команда Покупатели после доимствования ТЧ регистрируется в главном ChildObjects объекта', () => {
      service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'TabularSection', 'КонтактныеЛица');
      const snapshot = fs.readFileSync(file, 'utf-8');
      const at = mainCloseAt(snapshot);

      const result = service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'Command', 'Покупатели');
      assert.strictEqual(result.alreadyBorrowed, false);

      const actual = fs.readFileSync(file, 'utf-8');
      const inserted = insertedBetween(snapshot, actual, at, at);
      assert.match(inserted, /^\t\t\t<Command uuid="[0-9a-f-]{36}">\r\n/);
      assert.ok(inserted.includes('\t\t\t\t\t<Name>Покупатели</Name>\r\n'));
      assert.ok(inserted.endsWith('\t\t\t</Command>\r\n'));
      assert.strictEqual(countBareLineFeeds(actual), 0);
    });

    test('характеризация: текстовая ссылка <Template>…</Template> в главном блоке без childXml остаётся «уже заимствована», без ТЧ', () => {
      // Не требует заимствованной ТЧ вовсе — это характеризация ветки textChildRe/no-childXml,
      // а не регресс #25. Вручную кладём унаследованную текстовую запись, как её мог оставить
      // Конфигуратор старой версии.
      const platformXml = fs.readFileSync(file, 'utf-8');
      const closeAt = platformXml.indexOf('\t\t</ChildObjects>');
      const legacyEntry = '\t\t\t<Template>ЗагрузкаИзФайла</Template>\r\n';
      const original = platformXml.slice(0, closeAt) + legacyEntry + platformXml.slice(closeAt);
      fs.writeFileSync(file, original, 'utf-8');

      const result = service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'Template', 'ЗагрузкаИзФайла');

      assert.deepStrictEqual(result, { alreadyBorrowed: true, files: [] });
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), original);
    });

    test('характеризация: повторное заимствование формы ФормаСписка идемпотентно независимо от места первой записи', () => {
      service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'TabularSection', 'КонтактныеЛица');
      service.borrowForm(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'ФормаСписка');
      const afterFirst = fs.readFileSync(file, 'utf-8');

      const repeat = service.borrowForm(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'ФормаСписка');

      assert.deepStrictEqual(repeat, { alreadyBorrowed: true, files: [] });
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), afterFirst);
    });
  });

  suite('АвансовыйОтчет (Document, оболочку создаёт сервис, LF без BOM) — доимствование после ТЧ ТабличнаяЧасть1', () => {
    let extDir: string;
    let service: CfeBorrowService;
    let file: string;

    setup(() => {
      extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-cfe-nesting-doc-'));
      fs.writeFileSync(path.join(extDir, 'Configuration.xml'), MINIMAL_EXT_CONFIGURATION_XML, 'utf-8');
      service = new CfeBorrowService();
      file = path.join(extDir, 'Documents', 'АвансовыйОтчет.xml');
    });

    teardown(() => {
      fs.rmSync(extDir, { recursive: true, force: true });
    });

    function borrowTabularSection(): string {
      const result = service.borrowChild(
        CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'TabularSection', 'ТабличнаяЧасть1'
      );
      assert.strictEqual(result.alreadyBorrowed, false);
      return fs.readFileSync(file, 'utf-8');
    }

    /** Опорная точка: позиция главного закрывающего `</ChildObjects>` перед `</Document>`. */
    function mainCloseAt(snapshot: string): number {
      const at = snapshot.indexOf('\n\t\t</ChildObjects>\n\t</Document>');
      assert.ok(at > 0, 'в снимке должен быть главный закрывающий тег ChildObjects перед </Document>');
      return at + 1;
    }

    function tabularSectionSlice(xml: string): string {
      const range = findChildMetaElementRange(xml, 'TabularSection', 'ТабличнаяЧасть1');
      assert.ok(range, 'в XML должна быть заимствованная ТабличнаяЧасть1');
      return xml.slice(range.start, range.end);
    }

    test('реквизит объекта Реквизит1 после доимствования ТЧ регистрируется в главном ChildObjects документа, блок ТЧ не меняется', () => {
      const snapshot = borrowTabularSection();
      const at = mainCloseAt(snapshot);
      const tsBefore = tabularSectionSlice(snapshot);

      const result = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Attribute', 'Реквизит1');
      assert.strictEqual(result.alreadyBorrowed, false);

      const actual = fs.readFileSync(file, 'utf-8');
      assert.ok(!actual.includes('\r'), 'оболочка документа генерируется сервисом с LF, без CRLF');
      assert.strictEqual(tabularSectionSlice(actual), tsBefore, 'блок ТЧ должен остаться байт-в-байт');

      const inserted = insertedBetween(snapshot, actual, at, at);
      assert.match(inserted, /^\t\t\t<Attribute uuid="[0-9a-f-]{36}">\n/);
      assert.ok(inserted.includes('\t\t\t\t\t<Name>Реквизит1</Name>\n'));
      assert.ok(inserted.endsWith('\t\t\t</Attribute>\n'));
    });

    test('макет Макет после доимствования ТЧ регистрируется в главном ChildObjects документа', () => {
      const snapshot = borrowTabularSection();
      const at = mainCloseAt(snapshot);

      const result = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Template', 'Макет');
      assert.strictEqual(result.alreadyBorrowed, false);

      const actual = fs.readFileSync(file, 'utf-8');
      const expected = snapshot.slice(0, at) + '\t\t\t<Template>Макет</Template>\n' + snapshot.slice(at);
      assert.strictEqual(actual, expected);
    });

    test('команда Команда1 после доимствования ТЧ регистрируется в главном ChildObjects документа, блок ТЧ не меняется', () => {
      const snapshot = borrowTabularSection();
      const at = mainCloseAt(snapshot);
      const tsBefore = tabularSectionSlice(snapshot);

      const result = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Command', 'Команда1');
      assert.strictEqual(result.alreadyBorrowed, false);

      const actual = fs.readFileSync(file, 'utf-8');
      assert.strictEqual(tabularSectionSlice(actual), tsBefore, 'блок ТЧ должен остаться байт-в-байт');

      const inserted = insertedBetween(snapshot, actual, at, at);
      assert.match(inserted, /^\t\t\t<Command uuid="[0-9a-f-]{36}">\n/);
      assert.ok(inserted.endsWith('\t\t\t</Command>\n'));
    });

    test('одноимённые элементы: реквизит объекта Реквизит1 не путается с одноимённой колонкой ТЧ и идемпотентен', () => {
      borrowTabularSection();

      const first = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Attribute', 'Реквизит1');
      assert.strictEqual(first.alreadyBorrowed, false);
      assert.strictEqual(first.files.length, 1);
      assert.strictEqual(first.files[0], file);

      const afterFirst = fs.readFileSync(file, 'utf-8');
      assert.notStrictEqual(extractChildMetaElementXml(afterFirst, 'Attribute', 'Реквизит1'), null);
      assert.notStrictEqual(
        extractColumnXmlFromTabularSection(afterFirst, 'ТабличнаяЧасть1', 'Реквизит1'), null,
        'колонка ТЧ должна остаться на месте — реквизит верхнего уровня не заменяет и не трогает её'
      );

      const repeat = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Attribute', 'Реквизит1');
      assert.deepStrictEqual(repeat, { alreadyBorrowed: true, files: [] });
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), afterFirst, 'повторный вызов не должен менять файл');
    });

    test('характеризация: обратный порядок (сначала реквизит объекта, затем ТЧ) не задевает друг друга, повтор реквизита идемпотентен', () => {
      // Порядок, в котором вложенного <ChildObjects> ТЧ ещё нет в момент регистрации реквизита:
      // фиксирует, что повтор находит реквизит в главном блоке и после появления ТЧ.
      const r1 = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Attribute', 'Реквизит1');
      assert.strictEqual(r1.alreadyBorrowed, false);

      const r2 = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'TabularSection', 'ТабличнаяЧасть1');
      assert.strictEqual(r2.alreadyBorrowed, false);

      const afterTs = fs.readFileSync(file, 'utf-8');
      assert.notStrictEqual(extractChildMetaElementXml(afterTs, 'Attribute', 'Реквизит1'), null);

      const r3 = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Attribute', 'Реквизит1');
      assert.deepStrictEqual(r3, { alreadyBorrowed: true, files: [] });
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), afterTs);
    });

    test('характеризация: повторное заимствование макета Макет идемпотентно', () => {
      borrowTabularSection();
      const first = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Template', 'Макет');
      assert.strictEqual(first.alreadyBorrowed, false);
      const afterFirst = fs.readFileSync(file, 'utf-8');

      const repeat = service.borrowChild(CF_DIR, extDir, 'Document', 'АвансовыйОтчет', 'Template', 'Макет');

      assert.deepStrictEqual(repeat, { alreadyBorrowed: true, files: [] });
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), afterFirst);
    });
  });
});
