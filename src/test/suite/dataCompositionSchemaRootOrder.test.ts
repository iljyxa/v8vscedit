import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService, type SkdEditOperation } from '../../infra/xml/DataCompositionSchemaService';

/**
 * Порядок прямых детей корня схемы СКД при add-* (iljyxa/v8vscedit#31). Эталон порядка снят
 * с выгрузки платформы 8.3.27 и 8.5.1 (import → export переставляет элементы именно так):
 * dataSource, dataSet, dataSetLink, calculatedField, totalField, parameter, template,
 * groupTemplate, settingsVariant. Фикстура — отчёт «Запасы» (BOM + CRLF): dataSource,
 * 2 dataSet, dataSetLink, 3 parameter, 2 settingsVariant.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example');
const REL_PATH = 'Reports/Запасы/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml';
const FIXTURE_TAGS = [
  'dataSource', 'dataSet', 'dataSet', 'dataSetLink', 'parameter', 'parameter', 'parameter', 'settingsVariant', 'settingsVariant',
];

function copyFixture(version: '2.20' | '2.21'): { readonly templatePath: string; readonly original: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-skd-root-order-'));
  const templatePath = path.join(root, 'Ext', 'Template.xml');
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.copyFileSync(path.join(EXAMPLE_ROOT, version, 'src', 'cf', REL_PATH), templatePath);
  return { templatePath, original: fs.readFileSync(templatePath, 'utf-8') };
}

/** Прямые дети корня: в выгрузке платформы они и только они стоят на одном `\t`. */
function rootTags(xml: string): string[] {
  return [...xml.matchAll(/^\t<([A-Za-z]+)\b/gm)].map((match) => match[1]);
}

interface Case {
  readonly operation: SkdEditOperation;
  readonly value: string;
  readonly tag: string;
  /** Первый элемент исходника, перед которым обязан встать новый. */
  readonly anchor: string;
  readonly expectedTags: readonly string[];
}

function tagsWith(index: number, tag: string): string[] {
  return [...FIXTURE_TAGS.slice(0, index), tag, ...FIXTURE_TAGS.slice(index)];
}

const CASES: readonly Case[] = [
  { operation: 'add-dataSet', value: 'Набор31: ВЫБРАТЬ 1 КАК Поле', tag: 'dataSet', anchor: '\t<dataSetLink>', expectedTags: tagsWith(3, 'dataSet') },
  { operation: 'add-dataSetLink', value: 'ТоварыИПоступление > Цены on Номенклатура = Номенклатура', tag: 'dataSetLink', anchor: '\t<parameter>', expectedTags: tagsWith(4, 'dataSetLink') },
  { operation: 'add-calculated-field', value: 'Выч31: decimal(15,2) = 1', tag: 'calculatedField', anchor: '\t<parameter>', expectedTags: tagsWith(4, 'calculatedField') },
  { operation: 'add-total', value: 'КоличествоОстаток: Сумма', tag: 'totalField', anchor: '\t<parameter>', expectedTags: tagsWith(4, 'totalField') },
  { operation: 'add-parameter', value: 'Тест31: string', tag: 'parameter', anchor: '\t<settingsVariant>', expectedTags: tagsWith(7, 'parameter') },
  { operation: 'add-drilldown', value: 'Номенклатура', tag: 'template', anchor: '\t<settingsVariant>', expectedTags: tagsWith(7, 'template') },
];

suite('DataCompositionSchemaService.edit — add-* соблюдают порядок корня схемы (#31)', () => {
  for (const version of ['2.20', '2.21'] as const) {
    suite(version, () => {
      test('контроль фикстуры: состав и порядок прямых детей корня', () => {
        assert.deepStrictEqual(rootTags(copyFixture(version).original), FIXTURE_TAGS);
      });

      for (const item of CASES) {
        test(`${item.operation}: <${item.tag}> встаёт перед «${item.anchor.trim()}», остальной документ не меняется`, () => {
          const { templatePath, original } = copyFixture(version);
          const anchorAt = original.indexOf(item.anchor);
          assert.ok(anchorAt !== -1);

          const result = new DataCompositionSchemaService().edit({ templatePath, operation: item.operation, value: item.value });

          assert.deepStrictEqual(result.changedFiles, [templatePath]);
          const after = fs.readFileSync(templatePath, 'utf-8');
          assert.deepStrictEqual(rootTags(after), item.expectedTags);
          const head = original.slice(0, anchorAt);
          const tail = original.slice(anchorAt);
          assert.ok(after.startsWith(head), 'текст до места вставки не меняется');
          assert.ok(after.endsWith(tail), 'текст после места вставки не меняется');
          const inserted = after.slice(head.length, after.length - tail.length);
          assert.ok(inserted.startsWith(`\t<${item.tag}`), `вставка начинается с <${item.tag}> на одном отступе`);
          assert.ok(inserted.endsWith(`\t</${item.tag}>\r\n`), 'вставка заканчивается закрывающим тегом и EOL файла');
        });
      }

      test('add-total, затем add-calculated-field: вычисляемое поле встаёт перед итогом', () => {
        const { templatePath } = copyFixture(version);
        const service = new DataCompositionSchemaService();

        service.edit({ templatePath, operation: 'add-total', value: 'КоличествоОстаток: Сумма' });
        service.edit({ templatePath, operation: 'add-calculated-field', value: 'Выч31: decimal(15,2) = 1' });

        assert.deepStrictEqual(rootTags(fs.readFileSync(templatePath, 'utf-8')), [
          ...FIXTURE_TAGS.slice(0, 4), 'calculatedField', 'totalField', ...FIXTURE_TAGS.slice(4),
        ]);
      });

      test('modify-parameter с неизвестным именем добавляет параметр после существующих, перед settingsVariant', () => {
        const { templatePath } = copyFixture(version);

        const result = new DataCompositionSchemaService().edit({ templatePath, operation: 'modify-parameter', value: 'Тест31: string' });

        assert.deepStrictEqual(result.warnings, ['Параметр не найден, добавлен новый: Тест31.']);
        assert.deepStrictEqual(rootTags(fs.readFileSync(templatePath, 'utf-8')), tagsWith(7, 'parameter'));
      });

      test('add-dataSet без единого тега dataSource в схеме (в т.ч. внутри существующих dataSet): источник данных по умолчанию — ИсточникДанных1', () => {
        const { templatePath, original } = copyFixture(version);
        const withoutSource = original.replace(/[ \t]*<dataSource>[\s\S]*?<\/dataSource>\r?\n/g, '');
        assert.ok(!withoutSource.includes('<dataSource>'), 'фикстура должна лишиться всех тегов dataSource, включая вложенные в dataSet');
        fs.writeFileSync(templatePath, withoutSource, 'utf-8');

        new DataCompositionSchemaService().edit({ templatePath, operation: 'add-dataSet', value: 'Набор31: ВЫБРАТЬ 1 КАК Поле' });

        const after = fs.readFileSync(templatePath, 'utf-8');
        assert.deepStrictEqual(rootTags(after), [...FIXTURE_TAGS.slice(1, 3), 'dataSet', ...FIXTURE_TAGS.slice(3)]);
        const inserted = after.slice(0, after.indexOf('\t<dataSetLink>'));
        assert.ok(inserted.includes('<dataSource>ИсточникДанных1</dataSource>'), 'без блока dataSource в схеме источник данных набора — значение по умолчанию');
      });

      test('нет последующих элементов (схема без settingsVariant): параметр встаёт перед закрытием корня', () => {
        const { templatePath, original } = copyFixture(version);
        const variantsAt = original.indexOf('\t<settingsVariant>');
        const withoutVariants = `${original.slice(0, variantsAt)}</DataCompositionSchema>`;
        fs.writeFileSync(templatePath, withoutVariants, 'utf-8');

        new DataCompositionSchemaService().edit({ templatePath, operation: 'add-parameter', value: 'Тест31: string' });

        const after = fs.readFileSync(templatePath, 'utf-8');
        assert.deepStrictEqual(rootTags(after), [...FIXTURE_TAGS.slice(0, 7), 'parameter']);
        assert.ok(after.startsWith(withoutVariants.slice(0, variantsAt).trimEnd()));
        assert.ok(after.endsWith('\t</parameter>\r\n</DataCompositionSchema>'));
      });
    });
  }

  test('схема без корня DataCompositionSchema: add-total файл не меняет', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-skd-root-order-noroot-'));
    const templatePath = path.join(root, 'Ext', 'Template.xml');
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Other>\n\t<parameter>\n\t\t<name>А</name>\n\t</parameter>\n</Other>\n';
    fs.writeFileSync(templatePath, xml, 'utf-8');

    const result = new DataCompositionSchemaService().edit({ templatePath, operation: 'add-total', value: 'А: Сумма' });

    assert.deepStrictEqual(result.changedFiles, []);
    assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), xml);
  });
});
