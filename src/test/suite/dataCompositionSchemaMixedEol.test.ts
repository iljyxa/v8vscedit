import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService } from '../../infra/xml/DataCompositionSchemaService';
import { unescapeXml } from '../../infra/xml/XmlUtils';

/**
 * Интеграционные тесты DataCompositionSchemaService.edit на копиях 6 реальных смешанных
 * выгрузок 1С (BOM + CRLF-файл с голыми LF внутри `<query>`).
 * Каждый тест работает на КОПИИ фикстуры во временной папке (исходники в example/ не трогаются).
 *
 * writeTextFilePreservingBomAndEol (через preserveBomAndEol, LineEndings.ts) построчно
 * сохраняет исходный EOL неизменённых строк, поэтому голые LF внутри <query>…</query>
 * переживают мутации, не затрагивающие текст запроса: тесты сравнивают <query>-блоки,
 * число одиночных LF и полный текст файла ДО и ПОСЛЕ мутации.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example');

interface Fixture {
  readonly version: '2.20' | '2.21';
  readonly report: string;
  readonly relPath: string;
  /** Число одиночных (не входящих в \r\n) переводов строк в исходной фикстуре — все они внутри <query>. */
  readonly bareLfCount: number;
  readonly addFieldDataSet: string;
}

const ПОЛЬЗОВАТЕЛИ_220: Fixture = {
  version: '2.20',
  report: 'Пользователи',
  relPath: 'Reports/Пользователи/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml',
  bareLfCount: 11,
  addFieldDataSet: 'НаборДанных1',
};
const ПОЛЬЗОВАТЕЛИ_221: Fixture = { ...ПОЛЬЗОВАТЕЛИ_220, version: '2.21' };

const ПРАВАДОСТУПА_220: Fixture = {
  version: '2.20',
  report: 'ПраваДоступа',
  relPath: 'Reports/ПраваДоступа/Templates/МакетПараметров/Ext/Template.xml',
  bareLfCount: 17,
  addFieldDataSet: 'НаборДанных1',
};
const ПРАВАДОСТУПА_221: Fixture = { ...ПРАВАДОСТУПА_220, version: '2.21' };

const ЗАПАСЫ_220: Fixture = {
  version: '2.20',
  report: 'Запасы',
  relPath: 'Reports/Запасы/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml',
  bareLfCount: 15,
  addFieldDataSet: 'Цены',
};
const ЗАПАСЫ_221: Fixture = { ...ЗАПАСЫ_220, version: '2.21' };

const FIXTURES: readonly Fixture[] = [
  ПОЛЬЗОВАТЕЛИ_220,
  ПРАВАДОСТУПА_220,
  ЗАПАСЫ_220,
  ПОЛЬЗОВАТЕЛИ_221,
  ПРАВАДОСТУПА_221,
  ЗАПАСЫ_221,
];

function copyFixtureToTemp(fx: Fixture): { readonly templatePath: string; readonly original: string } {
  const fixturePath = path.join(EXAMPLE_ROOT, fx.version, 'src', 'cf', fx.relPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-skd-mixed-eol-'));
  const destDir = path.join(root, 'Ext');
  fs.mkdirSync(destDir, { recursive: true });
  const templatePath = path.join(destDir, 'Template.xml');
  fs.copyFileSync(fixturePath, templatePath);
  return { templatePath, original: fs.readFileSync(templatePath, 'utf-8') };
}

/** Все `<query>…</query>` блоки документа (в т.ч. вложенные в `<item>` DataSetUnion). */
function extractQueryBlocks(xml: string): string[] {
  return [...xml.matchAll(/<query>[\s\S]*?<\/query>/g)].map((match) => match[0]);
}

/** Число переводов строк-НЕ-частей `\r\n` (голых LF) — контрольная сумма того, что LF внутри <query> не переписаны в CRLF. */
function countBareLineFeeds(xml: string): number {
  let count = 0;
  for (let i = 0; i < xml.length; i += 1) {
    if (xml.charAt(i) === '\n' && xml.charAt(i - 1) !== '\r') {
      count += 1;
    }
  }
  return count;
}

function findIndexOrThrow(haystack: string, needle: string, fromIndex = 0): number {
  const index = haystack.indexOf(needle, fromIndex);
  if (index === -1) {
    throw new Error(`не найдена подстрока "${needle}" во фикстуре (проверьте актуальность example/)`);
  }
  return index;
}

/**
 * Байтовый эталон add-parameter: строка ПОЛНОСТЬЮ, идентичная golden-тесту
 * (dataCompositionSchemaGolden.test.ts, шаг 3 "add-parameter") — insertBeforeClose
 * вставляет CRLF-блок параметра прямо перед `</DataCompositionSchema>`, ничего
 * больше в документе не трогая. Значение/блок намеренно совпадают с golden-тестом:
 * формат генерируется builder'ом (dcs/schemaBuilders.ts), не зависит от фикстуры.
 */
const ADD_PARAMETER_VALUE = 'ПериодАнализа [Период анализа]: StandardPeriod';
const ADD_PARAMETER_BLOCK =
  '\t<parameter>' + '\r\n'
  + '\t\t<name>ПериодАнализа</name>' + '\r\n'
  + '\t\t<title xsi:type="v8:LocalStringType">' + '\r\n'
  + '\t\t\t<v8:item><v8:lang>ru</v8:lang><v8:content>Период анализа</v8:content></v8:item>' + '\r\n'
  + '\t\t</title>' + '\r\n'
  + '\t\t<valueType>' + '\r\n'
  + '\t\t\t<v8:Type>v8:StandardPeriod</v8:Type>' + '\r\n'
  + '\t\t</valueType>' + '\r\n'
  + '\t</parameter>' + '\r\n';

function expectedAfterAddParameter(original: string): string {
  const closeTag = '</DataCompositionSchema>';
  assert.ok(original.endsWith(closeTag), 'фикстура обязана оканчиваться </DataCompositionSchema> без хвостовых байт');
  return original.slice(0, original.length - closeTag.length) + ADD_PARAMETER_BLOCK + closeTag;
}

suite('DataCompositionSchemaService.edit — сохранение смешанного EOL на реальных выгрузках 1С', () => {
  for (const fx of FIXTURES) {
    suite(`${fx.version}/${fx.report}`, () => {
      test('контроль фикстуры: копия содержит ожидаемое число одиночных LF (все — внутри <query>)', () => {
        const { original } = copyFixtureToTemp(fx);
        assert.strictEqual(countBareLineFeeds(original), fx.bareLfCount);
      });

      test('add-parameter: точный байтовый эталон (исходник + CRLF-блок параметра перед </DataCompositionSchema>); <query> и число одиночных LF не меняются', () => {
        const { templatePath, original } = copyFixtureToTemp(fx);
        const service = new DataCompositionSchemaService();
        const queriesBefore = extractQueryBlocks(original);

        const result = service.edit({ templatePath, operation: 'add-parameter', value: ADD_PARAMETER_VALUE });
        assert.strictEqual(result.changedFiles.length, 1);
        assert.strictEqual(result.warnings.length, 0);

        const after = fs.readFileSync(templatePath, 'utf-8');
        assert.strictEqual(after, expectedAfterAddParameter(original));
        assert.deepStrictEqual(extractQueryBlocks(after), queriesBefore, '<query>-блоки не должны меняться при add-parameter');
        assert.strictEqual(countBareLineFeeds(after), fx.bareLfCount);
      });

      test(`add-field в наборе данных '${fx.addFieldDataSet}': ВСЕ <query> документа (в т.ч. вложенные в DataSetUnion) сохраняются байт-в-байт, число одиночных LF не меняется`, () => {
        const { templatePath, original } = copyFixtureToTemp(fx);
        const service = new DataCompositionSchemaService();
        const queriesBefore = extractQueryBlocks(original);
        const infoBefore = service.info({ templatePath }).dataSets.map((dataSet) => ({ name: dataSet.name, query: dataSet.query }));

        const result = service.edit({
          templatePath,
          operation: 'add-field',
          value: 'НовоеПоле [Новое поле]: CatalogRef.РолиПользователей',
          dataSet: fx.addFieldDataSet,
        });
        assert.strictEqual(result.changedFiles.length, 1);
        assert.strictEqual(result.warnings.length, 0);

        const after = fs.readFileSync(templatePath, 'utf-8');
        assert.deepStrictEqual(extractQueryBlocks(after), queriesBefore, '<query>-блоки не должны меняться при add-field (мутатор трогает только <field>)');
        assert.strictEqual(countBareLineFeeds(after), fx.bareLfCount);

        const infoAfter = service.info({ templatePath }).dataSets.map((dataSet) => ({ name: dataSet.name, query: dataSet.query }));
        assert.deepStrictEqual(infoAfter, infoBefore, 'service.info().dataSets[*].query до/после add-field обязаны совпадать байт-в-байт');
      });
    });
  }

  suite('rename-parameter туда-обратно (Old => Temp => Old): файл побайтно идентичен исходнику', () => {
    const cases: readonly { readonly fixture: Fixture; readonly parameterName: string }[] = [
      { fixture: ЗАПАСЫ_220, parameterName: 'НачалоПериода' },
      { fixture: ЗАПАСЫ_221, parameterName: 'НачалоПериода' },
      { fixture: ПРАВАДОСТУПА_220, parameterName: 'ПодробныеСведенияОПравахДоступа' },
      { fixture: ПРАВАДОСТУПА_221, parameterName: 'ПодробныеСведенияОПравахДоступа' },
    ];

    for (const { fixture, parameterName } of cases) {
      test(`${fixture.version}/${fixture.report}: ${parameterName} => ВременноеИмяДляТеста => ${parameterName}`, () => {
        const { templatePath, original } = copyFixtureToTemp(fixture);
        const service = new DataCompositionSchemaService();

        const toTemp = service.edit({
          templatePath,
          operation: 'rename-parameter',
          value: `${parameterName} => ВременноеИмяДляТеста`,
        });
        assert.strictEqual(toTemp.warnings.length, 0);
        const back = service.edit({
          templatePath,
          operation: 'rename-parameter',
          value: `ВременноеИмяДляТеста => ${parameterName}`,
        });
        assert.strictEqual(back.warnings.length, 0);

        assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), original, 'после кругового переименования файл обязан побайтно совпасть с исходником');
      });
    }
  });

  suite('patch-query (Пользователи): вставка текста перед </query> — LF внутри запроса не портится, новая граница получает LF от предшествующей строки "ИЗ" (ханк k≠m, k=1)', () => {
    for (const fx of [ПОЛЬЗОВАТЕЛИ_220, ПОЛЬЗОВАТЕЛИ_221]) {
      test(fx.version, () => {
        const { templatePath, original } = copyFixtureToTemp(fx);
        const service = new DataCompositionSchemaService();

        const prefixMarker = '\tСправочник.Пользователи КАК Пользователи';
        const closeTag = '</query>';
        const markerIdx = findIndexOrThrow(original, `${prefixMarker}${closeTag}`);
        const prefixEnd = markerIdx + prefixMarker.length;
        const value = ' И Пользователи.ПометкаУдаления = Ложь';

        const result = service.edit({ templatePath, operation: 'patch-query', value, dataSet: 'НаборДанных1' });
        assert.strictEqual(result.changedFiles.length, 1);
        assert.strictEqual(result.warnings.length, 0);

        const after = fs.readFileSync(templatePath, 'utf-8');
        // patch-query: `block.replace('</query>', value + '\n</query>')` — bare '\n' новой границы,
        // а не буквальный '\r\n' исходного файла: preserveBomAndEol обязан взять этот LF от строки
        // "ИЗ" непосредственно перед местом правки (её собственный EOL), не преобладающий стиль CRLF.
        const expected = original.slice(0, prefixEnd) + value + '\n' + closeTag + original.slice(prefixEnd + closeTag.length);
        assert.strictEqual(after, expected);
      });
    }
  });

  suite('set-query (ПраваДоступа): замена <query> первыми 4 строками исходного запроса — общий префикс сохраняет LF, новая граница берёт CRLF от последней замещённой строки (ханк k≠m)', () => {
    for (const fx of [ПРАВАДОСТУПА_220, ПРАВАДОСТУПА_221]) {
      test(fx.version, () => {
        const { templatePath, original } = copyFixtureToTemp(fx);
        const service = new DataCompositionSchemaService();

        const openTag = '<query>';
        const closeTag = '</query>';
        const openIdx = findIndexOrThrow(original, `${openTag}ВЫБРАТЬ`);
        const prefixMarker = '\tСправочник.Пользователи КАК Пользователи';
        const prefixEnd = findIndexOrThrow(original, prefixMarker, openIdx) + prefixMarker.length;
        const value = original.slice(openIdx + openTag.length, prefixEnd);
        const oldCloseIdx = findIndexOrThrow(original, closeTag, prefixEnd);
        const oldCloseEnd = oldCloseIdx + closeTag.length;

        const result = service.edit({ templatePath, operation: 'set-query', value, dataSet: 'НаборДанных1' });
        assert.strictEqual(result.changedFiles.length, 1);
        assert.strictEqual(result.warnings.length, 0);

        const after = fs.readFileSync(templatePath, 'utf-8');
        // Общий префикс (первые 3 внутренние строки запроса) текстуально совпадает с original ->
        // Myers-дифф обязан распознать их как неизменённые и сохранить их собственный LF; последняя
        // строка нового <query> (совпадающая с последней ЗАМЕЩЁННОЙ строкой original) обязана взять
        // eol последней замещённой строки — CRLF.
        const expected = original.slice(0, prefixEnd) + closeTag + original.slice(oldCloseEnd);
        assert.strictEqual(after, expected);
        assert.ok(
          after.includes(`${openTag}ВЫБРАТЬ\n\tПользователи.Ссылка КАК Пользователь\nИЗ\n${prefixMarker}${closeTag}`),
          'первые строки нового запроса обязаны остаться на голом LF, последняя — стать CRLF'
        );
      });
    }
  });

  // Issue #24: текст запроса, пришедший с CRLF (Windows-клиент, буфер обмена), совпадает с
  // текущим по содержимому. Запись и так не меняет байты (preserveBomAndEol), но файл не
  // должен попадать в changedFiles — иначе post-mutation путь помечает конфигурацию
  // изменённой без реального изменения.
  suite('set-query тем же текстом с CRLF — не изменение (hasRealChange)', () => {
    for (const fx of FIXTURES) {
      test(`${fx.version}/${fx.report}: changedFiles и lines пусты, файл не переписан`, () => {
        const { templatePath, original } = copyFixtureToTemp(fx);
        const service = new DataCompositionSchemaService();
        const nameIdx = findIndexOrThrow(original, `<name>${fx.addFieldDataSet}</name>`);
        const openIdx = findIndexOrThrow(original, '<query>', nameIdx) + '<query>'.length;
        const closeIdx = findIndexOrThrow(original, '</query>', openIdx);
        const currentQuery = unescapeXml(original.slice(openIdx, closeIdx));
        const value = currentQuery.replace(/\r?\n/g, '\r\n');
        assert.notStrictEqual(value, currentQuery, 'запрос фикстуры обязан содержать голые LF, иначе тест ничего не проверяет');

        const result = service.edit({ templatePath, operation: 'set-query', value, dataSet: fx.addFieldDataSet });

        assert.deepStrictEqual(result.changedFiles, []);
        assert.deepStrictEqual(result.lines, []);
        assert.deepStrictEqual(result.warnings, []);
        assert.strictEqual(fs.readFileSync(templatePath, 'utf-8'), original);
      });
    }
  });
});
