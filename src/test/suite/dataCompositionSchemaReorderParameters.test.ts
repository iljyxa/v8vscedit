import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService } from '../../infra/xml/DataCompositionSchemaService';

/**
 * reorder-parameters на реальной выгрузке 1С (iljyxa/v8vscedit#29). Отчёт «Запасы» содержит
 * три параметра схемы между dataSetLink и первым settingsVariant (BOM + CRLF). Порядок
 * элементов корня СКД — xs:sequence, поэтому параметры обязаны остаться на своём месте,
 * а перестановка — не оставлять пустых строк на месте прежних блоков.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example');
const REL_PATH = 'Reports/Запасы/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml';
const CURRENT_ORDER = ['Период', 'НачалоПериода', 'КонецПериода'] as const;

function copyFixture(version: '2.20' | '2.21'): { readonly templatePath: string; readonly original: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-skd-reorder-'));
  const templatePath = path.join(root, 'Ext', 'Template.xml');
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.copyFileSync(path.join(EXAMPLE_ROOT, version, 'src', 'cf', REL_PATH), templatePath);
  return { templatePath, original: fs.readFileSync(templatePath, 'utf-8') };
}

/**
 * Независимый от реализации оракул: в фикстуре ровно три `<parameter>`, все — прямые дети
 * корня, поэтому блоки находятся простым поиском подстроки.
 */
function parameterSlots(xml: string): { readonly start: number; readonly end: number; readonly name: string }[] {
  const slots: { start: number; end: number; name: string }[] = [];
  let from = 0;
  for (;;) {
    const start = xml.indexOf('<parameter>', from);
    if (start === -1) {
      return slots;
    }
    const end = xml.indexOf('</parameter>', start) + '</parameter>'.length;
    const name = /<name>([^<]*)<\/name>/.exec(xml.slice(start, end))?.[1] ?? '';
    slots.push({ start, end, name });
    from = end;
  }
}

function permuteSlots(xml: string, order: readonly string[]): string {
  const slots = parameterSlots(xml);
  const blockOf = (name: string) => {
    const slot = slots.find((item) => item.name === name);
    assert.ok(slot, `в фикстуре нет параметра ${name}`);
    return xml.slice(slot.start, slot.end);
  };
  let result = xml;
  for (let i = slots.length - 1; i >= 0; i--) {
    result = result.slice(0, slots[i].start) + blockOf(order[i]) + result.slice(slots[i].end);
  }
  return result;
}

suite('DataCompositionSchemaService.edit — reorder-parameters на реальной выгрузке (#29)', () => {
  for (const version of ['2.20', '2.21'] as const) {
    suite(version, () => {
      test('контроль фикстуры: три параметра, все до первого settingsVariant', () => {
        const { original } = copyFixture(version);
        const slots = parameterSlots(original);
        assert.deepStrictEqual(slots.map((slot) => slot.name), [...CURRENT_ORDER]);
        assert.ok(slots[slots.length - 1].end < original.indexOf('<settingsVariant>'));
      });

      test('текущий порядок: changedFiles, lines и warnings пусты, файл байт-в-байт прежний', () => {
        const { templatePath, original } = copyFixture(version);
        const service = new DataCompositionSchemaService();

        const result = service.edit({ templatePath, operation: 'reorder-parameters', value: CURRENT_ORDER.join(', ') });

        assert.deepStrictEqual(result.changedFiles, []);
        assert.deepStrictEqual(result.lines, []);
        assert.deepStrictEqual(result.warnings, []);
        assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), original);
      });

      test('обратный порядок: блоки переставлены на своих местах до settingsVariant, обратная перестановка возвращает исходник', () => {
        const { templatePath, original } = copyFixture(version);
        const service = new DataCompositionSchemaService();
        const reversed = [...CURRENT_ORDER].reverse();

        const result = service.edit({ templatePath, operation: 'reorder-parameters', value: reversed.join(', ') });

        assert.deepStrictEqual(result.changedFiles, [templatePath]);
        assert.deepStrictEqual(result.warnings, []);
        const after = fs.readFileSync(templatePath, 'utf-8');
        assert.strictEqual(after, permuteSlots(original, reversed));
        assert.ok(parameterSlots(after)[2].end < after.indexOf('<settingsVariant>'), 'параметры обязаны остаться до settingsVariant');
        assert.ok(!/\r\n[ \t]*\r\n/.test(after), 'на месте прежних блоков не должно остаться пустых строк');

        service.edit({ templatePath, operation: 'reorder-parameters', value: CURRENT_ORDER.join(', ') });
        assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), original);
      });

      test('неполный список: названные параметры идут первыми, остальные — в прежнем порядке; неизвестное имя — предупреждение', () => {
        const { templatePath, original } = copyFixture(version);
        const service = new DataCompositionSchemaService();

        const result = service.edit({ templatePath, operation: 'reorder-parameters', value: 'НетТакого, КонецПериода' });

        assert.deepStrictEqual(result.warnings, ['reorder-parameters: параметр не найден: НетТакого.']);
        assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), permuteSlots(original, ['КонецПериода', 'Период', 'НачалоПериода']));
      });

      test('повтор имени в списке: второе упоминание — предупреждение, параметр не дублируется', () => {
        const { templatePath, original } = copyFixture(version);
        const service = new DataCompositionSchemaService();

        const result = service.edit({ templatePath, operation: 'reorder-parameters', value: 'КонецПериода, КонецПериода' });

        assert.deepStrictEqual(result.warnings, ['reorder-parameters: параметр указан повторно: КонецПериода.']);
        assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), permuteSlots(original, ['КонецПериода', 'Период', 'НачалоПериода']));
      });

      test('вложенный <parameter> в dataSetLink — не параметр схемы: остаётся внутри связи', () => {
        const { templatePath, original } = copyFixture(version);
        // Параметр связи наборов — прямой ребёнок dataSetLink в формате платформы; совпадение
        // текста с именем параметра схемы делает проверку строгой.
        const linkParameter = '\t\t<parameter>Период</parameter>\r\n';
        const closeLink = '\t</dataSetLink>';
        assert.strictEqual(original.split(closeLink).length, 2, 'в фикстуре ожидается ровно одна dataSetLink');
        const withLinkParameter = original.replace(closeLink, `${linkParameter}${closeLink}`);
        fs.writeFileSync(templatePath, withLinkParameter, 'utf-8');
        const service = new DataCompositionSchemaService();

        const result = service.edit({ templatePath, operation: 'reorder-parameters', value: 'КонецПериода, НачалоПериода, Период' });

        assert.deepStrictEqual(result.warnings, []);
        const after = fs.readFileSync(templatePath, 'utf-8');
        assert.ok(after.includes(`${linkParameter}${closeLink}`), 'параметр связи обязан остаться внутри dataSetLink');
        const expected = permuteSlots(original, ['КонецПериода', 'НачалоПериода', 'Период']).replace(closeLink, `${linkParameter}${closeLink}`);
        assert.strictEqual(after, expected);
      });
    });
  }

  test('схема без корня DataCompositionSchema: предупреждение, файл не меняется', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-skd-reorder-noroot-'));
    const templatePath = path.join(root, 'Ext', 'Template.xml');
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Other>\n\t<parameter>\n\t\t<name>А</name>\n\t</parameter>\n</Other>\n';
    fs.writeFileSync(templatePath, xml, 'utf-8');

    const result = new DataCompositionSchemaService().edit({ templatePath, operation: 'reorder-parameters', value: 'А' });

    assert.deepStrictEqual(result.warnings, ['reorder-parameters: не найден корень DataCompositionSchema.']);
    assert.deepStrictEqual(result.changedFiles, []);
    assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), xml);
  });
});
