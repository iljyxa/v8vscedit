import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService } from '../../infra/xml/DataCompositionSchemaService';

/**
 * modify-parameter на реальной выгрузке 1С (iljyxa/v8vscedit#32). Отчёт «Запасы»: BOM + CRLF,
 * dataSetLink перед тремя параметрами схемы. Параметр ищется только среди прямых детей корня:
 * самозакрывающийся вложенный <parameter/> раньше становился началом «блока» до </parameter>
 * следующего параметра схемы, и замена съедала </dataSetLink>.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example');
const REL_PATH = 'Reports/Запасы/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml';

/** Ожидаемый блок `НачалоПериода [Начало периода]: date`: ведущий отступ остаётся в исходнике, EOL — файла (CRLF). */
const START_PERIOD_BLOCK =
  '<parameter>' + '\r\n'
  + '\t\t<name>НачалоПериода</name>' + '\r\n'
  + '\t\t<title xsi:type="v8:LocalStringType">' + '\r\n'
  + '\t\t\t<v8:item><v8:lang>ru</v8:lang><v8:content>Начало периода</v8:content></v8:item>' + '\r\n'
  + '\t\t</title>' + '\r\n'
  + '\t\t<valueType>' + '\r\n'
  + '\t\t\t<v8:Type>xs:dateTime</v8:Type>' + '\r\n'
  + '\t\t</valueType>' + '\r\n'
  + '\t</parameter>';

/**
 * Ожидаемый блок `Период [Период]: date`. `Период` — первый параметр после dataSetLink: при
 * вложенном <parameter/> старая регулярка портила именно его блок (захватывала </dataSetLink>).
 */
const PERIOD_BLOCK =
  '<parameter>' + '\r\n'
  + '\t\t<name>Период</name>' + '\r\n'
  + '\t\t<title xsi:type="v8:LocalStringType">' + '\r\n'
  + '\t\t\t<v8:item><v8:lang>ru</v8:lang><v8:content>Период</v8:content></v8:item>' + '\r\n'
  + '\t\t</title>' + '\r\n'
  + '\t\t<valueType>' + '\r\n'
  + '\t\t\t<v8:Type>xs:dateTime</v8:Type>' + '\r\n'
  + '\t\t</valueType>' + '\r\n'
  + '\t</parameter>';

function copyFixture(version: '2.20' | '2.21'): { readonly templatePath: string; readonly original: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-skd-modify-parameter-'));
  const templatePath = path.join(root, 'Ext', 'Template.xml');
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.copyFileSync(path.join(EXAMPLE_ROOT, version, 'src', 'cf', REL_PATH), templatePath);
  return { templatePath, original: fs.readFileSync(templatePath, 'utf-8') };
}

/** Независимый от реализации оракул: границы блока параметра схемы по его `<name>`. */
function parameterBlockRange(xml: string, name: string): { readonly start: number; readonly end: number } {
  const nameIndex = xml.indexOf(`<name>${name}</name>`);
  assert.ok(nameIndex !== -1, `в фикстуре нет параметра ${name}`);
  const start = xml.lastIndexOf('<parameter>', nameIndex);
  const end = xml.indexOf('</parameter>', nameIndex) + '</parameter>'.length;
  return { start, end };
}

function replaceParameterBlock(xml: string, name: string, block: string): string {
  const { start, end } = parameterBlockRange(xml, name);
  return xml.slice(0, start) + block + xml.slice(end);
}

suite('DataCompositionSchemaService.edit — modify-parameter на реальной выгрузке (#32)', () => {
  for (const version of ['2.20', '2.21'] as const) {
    suite(version, () => {
      test('заменяет ровно блок параметра, отступ перед ним — из исходника', () => {
        const { templatePath, original } = copyFixture(version);

        const result = new DataCompositionSchemaService().edit({
          templatePath,
          operation: 'modify-parameter',
          value: 'НачалоПериода [Начало периода]: date',
        });

        assert.deepStrictEqual(result.warnings, []);
        assert.deepStrictEqual(result.changedFiles, [templatePath]);
        assert.strictEqual(
          fs.readFileSync(templatePath, 'utf-8'),
          replaceParameterBlock(original, 'НачалоПериода', START_PERIOD_BLOCK)
        );
      });

      for (const nested of ['<parameter/>', '<parameter xsi:nil="true"/>']) {
        test(`самозакрывающийся ${nested} в dataSetLink не захватывается: связь цела, заменён параметр схемы`, () => {
          const { templatePath, original } = copyFixture(version);
          const closeLink = '\t</dataSetLink>';
          assert.strictEqual(original.split(closeLink).length, 2, 'в фикстуре ожидается ровно одна dataSetLink');
          const nestedLine = `\t\t${nested}\r\n${closeLink}`;
          const withNested = original.replace(closeLink, nestedLine);
          fs.writeFileSync(templatePath, withNested, 'utf-8');

          const result = new DataCompositionSchemaService().edit({
            templatePath,
            operation: 'modify-parameter',
            value: 'Период [Период]: date',
          });

          assert.deepStrictEqual(result.warnings, []);
          const after = fs.readFileSync(templatePath, 'utf-8');
          assert.ok(after.includes(nestedLine), 'вложенный параметр и </dataSetLink> обязаны остаться на месте');
          assert.strictEqual(after, replaceParameterBlock(withNested, 'Период', PERIOD_BLOCK));
        });
      }

      test('неизвестный параметр: предупреждение и добавление нового, существующие не тронуты', () => {
        const { templatePath, original } = copyFixture(version);

        const result = new DataCompositionSchemaService().edit({
          templatePath,
          operation: 'modify-parameter',
          value: 'НовыйПараметр: string',
        });

        assert.deepStrictEqual(result.warnings, ['Параметр не найден, добавлен новый: НовыйПараметр.']);
        const after = fs.readFileSync(templatePath, 'utf-8');
        for (const name of ['Период', 'НачалоПериода', 'КонецПериода']) {
          const { start, end } = parameterBlockRange(original, name);
          assert.ok(after.includes(original.slice(start, end)), `параметр ${name} обязан остаться без изменений`);
        }
        assert.ok(after.includes('<name>НовыйПараметр</name>'));
      });
    });
  }

  test('схема без корня DataCompositionSchema: предупреждение, файл не меняется', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-skd-modify-parameter-noroot-'));
    const templatePath = path.join(root, 'Ext', 'Template.xml');
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Other>\n\t<parameter>\n\t\t<name>А</name>\n\t</parameter>\n</Other>\n';
    fs.writeFileSync(templatePath, xml, 'utf-8');

    const result = new DataCompositionSchemaService().edit({ templatePath, operation: 'modify-parameter', value: 'А: string' });

    assert.deepStrictEqual(result.warnings, ['modify-parameter: не найден корень DataCompositionSchema.']);
    assert.deepStrictEqual(result.changedFiles, []);
    assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), xml);
  });
});
