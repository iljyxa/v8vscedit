import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';

/**
 * Список `files` результата заимствования — вход общего post-mutation пути
 * (`suppressConfigurationReloadForFiles` → `markChangedConfigurationByFiles` → refresh). Файл,
 * изменённый операцией, но не попавший в список, минует этот путь: конфигурация не помечается
 * изменённой по нему, а watcher видит правку как внешнюю. Поэтому список обязан перечислять
 * ровно изменённые файлы — без пропусков и без повторов.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example/2.21/src');
const CF_DIR = path.join(EXAMPLE_ROOT, 'cf');
const EVOLC_DIR = path.join(EXAMPLE_ROOT, 'cfe', 'EVOLC');

suite('CfeBorrowService — список изменённых файлов заимствования формы', () => {
  let extDir: string;
  let service: CfeBorrowService;

  setup(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-cfe-borrow-files-'));
    fs.cpSync(EVOLC_DIR, extDir, { recursive: true });
    service = new CfeBorrowService();
  });

  teardown(() => {
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  const formFiles = (objectName: string, formName: string): string[] => {
    const formsDir = path.join(extDir, 'Catalogs', objectName, 'Forms');
    return [
      path.join(formsDir, `${formName}.xml`),
      path.join(formsDir, formName, 'Ext', 'Form.xml'),
      path.join(formsDir, formName, 'Ext', 'Form', 'Module.bsl'),
    ];
  };

  test('родитель заимствован ранее: XML родителя, получивший запись <Form>, входит в files', () => {
    // Контрагенты заимствованы Конфигуратором, форм в расширении у них нет.
    const objFile = path.join(extDir, 'Catalogs', 'Контрагенты.xml');
    assert.ok(!fs.readFileSync(objFile, 'utf-8').includes('<Form>ФормаЭлемента</Form>'));

    const result = service.borrowForm(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');

    assert.ok(fs.readFileSync(objFile, 'utf-8').includes('<Form>ФормаЭлемента</Form>'));
    assert.deepStrictEqual(result, {
      alreadyBorrowed: false,
      files: [...formFiles('Контрагенты', 'ФормаЭлемента'), objFile],
    });
  });

  test('родитель заимствуется в том же вызове: XML родителя перечислен один раз', () => {
    const objFile = path.join(extDir, 'Catalogs', 'ПричиныВозврата.xml');
    assert.ok(!fs.existsSync(objFile), 'ПричиныВозврата не должны быть заимствованы в фикстуре');

    const result = service.borrowForm(CF_DIR, extDir, 'Catalog', 'ПричиныВозврата', 'ФормаЭлемента');

    assert.ok(fs.readFileSync(objFile, 'utf-8').includes('<Form>ФормаЭлемента</Form>'));
    assert.deepStrictEqual(result, {
      alreadyBorrowed: false,
      files: [
        objFile,
        path.join(extDir, 'Configuration.xml'),
        ...formFiles('ПричиныВозврата', 'ФормаЭлемента'),
      ],
    });
  });

  test('повторное заимствование формы ничего не меняет и возвращает пустой список', () => {
    service.borrowForm(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');
    const objFile = path.join(extDir, 'Catalogs', 'Контрагенты.xml');
    const before = fs.readFileSync(objFile, 'utf-8');

    const result = service.borrowForm(CF_DIR, extDir, 'Catalog', 'Контрагенты', 'ФормаЭлемента');

    assert.deepStrictEqual(result, { alreadyBorrowed: true, files: [] });
    assert.strictEqual(fs.readFileSync(objFile, 'utf-8'), before);
  });
});
