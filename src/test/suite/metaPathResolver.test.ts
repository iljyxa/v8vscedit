import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MetaPathResolver } from '../../infra/fs/MetaPathResolver';

suite('MetaPathResolver', () => {
  test('создаёт отсутствующий модуль объекта в штатном каталоге Ext', () => {
    // Берём любой Catalog из example/2.20/src/cf и копируем его во временный каталог.
    // Так тест не зависит от конкретного объекта в выгрузке и не модифицирует example/.
    const catalogsDir = path.join(__dirname, '..', '..', '..', 'example', '2.20', 'src', 'cf', 'Catalogs');
    const sourceEntry = fs.readdirSync(catalogsDir, { withFileTypes: true })
      .find((entry) => entry.isFile() && entry.name.endsWith('.xml'));
    assert.ok(sourceEntry, 'В example/2.20/src/cf/Catalogs нет ни одного справочника');
    const sourceXmlPath = path.join(catalogsDir, sourceEntry.name);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-module-path-'));
    const objectName = path.basename(sourceXmlPath, '.xml');
    const targetFolder = path.join(tempRoot, 'Catalogs');
    const targetXmlPath = path.join(targetFolder, `${objectName}.xml`);

    fs.mkdirSync(targetFolder, { recursive: true });
    fs.copyFileSync(sourceXmlPath, targetXmlPath);

    const modulePath = new MetaPathResolver().ensureModule({ xmlPath: targetXmlPath, kind: 'Catalog' }, 'Object');

    assert.strictEqual(modulePath, path.join(targetFolder, objectName, 'Ext', 'ObjectModule.bsl'));
    assert.strictEqual(fs.readFileSync(modulePath, 'utf8'), '');
  });

  test('создаёт модуль менеджера для справочника (разрешённый слот)', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-module-path-'));
    const xmlPath = path.join(tempRoot, 'Catalogs', 'TestCatalog.xml');
    fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
    fs.writeFileSync(xmlPath, '');

    const modulePath = new MetaPathResolver().ensureModule({ xmlPath, kind: 'Catalog' }, 'Manager');

    assert.ok(modulePath?.endsWith('ManagerModule.bsl'));
  });

  test('запрещает создание ObjectModule для регистра сведений', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-module-path-'));
    const xmlPath = path.join(tempRoot, 'InformationRegisters', 'TestRegister.xml');
    fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
    fs.writeFileSync(xmlPath, '');

    assert.throws(
      () => new MetaPathResolver().ensureModule({ xmlPath, kind: 'InformationRegister' }, 'Object'),
      /не поддерживает слот/
    );
  });

  test('запрещает создание ObjectModule для регистра накопления', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-module-path-'));
    const xmlPath = path.join(tempRoot, 'AccumulationRegisters', 'TestRegister.xml');
    fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
    fs.writeFileSync(xmlPath, '');

    assert.throws(
      () => new MetaPathResolver().ensureModule({ xmlPath, kind: 'AccumulationRegister' }, 'Object'),
      /не поддерживает слот/
    );
  });

  test('разрешает создание ManagerModule для регистра сведений', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-module-path-'));
    const xmlPath = path.join(tempRoot, 'InformationRegisters', 'TestRegister.xml');
    fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
    fs.writeFileSync(xmlPath, '');

    const modulePath = new MetaPathResolver().ensureModule({ xmlPath, kind: 'InformationRegister' }, 'Manager');

    assert.ok(modulePath?.endsWith('ManagerModule.bsl'));
  });

  /**
   * `resolveXml` уже умел искать и глубокую, и плоскую раскладку —
   * эти тесты фиксируют поведение (и защищают от регрессии), когда
   * реализация переедет на общую `findObjectXmlInFolder`
   * (`infra/fs/ObjectLocation.ts`), которой сейчас пользуется и
   * `SupportInfoService`, и `RepositoryService`.
   */
  suite('resolveXml', () => {
    test('находит XML в глубокой раскладке', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-resolve-xml-'));
      const deepPath = path.join(tempRoot, 'Catalogs', 'Спр1', 'Спр1.xml');
      fs.mkdirSync(path.dirname(deepPath), { recursive: true });
      fs.writeFileSync(deepPath, '');

      const result = new MetaPathResolver().resolveXml(tempRoot, 'Catalog', 'Спр1');

      assert.strictEqual(result, deepPath);
    });

    test('находит XML в плоской раскладке, если глубокой нет', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-resolve-xml-'));
      const flatPath = path.join(tempRoot, 'Catalogs', 'Спр1.xml');
      fs.mkdirSync(path.dirname(flatPath), { recursive: true });
      fs.writeFileSync(flatPath, '');

      const result = new MetaPathResolver().resolveXml(tempRoot, 'Catalog', 'Спр1');

      assert.strictEqual(result, flatPath);
    });

    test('возвращает null, если XML объекта не существует ни в одной из раскладок', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-resolve-xml-'));
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });

      const result = new MetaPathResolver().resolveXml(tempRoot, 'Catalog', 'НетТакогоСправочника');

      assert.strictEqual(result, null);
    });

    test('возвращает null для типа метаданных без папки выгрузки (например, служебной группы дерева)', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-resolve-xml-'));

      // 'group-type' — служебный узел дерева без записи `folder` в META_TYPES
      // (см. domain/MetaTypes.ts): getMetaFolder возвращает null для него.
      const result = new MetaPathResolver().resolveXml(tempRoot, 'group-type', 'Что-угодно');

      assert.strictEqual(result, null);
    });
  });
});
