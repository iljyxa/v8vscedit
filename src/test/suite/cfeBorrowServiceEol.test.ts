import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';

/**
 * Доимствование в существующий XML объекта расширения не должно ломать формат платформы.
 *
 * Объекты Контрагенты (с заимствованным реквизитом КПП — непустой `<ChildObjects>`) и
 * Номенклатура (`<ChildObjects/>`) заимствованы в EVOLC Конфигуратором, поэтому их файлы — CRLF
 * с BOM. Сервис собирает вставки через `\n`; запись обязана вернуть неизменённые байты файла как
 * есть, а вставленным строкам дать CRLF окружения — иначе в файл подмешиваются голые LF.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example/2.21/src');
const CF_DIR = path.join(EXAMPLE_ROOT, 'cf');
const EVOLC_DIR = path.join(EXAMPLE_ROOT, 'cfe', 'EVOLC');
const BOM = '﻿';

function countBareLineFeeds(text: string): number {
  return (text.match(/(?<!\r)\n/g) ?? []).length;
}

/**
 * Проверяет, что `actual` — это `original`, в котором ровно участок `[start, end)` заменён
 * вставкой: всё до и после участка совпадает байт-в-байт. Возвращает саму вставку.
 */
function insertedBetween(original: string, actual: string, start: number, end: number): string {
  const prefix = original.slice(0, start);
  const suffix = original.slice(end);
  assert.ok(actual.startsWith(prefix), 'байты до места вставки должны остаться исходными');
  assert.ok(actual.endsWith(suffix), 'байты после места вставки должны остаться исходными');
  assert.ok(actual.length >= prefix.length + suffix.length);
  return actual.slice(prefix.length, actual.length - suffix.length);
}

suite('CfeBorrowService — доимствование в XML объекта расширения сохраняет CRLF и BOM платформы', () => {
  let extDir: string;
  let service: CfeBorrowService;

  const objectFile = (name: string): string => path.join(extDir, 'Catalogs', `${name}.xml`);

  setup(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-cfe-borrow-eol-'));
    fs.cpSync(EVOLC_DIR, extDir, { recursive: true });
    service = new CfeBorrowService();
  });

  teardown(() => {
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  test('фикстура: заимствованные объекты — CRLF с BOM без единой голой LF', () => {
    for (const name of ['Контрагенты', 'Номенклатура']) {
      const xml = fs.readFileSync(objectFile(name), 'utf-8');
      assert.ok(xml.startsWith(BOM), `${name}: BOM`);
      assert.ok(xml.includes('\r\n'), `${name}: CRLF`);
      assert.strictEqual(countBareLineFeeds(xml), 0, `${name}: голые LF`);
    }
  });

  test('реквизит в непустой <ChildObjects>: вставка перед </ChildObjects> в CRLF, остальное байт-в-байт', () => {
    const file = objectFile('Контрагенты');
    const original = fs.readFileSync(file, 'utf-8');
    const closeAt = original.indexOf('\t\t</ChildObjects>');
    assert.ok(closeAt > 0);

    const result = service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'Attribute', 'ИНН');

    assert.deepStrictEqual(result, { alreadyBorrowed: false, files: [file] });
    const actual = fs.readFileSync(file, 'utf-8');
    const inserted = insertedBetween(original, actual, closeAt, closeAt);
    assert.match(inserted, /^\t\t\t<Attribute uuid="[0-9a-f-]{36}">\r\n/);
    assert.ok(inserted.includes('\t\t\t\t\t<Name>ИНН</Name>\r\n'));
    assert.ok(inserted.includes('\t\t\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>\r\n'));
    assert.ok(inserted.endsWith('\t\t\t</Attribute>\r\n'));
    assert.strictEqual(countBareLineFeeds(actual), 0);
    assert.ok(actual.startsWith(BOM) && !actual.startsWith(BOM + BOM));
  });

  test('реквизит в пустой <ChildObjects/>: блок раскрывается в CRLF, остальное байт-в-байт', () => {
    const file = objectFile('Номенклатура');
    const original = fs.readFileSync(file, 'utf-8');
    const emptyAt = original.indexOf('<ChildObjects/>');
    assert.ok(emptyAt > 0);

    const result = service.borrowChild(CF_DIR, extDir, 'Catalog', 'Номенклатура', 'Attribute', 'Реквизит2');

    assert.deepStrictEqual(result, { alreadyBorrowed: false, files: [file] });
    const actual = fs.readFileSync(file, 'utf-8');
    const inserted = insertedBetween(original, actual, emptyAt, emptyAt + '<ChildObjects/>'.length);
    assert.match(inserted, /^<ChildObjects>\r\n\t\t\t<Attribute uuid="[0-9a-f-]{36}">\r\n/);
    assert.ok(inserted.includes('\t\t\t\t\t<Name>Реквизит2</Name>\r\n'));
    assert.ok(inserted.endsWith('\t\t\t</Attribute>\r\n\t\t</ChildObjects>'));
    assert.strictEqual(countBareLineFeeds(actual), 0);
    assert.ok(actual.startsWith(BOM) && !actual.startsWith(BOM + BOM));
  });

  test('унаследованная текстовая запись <Attribute>Имя</Attribute> заменяется полным блоком в CRLF', () => {
    // Текстовая запись дочернего — след прежних версий сервиса: вставляем её в настоящий файл
    // платформы в его же стиле (CRLF), чтобы проверить ветку замены записи полным описанием.
    const file = objectFile('Контрагенты');
    const platformXml = fs.readFileSync(file, 'utf-8');
    const closeAt = platformXml.indexOf('\t\t</ChildObjects>');
    const legacyEntry = '\t\t\t<Attribute>ИНН</Attribute>\r\n';
    const original = platformXml.slice(0, closeAt) + legacyEntry + platformXml.slice(closeAt);
    fs.writeFileSync(file, original, 'utf-8');

    const result = service.borrowChild(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'Attribute', 'ИНН');

    assert.deepStrictEqual(result, { alreadyBorrowed: false, files: [file] });
    const actual = fs.readFileSync(file, 'utf-8');
    assert.ok(!actual.includes('<Attribute>ИНН</Attribute>'));
    // Регулярка сервиса съедает пробельный хвост перед записью (перевод строки после
    // `</Attribute>` КПП): вставка начинается с него и заканчивается переводом строки записи.
    const replacedFrom = platformXml.lastIndexOf('</Attribute>', closeAt) + '</Attribute>'.length;
    const inserted = insertedBetween(original, actual, replacedFrom, closeAt + legacyEntry.length);
    assert.match(inserted, /^\r\n\t\t\t<Attribute uuid="[0-9a-f-]{36}">\r\n/);
    assert.ok(inserted.includes('\t\t\t\t\t<Name>ИНН</Name>\r\n'));
    assert.ok(inserted.endsWith('\t\t\t</Attribute>\r\n'));
    assert.strictEqual(countBareLineFeeds(actual), 0);
  });

  test('форма: запись <Form> в XML объекта — ровно одна CRLF-строка перед </ChildObjects>', () => {
    const file = objectFile('Контрагенты');
    const original = fs.readFileSync(file, 'utf-8');

    const result = service.borrowForm(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');

    assert.strictEqual(result.alreadyBorrowed, false);
    assert.strictEqual(
      fs.readFileSync(file, 'utf-8'),
      original.replace('\t\t</ChildObjects>', '\t\t\t<Form>ФормаЭлемента</Form>\r\n\t\t</ChildObjects>')
    );
  });
});
