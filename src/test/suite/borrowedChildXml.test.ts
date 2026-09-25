import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';
import { buildBorrowedChildXml } from '../../infra/xml/BorrowedChildXml';
import { extractChildMetaElementXml, extractColumnXmlFromTabularSection } from '../../infra/xml/XmlUtils';

/**
 * XML заимствованного дочернего элемента собирается из XML исходной конфигурации, который несёт
 * пользовательские синонимы и комментарии. Прежняя сборка подставляла эти фрагменты строкой-шаблоном
 * `String.replace`, и `$&`, `` $` ``, `$'`, `$$` в тексте превращались в куски совпадения (issue #27).
 *
 * `$`-последовательностей в `example/` нет, а Конфигуратора в тестовом окружении нет, поэтому
 * исходный объект — реальная выгрузка `ПриходТовара`, в которой меняется только ТЕКСТ синонима и
 * комментария (содержимое `<v8:content>`/`<Comment>`); структура и формат файла остаются платформенными.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example');
const OBJECT_NAME = 'ПриходТовара';

/** Все четыре шаблона замены `String.replace`; `&` экранирован, как его пишет Конфигуратор. */
const DOLLAR_SYNONYM = 'Цена, $&amp; $` $\' $$';
const DOLLAR_COMMENT = 'Итог: $\' и $&amp;';
const DOLLAR_ATTRIBUTE_SYNONYM = 'Контрагент $$ $`';

function sourceObjectXml(version: string): string {
  return fs.readFileSync(path.join(EXAMPLE_ROOT, version, 'src', 'cf', 'Documents', `${OBJECT_NAME}.xml`), 'utf-8');
}

/** Заменяет первое вхождение `search` начиная с позиции `from`. */
function replaceOnce(text: string, search: string, replacement: string, from = 0): string {
  const at = text.indexOf(search, from);
  assert.ok(at >= 0, `в исходном XML должен быть фрагмент ${search}`);
  return text.slice(0, at) + replacement + text.slice(at + search.length);
}

/**
 * Подменяет текст синонима и комментария колонки ТЧ `Товары.Цена` и синоним реквизита `Контрагент`.
 * Значения подставляются срезами, чтобы сам тест не зависел от поведения `String.replace`.
 */
function withTexts(xml: string, synonym: string, comment: string, attributeSynonym: string): string {
  let result = replaceOnce(xml, '<v8:content>Цена</v8:content>', `<v8:content>${synonym}</v8:content>`);
  const priceName = result.indexOf('<Name>Цена</Name>');
  result = replaceOnce(result, '<Comment/>', `<Comment>${comment}</Comment>`, priceName);
  return replaceOnce(result, '<v8:content>Контрагент</v8:content>', `<v8:content>${attributeSynonym}</v8:content>`);
}

function sequentialGuids(): () => string {
  let n = 0;
  return () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
}

function childXml(objectXml: string, childTag: string, childName: string): string {
  const xml = extractChildMetaElementXml(objectXml, childTag, childName);
  assert.ok(xml, `в объекте должен быть ${childTag}.${childName}`);
  return xml;
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

for (const version of ['2.20', '2.21']) {
  suite(`BorrowedChildXml — $-последовательности в тексте исходного элемента (${version}, issue #27)`, () => {
    const placeholders = { synonym: '@@SYNONYM@@', comment: '@@COMMENT@@', attribute: '@@ATTRIBUTE@@' };
    const neutralXml = withTexts(sourceObjectXml(version), placeholders.synonym, placeholders.comment, placeholders.attribute);
    const dollarXml = withTexts(sourceObjectXml(version), DOLLAR_SYNONYM, DOLLAR_COMMENT, DOLLAR_ATTRIBUTE_SYNONYM);

    /** Сборка обязана переносить пользовательский текст как есть: результат с `$` = результат с меткой, где метка заменена текстом. */
    function expectedFromNeutral(childTag: string, childName: string): string {
      return buildBorrowedChildXml(childXml(neutralXml, childTag, childName), childTag, '\t\t\t', sequentialGuids())
        .split(placeholders.synonym).join(DOLLAR_SYNONYM)
        .split(placeholders.comment).join(DOLLAR_COMMENT)
        .split(placeholders.attribute).join(DOLLAR_ATTRIBUTE_SYNONYM);
    }

    test('ТЧ Товары: синоним и комментарий колонки Цена переносятся байт-в-байт', () => {
      const actual = buildBorrowedChildXml(childXml(dollarXml, 'TabularSection', 'Товары'), 'TabularSection', '\t\t\t', sequentialGuids());
      assert.strictEqual(actual, expectedFromNeutral('TabularSection', 'Товары'));
      assert.strictEqual(countOccurrences(actual, `<v8:content>${DOLLAR_SYNONYM}</v8:content>`), 1);
      assert.strictEqual(countOccurrences(actual, `<Comment>${DOLLAR_COMMENT}</Comment>`), 1);
    });

    test('реквизит Контрагент: синоним переносится байт-в-байт', () => {
      const actual = buildBorrowedChildXml(childXml(dollarXml, 'Attribute', 'Контрагент'), 'Attribute', '\t\t\t', sequentialGuids());
      assert.strictEqual(actual, expectedFromNeutral('Attribute', 'Контрагент'));
      assert.strictEqual(countOccurrences(actual, `<v8:content>${DOLLAR_ATTRIBUTE_SYNONYM}</v8:content>`), 1);
    });

    suite('CfeBorrowService.borrowChild', () => {
      let cfDir: string;
      let extDir: string;
      let objFile: string;

      setup(() => {
        cfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-borrow-dollar-cf-'));
        extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-borrow-dollar-ext-'));
        fs.mkdirSync(path.join(cfDir, 'Documents'));
        fs.writeFileSync(path.join(cfDir, 'Documents', `${OBJECT_NAME}.xml`), dollarXml, 'utf-8');
        // Расширение берётся реальное (EVOLC): Document в нём ещё не заимствован, оболочку создаёт сервис.
        fs.cpSync(path.join(EXAMPLE_ROOT, '2.21', 'src', 'cfe', 'EVOLC'), extDir, { recursive: true });
        objFile = path.join(extDir, 'Documents', `${OBJECT_NAME}.xml`);
      });

      teardown(() => {
        fs.rmSync(cfDir, { recursive: true, force: true });
        fs.rmSync(extDir, { recursive: true, force: true });
      });

      /**
       * Блок элемента в файле расширения совпадает с эталоном чистой сборки с точностью до новых UUID
       * (сервис генерирует случайные). Проверка «текст встречается в файле» здесь недостаточна: старая
       * подстановка `$&` вставляла копию исходного элемента, в которой текст тоже есть целиком.
       */
      function assertBorrowedAsExpected(childTag: string, childName: string): void {
        const fileXml = fs.readFileSync(objFile, 'utf-8');
        const maskUuids = (xml: string) => xml.replace(/\r\n/g, '\n').replace(/ uuid="[^"]*"/g, ' uuid="*"');
        // Экстрактор отдаёт элемент с `<`, без отступа первой строки — у эталона он срезается так же.
        assert.strictEqual(
          maskUuids(childXml(fileXml, childTag, childName)),
          maskUuids(expectedFromNeutral(childTag, childName).trimStart())
        );
        for (const text of [DOLLAR_SYNONYM, DOLLAR_COMMENT, DOLLAR_ATTRIBUTE_SYNONYM]) {
          const expectedCount = countOccurrences(expectedFromNeutral(childTag, childName), text);
          assert.strictEqual(countOccurrences(fileXml, text), expectedCount, `текст ${text} не должен дублироваться`);
        }
      }

      test('заимствованная ТЧ и её колонка сохраняют синоним и комментарий с $', () => {
        new CfeBorrowService().borrowChild(cfDir, extDir, 'Document', OBJECT_NAME, 'TabularSection', 'Товары');

        assertBorrowedAsExpected('TabularSection', 'Товары');
        const price = extractColumnXmlFromTabularSection(fs.readFileSync(objFile, 'utf-8'), 'Товары', 'Цена');
        assert.ok(price?.includes(`<v8:content>${DOLLAR_SYNONYM}</v8:content>`));
        assert.ok(price?.includes(`<Comment>${DOLLAR_COMMENT}</Comment>`));
      });

      test('заимствованный реквизит сохраняет синоним с $', () => {
        new CfeBorrowService().borrowChild(cfDir, extDir, 'Document', OBJECT_NAME, 'Attribute', 'Контрагент');

        assertBorrowedAsExpected('Attribute', 'Контрагент');
        assert.strictEqual(countOccurrences(fs.readFileSync(objFile, 'utf-8'), `<v8:content>${DOLLAR_ATTRIBUTE_SYNONYM}</v8:content>`), 1);
      });
    });
  });
}

/**
 * Граничные входы чистого модуля. Реальные выгрузки всегда дают полный элемент (UUID в открывающем
 * теге, `<Properties>` с `<Name>` и `<Comment>`), поэтому эти ветки проверяются на минимальных
 * фрагментах — их байты целиком видны в ожидании.
 */
suite('BorrowedChildXml — граничные входы', () => {
  const guid = '11111111-1111-1111-1111-111111111111';
  const newGuid = () => guid;

  test('нет открывающего тега ожидаемого вида — ошибка', () => {
    assert.throws(
      () => buildBorrowedChildXml('<Attribute uuid="a"><Properties/></Attribute>', 'Dimension', '\t', newGuid),
      /Не найден открывающий тег дочернего объекта: Dimension/
    );
  });

  test('UUID только у вложенного элемента, не у самого — ошибка, а не ссылка на чужой объект', () => {
    const xml = '<TabularSection>\n\t<ChildObjects>\n\t\t<Attribute uuid="col"/>\n\t</ChildObjects>\n</TabularSection>';
    assert.throws(
      () => buildBorrowedChildXml(xml, 'TabularSection', '\t', newGuid),
      /Не удалось извлечь UUID дочернего объекта: TabularSection/
    );
  });

  test('однострочный элемент без <Properties>: только новый UUID и <InternalInfo/>', () => {
    assert.strictEqual(
      buildBorrowedChildXml('\uFEFF  <Command uuid="src"></Command>', 'Command', '\t\t', newGuid),
      `\t\t<Command uuid="${guid}">\n\t\t\t<InternalInfo/></Command>`
    );
  });

  test('без <Name>: ObjectBelonging в начало, ExtendedConfigurationObject в конец; пробельные строки очищаются', () => {
    const xml = '<EnumValue uuid="src">\r\n  \r\n\t<Properties><Synonym/></Properties>\r\n</EnumValue>';
    assert.strictEqual(
      buildBorrowedChildXml(xml, 'EnumValue', '', newGuid),
      [
        `<EnumValue uuid="${guid}">`,
        '\t<InternalInfo/>',
        '',
        '\t<Properties>',
        '\t\t\t\t<ObjectBelonging>Adopted</ObjectBelonging><Synonym/>',
        '\t\t\t\t<ExtendedConfigurationObject>src</ExtendedConfigurationObject></Properties>',
        '</EnumValue>',
      ].join('\n')
    );
  });

  test('<Name> без <Comment>: ExtendedConfigurationObject сразу после <Name>, прежняя принадлежность заменяется', () => {
    const xml = [
      '<Attribute uuid="src">',
      '\t<InternalInfo/>',
      '\t<Properties>',
      '\t\t<ObjectBelonging>Native</ObjectBelonging>',
      '\t\t<Name>Р$&</Name>',
      '\t\t<ExtendedConfigurationObject>old</ExtendedConfigurationObject>',
      '\t</Properties>',
      '</Attribute>',
    ].join('\n');
    assert.strictEqual(
      buildBorrowedChildXml(xml, 'Attribute', '', newGuid),
      [
        `<Attribute uuid="${guid}">`,
        '\t<InternalInfo/>',
        '\t<Properties>',
        '\t\t<ObjectBelonging>Adopted</ObjectBelonging>',
        '\t\t<Name>Р$&</Name>',
        '\t\t<ExtendedConfigurationObject>src</ExtendedConfigurationObject>',
        '\t</Properties>',
        '</Attribute>',
      ].join('\n')
    );
  });

  test('ТЧ без <ChildObjects>: колонок нет, заимствуется только сама ТЧ', () => {
    const xml = '<TabularSection uuid="src">\n\t<Properties>\n\t\t<Name>Т</Name>\n\t\t<Comment/>\n\t</Properties>\n</TabularSection>';
    assert.strictEqual(
      buildBorrowedChildXml(xml, 'TabularSection', '', newGuid),
      [
        `<TabularSection uuid="${guid}">`,
        '\t<InternalInfo/>',
        '\t<Properties>',
        '\t\t<ObjectBelonging>Adopted</ObjectBelonging>',
        '\t\t<Name>Т</Name>',
        '\t\t<Comment/>',
        '\t\t<ExtendedConfigurationObject>src</ExtendedConfigurationObject>',
        '\t</Properties>',
        '</TabularSection>',
      ].join('\n')
    );
  });
});
