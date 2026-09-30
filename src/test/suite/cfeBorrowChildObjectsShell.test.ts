import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';
import { ensureMainChildObjects } from '../../infra/xml/childObjects/ChildObjectsEditor';

/**
 * Оболочка заимствованного объекта получала `<ChildObjects/>` только по параллельному списку
 * типов, в котором не было обработок, отчётов и журналов документов: borrowForm/borrowChild для
 * них ничего не регистрировали и возвращали `alreadyBorrowed: false`. Наличие блока теперь
 * определяется по `META_TYPES[kind].childTags`, а невозможная регистрация — исключение.
 */

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
      '<Root>\n\t\t<InternalInfo/>\n\t\t<Properties>\n\t\t\t<Name>X</Name>\n\t\t</Properties>'
        + '\n\t\t<ChildObjects/>\n\t</Root>'
    );
  });

  test('нет ни <ChildObjects>, ни <Properties> — вставить некуда', () => {
    assert.strictEqual(ensureMainChildObjects('<Root>\n\t\t<InternalInfo/>\n\t</Root>'), undefined);
  });
});

suite('CfeBorrowService — оболочка <ChildObjects> по META_TYPES', () => {
  let root: string;
  let cfDir: string;
  let extDir: string;
  const service = new CfeBorrowService();

  const BOM = '﻿';
  const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\r\n';

  /** Исходная обработка с формой в форме выгрузки платформы (BOM + CRLF). */
  function writeSourceDataProcessor(): void {
    const objDir = path.join(cfDir, 'DataProcessors');
    fs.mkdirSync(path.join(objDir, 'Обработка', 'Forms'), { recursive: true });
    fs.writeFileSync(path.join(objDir, 'Обработка.xml'), [
      `${BOM}${HEADER}<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21">`,
      '\t<DataProcessor uuid="dp-src">',
      '\t\t<Properties>',
      '\t\t\t<Name>Обработка</Name>',
      '\t\t</Properties>',
      '\t\t<ChildObjects>',
      '\t\t\t<Form>Форма</Form>',
      '\t\t</ChildObjects>',
      '\t</DataProcessor>',
      '</MetaDataObject>',
    ].join('\r\n'), 'utf-8');
    fs.writeFileSync(path.join(objDir, 'Обработка', 'Forms', 'Форма.xml'), [
      `${BOM}${HEADER}<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21">`,
      '\t<Form uuid="form-src">',
      '\t\t<Properties>',
      '\t\t\t<Name>Форма</Name>',
      '\t\t</Properties>',
      '\t</Form>',
      '</MetaDataObject>',
    ].join('\r\n'), 'utf-8');
  }

  /** Оболочка обработки в расширении в том виде, как её создавала прежняя версия: без <ChildObjects>. */
  function writeLegacyShell(withProperties = true): string {
    const shellDir = path.join(extDir, 'DataProcessors');
    fs.mkdirSync(shellDir, { recursive: true });
    const shell = path.join(shellDir, 'Обработка.xml');
    const body = withProperties
      ? ['\t\t<Properties>', '\t\t\t<Name>Обработка</Name>', '\t\t</Properties>']
      : ['\t\t<InternalInfo/>'];
    fs.writeFileSync(shell, [
      `${BOM}${HEADER}<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21">`,
      '\t<DataProcessor uuid="dp-ext">',
      ...body,
      '\t</DataProcessor>',
      '</MetaDataObject>',
    ].join('\r\n'), 'utf-8');
    return shell;
  }

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-cfe-shell-'));
    cfDir = path.join(root, 'cf');
    extDir = path.join(root, 'cfe');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'Configuration.xml'), [
      `${HEADER}<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21">`,
      '\t<Configuration uuid="ext">',
      '\t\t<Properties>',
      '\t\t\t<Name>Расш</Name>',
      '\t\t</Properties>',
      '\t\t<ChildObjects>',
      '\t\t\t<DataProcessor>Обработка</DataProcessor>',
      '\t\t</ChildObjects>',
      '\t</Configuration>',
      '</MetaDataObject>',
    ].join('\r\n'), 'utf-8');
    writeSourceDataProcessor();
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('тип без дочерних объектов: форма отбивается до записи файлов', () => {
    assert.throws(
      () => service.borrowForm(cfDir, extDir, 'Constant', 'Константа', 'Форма'),
      /Тип "Constant" не содержит дочерних объектов: заимствование формы Форма невозможно/
    );
    assert.deepStrictEqual(fs.readdirSync(extDir), ['Configuration.xml']);
  });

  test('тип без дочерних объектов: дочерний элемент отбивается до записи файлов', () => {
    assert.throws(
      () => service.borrowChild(cfDir, extDir, 'Constant', 'Константа', 'Attribute', 'Р'),
      /Тип "Constant" не содержит дочерних объектов: заимствование Attribute.Р невозможно/
    );
    assert.deepStrictEqual(fs.readdirSync(extDir), ['Configuration.xml']);
  });

  test('URL-шаблон (контейнер с методами) не регистрируется текстовой ссылкой', () => {
    assert.throws(
      () => service.borrowChild(cfDir, extDir, 'HTTPService', 'Сервис', 'URLTemplate', 'Шаблон'),
      /Заимствование URLTemplate.Шаблон не поддерживается: элемент содержит вложенные объекты/
    );
    assert.deepStrictEqual(fs.readdirSync(extDir), ['Configuration.xml']);
  });

  test('неизвестный тип пропускается проверкой и отбивается borrowObject', () => {
    assert.throws(
      () => service.borrowForm(cfDir, extDir, 'constructor', 'X', 'Форма'),
      /constructor/
    );
    assert.strictEqual(service.getFolderName('constructor'), undefined);
  });

  test('оболочка без <ChildObjects>: блок дописывается, форма регистрируется, BOM и CRLF сохраняются', () => {
    const shell = writeLegacyShell();

    const result = service.borrowForm(cfDir, extDir, 'DataProcessor', 'Обработка', 'Форма');

    const xml = fs.readFileSync(shell, 'utf-8');
    assert.ok(xml.startsWith(BOM));
    assert.ok(xml.includes('\t\t</Properties>\r\n\t\t<ChildObjects>\r\n\t\t\t<Form>Форма</Form>\r\n\t\t</ChildObjects>\r\n'));
    assert.ok(!/[^\r]\n/.test(xml), 'все переводы строк остаются CRLF');
    assert.strictEqual(result.alreadyBorrowed, false);
    assert.ok(result.files.includes(shell));
  });

  test('файлы формы уже есть, а записи <Form> в оболочке нет: регистрация дописывается', () => {
    const shell = writeLegacyShell();
    const formMeta = path.join(extDir, 'DataProcessors', 'Обработка', 'Forms', 'Форма.xml');
    fs.mkdirSync(path.dirname(formMeta), { recursive: true });
    fs.writeFileSync(formMeta, '<MetaDataObject/>', 'utf-8');

    const result = service.borrowForm(cfDir, extDir, 'DataProcessor', 'Обработка', 'Форма');

    assert.deepStrictEqual(result, { alreadyBorrowed: false, files: [shell] });
    assert.ok(fs.readFileSync(shell, 'utf-8').includes('<Form>Форма</Form>'));

    assert.deepStrictEqual(
      service.borrowForm(cfDir, extDir, 'DataProcessor', 'Обработка', 'Форма'),
      { alreadyBorrowed: true, files: [] },
      'повторный вызов — форма уже заимствована и зарегистрирована'
    );
  });

  test('в XML оболочки нет <Properties>: исключение вместо молчаливого успеха', () => {
    writeLegacyShell(false);
    assert.throws(
      () => service.borrowForm(cfDir, extDir, 'DataProcessor', 'Обработка', 'Форма'),
      /Не удалось зарегистрировать Form.Форма: в XML объекта нет блока <Properties>/
    );
  });

  test('новая оболочка обработки получает <ChildObjects/>', () => {
    const result = service.borrowObject(cfDir, extDir, 'DataProcessor', 'Обработка');
    const shell = path.join(extDir, 'DataProcessors', 'Обработка.xml');
    assert.strictEqual(result.alreadyBorrowed, false);
    assert.ok(fs.readFileSync(shell, 'utf-8').includes('<ChildObjects/>'));
  });
});
