import * as assert from 'assert';
import {
  MAIN_CHILD_OBJECTS_ENTRY_INDENT,
  ensureMainChildObjects,
  registerChildInMainChildObjects,
} from '../../infra/xml/MainChildObjectsEditor';

/**
 * `registerChildInMainChildObjects` — единственное место, которое решает, КУДА в XML-объекте
 * метаданных попадает запись о новом дочернем элементе: в ГЛАВНЫЙ `<ChildObjects>` объекта, а не
 * во вложенный `<ChildObjects>` табличной части. Старая логика в `CfeBorrowService` искала первое
 * по всему файлу вхождение `<ChildObjects/>`/`</ChildObjects>` без учёта вложенности (issue #25):
 * как только объект получал заимствованную ТЧ со своим `<ChildObjects>`, следующая регистрация
 * (реквизит/форма/макет/команда) попадала внутрь ТЧ. Эти тесты проверяют новый nesting-aware модуль
 * изолированно от файловой системы, на синтетических фрагментах XML.
 */
suite('MainChildObjectsEditor', () => {
  test('в XML вовсе нет <ChildObjects> — правка невозможна', () => {
    const xml = '<Foo><Bar/></Foo>';
    assert.strictEqual(registerChildInMainChildObjects(xml, 'Attribute', 'X'), undefined);
  });

  for (const selfClosing of ['<ChildObjects/>', '<ChildObjects />']) {
    test(`главный блок самозакрытый (${JSON.stringify(selfClosing)}) раскрывается с записью`, () => {
      const xml = `<Root>\n\t\t${selfClosing}\n\t</Root>`;
      const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Новый');
      assert.strictEqual(
        actual,
        '<Root>\n\t\t<ChildObjects>\n\t\t\t<Attribute>Новый</Attribute>\n\t\t</ChildObjects>\n\t</Root>'
      );
    });
  }

  test('непустой главный блок без вложенности: запись перед закрывающим тегом на отдельной строке', () => {
    const xml =
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<Attribute uuid="1"><Properties><Name>Existing</Name>' +
      '</Properties></Attribute>\n\t\t</ChildObjects>\n</Root>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Новый');
    assert.strictEqual(
      actual,
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<Attribute uuid="1"><Properties><Name>Existing</Name>' +
        '</Properties></Attribute>\n\t\t\t<Attribute>Новый</Attribute>\n\t\t</ChildObjects>\n</Root>'
    );
  });

  test('закрывающий тег склеен с предыдущим элементом (пустой отступ) — запись вставляется без ведущего перевода строки', () => {
    // Старое поведение (regex insertBeforeChildObjectsClose) не добавляло разделитель, если перед
    // </ChildObjects> не было пробельного хвоста — сохраняем эти байты как есть.
    const xml =
      '<Root><ChildObjects><Attribute uuid="1"><Properties><Name>Existing</Name>' +
      '</Properties></Attribute></ChildObjects></Root>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Новый');
    assert.strictEqual(
      actual,
      '<Root><ChildObjects><Attribute uuid="1"><Properties><Name>Existing</Name>' +
        '</Properties></Attribute>\t\t\t<Attribute>Новый</Attribute>\n</ChildObjects></Root>'
    );
  });

  test('непустой главный блок с вложенным самозакрытым <ChildObjects/> табличной части: запись уходит в главный, вложенный не трогается', () => {
    const xml =
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<TabularSection uuid="1">\n\t\t\t\t<ChildObjects/>' +
      '\n\t\t\t</TabularSection>\n\t\t</ChildObjects>\n</Root>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Новый');
    assert.strictEqual(
      actual,
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<TabularSection uuid="1">\n\t\t\t\t<ChildObjects/>' +
        '\n\t\t\t</TabularSection>\n\t\t\t<Attribute>Новый</Attribute>\n\t\t</ChildObjects>\n</Root>'
    );
  });

  test('непустой главный блок с вложенным непустым <ChildObjects> табличной части (есть колонка): запись уходит в главный', () => {
    const xml =
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<TabularSection uuid="1">\n\t\t\t\t<ChildObjects>' +
      '\n\t\t\t\t\t<Attribute uuid="2"><Properties><Name>Колонка</Name></Properties></Attribute>' +
      '\n\t\t\t\t</ChildObjects>\n\t\t\t</TabularSection>\n\t\t</ChildObjects>\n</Root>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Новый');
    assert.strictEqual(
      actual,
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<TabularSection uuid="1">\n\t\t\t\t<ChildObjects>' +
        '\n\t\t\t\t\t<Attribute uuid="2"><Properties><Name>Колонка</Name></Properties></Attribute>' +
        '\n\t\t\t\t</ChildObjects>\n\t\t\t</TabularSection>\n\t\t\t<Attribute>Новый</Attribute>' +
        '\n\t\t</ChildObjects>\n</Root>'
    );
  });

  test('полный блок с тем же тегом/именем уже есть на верхнем уровне — правка не нужна', () => {
    const xml =
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<Attribute uuid="1"><Properties><Name>X</Name>' +
      '</Properties></Attribute>\n\t\t</ChildObjects>\n</Root>';
    assert.strictEqual(registerChildInMainChildObjects(xml, 'Attribute', 'X'), undefined);
  });

  test('одноимённый полный блок есть только внутри ТЧ — на верхнем уровне это не считается регистрацией', () => {
    const xml =
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<TabularSection uuid="1">\n\t\t\t\t<ChildObjects>' +
      '\n\t\t\t\t\t<Attribute uuid="2"><Properties><Name>X</Name></Properties></Attribute>' +
      '\n\t\t\t\t</ChildObjects>\n\t\t\t</TabularSection>\n\t\t</ChildObjects>\n</Root>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'X');
    assert.notStrictEqual(actual, undefined);
    assert.strictEqual(
      actual,
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<TabularSection uuid="1">\n\t\t\t\t<ChildObjects>' +
        '\n\t\t\t\t\t<Attribute uuid="2"><Properties><Name>X</Name></Properties></Attribute>' +
        '\n\t\t\t\t</ChildObjects>\n\t\t\t</TabularSection>\n\t\t\t<Attribute>X</Attribute>' +
        '\n\t\t</ChildObjects>\n</Root>'
    );
  });

  test('текстовая ссылка на верхнем уровне с childXml — заменяется полным блоком, пробельный хвост перед ссылкой поглощается', () => {
    const xml = '<Root>\n\t\t<ChildObjects>\n\t\t\t<Other/>\n\t\t\t<Attribute>Имя</Attribute>\n\t\t</ChildObjects>\n</Root>';
    const childXml = '\t\t\t<Attribute uuid="new-uuid">\n\t\t\t\t<Properties><Name>Имя</Name></Properties>\n\t\t\t</Attribute>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Имя', childXml);
    assert.strictEqual(
      actual,
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<Other/>\n' +
        '\t\t\t<Attribute uuid="new-uuid">\n\t\t\t\t<Properties><Name>Имя</Name></Properties>\n\t\t\t</Attribute>' +
        '\n\t\t</ChildObjects>\n</Root>'
    );
  });

  test('текстовая ссылка на верхнем уровне без childXml — заменить нечем, правка не выполняется', () => {
    const xml = '<Root>\n\t\t<ChildObjects>\n\t\t\t<Other/>\n\t\t\t<Attribute>Имя</Attribute>\n\t\t</ChildObjects>\n</Root>';
    assert.strictEqual(registerChildInMainChildObjects(xml, 'Attribute', 'Имя'), undefined);
  });

  test('текстовая ссылка есть только внутри вложенного блока ТЧ — на верхнем уровне считается отсутствующей, вложенная ссылка не трогается', () => {
    const xml =
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<TabularSection uuid="1">\n\t\t\t\t<ChildObjects>' +
      '\n\t\t\t\t\t<Attribute>Имя</Attribute>\n\t\t\t\t</ChildObjects>\n\t\t\t</TabularSection>' +
      '\n\t\t</ChildObjects>\n</Root>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Имя');
    assert.strictEqual(
      actual,
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<TabularSection uuid="1">\n\t\t\t\t<ChildObjects>' +
        '\n\t\t\t\t\t<Attribute>Имя</Attribute>\n\t\t\t\t</ChildObjects>\n\t\t\t</TabularSection>' +
        '\n\t\t\t<Attribute>Имя</Attribute>\n\t\t</ChildObjects>\n</Root>'
    );
    // Вложенная текстовая ссылка не заменена и не продублирована.
    assert.strictEqual((actual.match(/<Attribute>Имя<\/Attribute>/g) ?? []).length, 2);
  });

  test('среди нескольких прямых текстовых ссылок регистрируется именно совпавшая по имени', () => {
    // Покрывает ветку «диапазон не совпал, перейти к следующему» в цикле поиска текстовой ссылки:
    // <Form>Другая</Form> должен быть пропущен, а <Form>X</Form> — опознан как уже зарегистрированный.
    const xml = '<Root>\n\t\t<ChildObjects>\n\t\t\t<Form>Другая</Form>\n\t\t\t<Form>X</Form>\n\t\t</ChildObjects>\n</Root>';
    assert.strictEqual(registerChildInMainChildObjects(xml, 'Form', 'X'), undefined);
  });

  test('без childXml запись строится с MAIN_CHILD_OBJECTS_ENTRY_INDENT и экранированием имени', () => {
    assert.strictEqual(MAIN_CHILD_OBJECTS_ENTRY_INDENT, '\t\t\t');
    const xml = '<Root>\n\t\t<ChildObjects/>\n\t</Root>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Иванов & Ко');
    assert.strictEqual(
      actual,
      '<Root>\n\t\t<ChildObjects>\n\t\t\t<Attribute>Иванов &amp; Ко</Attribute>\n\t\t</ChildObjects>\n\t</Root>'
    );
  });

  test('вход с CRLF: функция не нормализует EOL — перевод строки между записью и закрывающим тегом остаётся «голым» LF', () => {
    // Построчную нормализацию делает writeTextFilePreservingBomAndEol на стороне записи в файл,
    // а не этот чистый строковый мутатор — это осознанное разделение ответственности (план архитектора).
    const xml =
      '<Root>\r\n\t\t<ChildObjects>\r\n\t\t\t<Attribute uuid="1"><Properties><Name>Existing</Name>' +
      '</Properties></Attribute>\r\n\t\t</ChildObjects>\r\n</Root>';
    const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Новый');
    assert.strictEqual(
      actual,
      '<Root>\r\n\t\t<ChildObjects>\r\n\t\t\t<Attribute uuid="1"><Properties><Name>Existing</Name>' +
        '</Properties></Attribute>\r\n\t\t\t<Attribute>Новый</Attribute>\n\t\t</ChildObjects>\r\n</Root>'
    );
  });

  suite('содержимое childXml с спецпоследовательностями String.replace вставляется дословно', () => {
    const DOLLAR_SEQUENCES = ['$&', "$`", "$'", '$1', '$$'];

    for (const seq of DOLLAR_SEQUENCES) {
      const childXml = `\t\t\t<Attribute>${seq}</Attribute>`;

      test(`самозакрытый главный блок, childXml содержит ${JSON.stringify(seq)}`, () => {
        const xml = '<Root>\n\t\t<ChildObjects/>\n\t</Root>';
        const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Новый', childXml);
        assert.strictEqual(
          actual,
          `<Root>\n\t\t<ChildObjects>\n${childXml}\n\t\t</ChildObjects>\n\t</Root>`
        );
      });

      test(`непустой главный блок, childXml содержит ${JSON.stringify(seq)}`, () => {
        const xml =
          '<Root>\n\t\t<ChildObjects>\n\t\t\t<Attribute uuid="1"><Properties><Name>Existing</Name>' +
          '</Properties></Attribute>\n\t\t</ChildObjects>\n</Root>';
        const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Новый', childXml);
        assert.strictEqual(
          actual,
          '<Root>\n\t\t<ChildObjects>\n\t\t\t<Attribute uuid="1"><Properties><Name>Existing</Name>' +
            `</Properties></Attribute>\n${childXml}\n\t\t</ChildObjects>\n</Root>`
        );
      });

      test(`замена текстовой ссылки, childXml содержит ${JSON.stringify(seq)}`, () => {
        const xml = '<Root>\n\t\t<ChildObjects>\n\t\t\t<Other/>\n\t\t\t<Attribute>Имя</Attribute>\n\t\t</ChildObjects>\n</Root>';
        const actual = registerChildInMainChildObjects(xml, 'Attribute', 'Имя', childXml);
        assert.strictEqual(
          actual,
          `<Root>\n\t\t<ChildObjects>\n\t\t\t<Other/>\n${childXml}\n\t\t</ChildObjects>\n</Root>`
        );
      });
    }
  });

  suite('ensureMainChildObjects', () => {
    for (const block of ['<ChildObjects/>', '<ChildObjects>\n\t\t\t<Form>Ф</Form>\n\t\t</ChildObjects>']) {
      test(`главный блок уже есть (${JSON.stringify(block)}) — строка возвращается без изменений`, () => {
        const xml = `<Root>\n\t\t<Properties>\n\t\t\t<Name>X</Name>\n\t\t</Properties>\n\t\t${block}\n\t</Root>`;
        assert.strictEqual(ensureMainChildObjects(xml), xml);
      });
    }

    test('блока нет — пустой <ChildObjects/> вставляется сразу после </Properties> корня', () => {
      const xml = '<Root>\n\t\t<InternalInfo/>\n\t\t<Properties>\n\t\t\t<Name>X</Name>\n\t\t</Properties>\n\t</Root>';
      assert.strictEqual(
        ensureMainChildObjects(xml),
        '<Root>\n\t\t<InternalInfo/>\n\t\t<Properties>\n\t\t\t<Name>X</Name>\n\t\t</Properties>' +
          '\n\t\t<ChildObjects/>\n\t</Root>'
      );
    });

    test('нет ни <ChildObjects>, ни <Properties> — вставить некуда', () => {
      assert.strictEqual(ensureMainChildObjects('<Root>\n\t\t<InternalInfo/>\n\t</Root>'), undefined);
    });
  });
});
