import * as assert from 'assert';
import { buildBorrowedChildXml } from '../../infra/xml/BorrowedChildXml';

/**
 * XML заимствованного дочернего элемента собирается из XML исходной конфигурации, который несёт
 * пользовательские синонимы и комментарии. Прежняя сборка подставляла эти фрагменты строкой-шаблоном
 * `String.replace`, и `$&`, `` $` ``, `$'`, `$$` в тексте превращались в куски совпадения.
 */

/** Все четыре шаблона замены `String.replace`; `&` экранирован, как его пишет Конфигуратор. */
const DOLLAR_SYNONYM = 'Цена, $&amp; $` $\' $$';
const DOLLAR_COMMENT = 'Итог: $\' и $&amp;';

suite('BorrowedChildXml — $-последовательности в тексте исходного элемента', () => {
  test('синоним и комментарий колонки ТЧ переносятся в заимствованный XML без искажений', () => {
    const source = [
      '<TabularSection uuid="ts-src">',
      '\t<Properties>',
      '\t\t<Name>Товары</Name>',
      `\t\t<Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>${DOLLAR_SYNONYM}</v8:content></v8:item></Synonym>`,
      '\t\t<Comment/>',
      '\t</Properties>',
      '\t<ChildObjects>',
      '\t\t<Attribute uuid="col-src">',
      '\t\t\t<Properties>',
      '\t\t\t\t<Name>Цена</Name>',
      `\t\t\t\t<Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>${DOLLAR_SYNONYM}</v8:content></v8:item></Synonym>`,
      `\t\t\t\t<Comment>${DOLLAR_COMMENT}</Comment>`,
      '\t\t\t</Properties>',
      '\t\t</Attribute>',
      '\t</ChildObjects>',
      '</TabularSection>',
    ].join('\n');
    let n = 0;
    const result = buildBorrowedChildXml(source, 'TabularSection', '', () => `guid-${String(++n)}`);

    assert.strictEqual(result.split(`<v8:content>${DOLLAR_SYNONYM}</v8:content>`).length - 1, 2);
    const commentAt = result.indexOf(`<Comment>${DOLLAR_COMMENT}</Comment>`);
    assert.ok(commentAt >= 0, 'комментарий колонки перенесён без искажений');
    assert.ok(
      commentAt < result.indexOf('<ExtendedConfigurationObject>col-src</ExtendedConfigurationObject>'),
      'ссылка на исходную колонку встаёт после её комментария'
    );
    assert.strictEqual(result.split('<ObjectBelonging>Adopted</ObjectBelonging>').length - 1, 2, 'заимствованы и ТЧ, и колонка');
    assert.ok(result.includes('<ExtendedConfigurationObject>ts-src</ExtendedConfigurationObject>'));
  });
});

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
