import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncConfigurationChildObjects } from '../../infra/repository/ConfigurationChildObjectsSync';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';

/**
 * `syncConfigurationChildObjects` — узкий адаптер поверх уже существующего
 * `ConfigurationXmlEditor.addChildObject`/`removeChildObject` (issue #1, критерий
 * приёмки №12): принимает набор РУССКИХ технических fullName объектов
 * («Справочник.Новый»), появившихся/исчезнувших после получения из хранилища, и
 * синхронизирует блок `<ChildObjects>` `Configuration.xml`, не заводя параллельного
 * словаря типов (порядок и BOM/EOL — целиком на стороне уже протестированного
 * `ConfigurationXmlEditor`).
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

function copyConfigTree(sourceRoot: string, destRoot: string): void {
  fs.cpSync(sourceRoot, destRoot, { recursive: true });
}

suite('ConfigurationChildObjectsSync', () => {
  let editor: ConfigurationXmlEditor;

  setup(() => {
    editor = new ConfigurationXmlEditor();
  });

  [
    { label: 'cf', sourceRoot: EXAMPLE_CF, configKind: 'cf' as const, extensionName: undefined },
    { label: 'cfe (EVOLC)', sourceRoot: EXAMPLE_EVOLC, configKind: 'cfe' as const, extensionName: 'EVOLC' },
  ].forEach(({ label, sourceRoot, configKind, extensionName }) => {
    test(`${label}: добавление нового объекта записывает его в ChildObjects Configuration.xml, сохраняя BOM/EOL`, () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-'));
      try {
        copyConfigTree(sourceRoot, tempRoot);
        const configXmlPath = path.join(tempRoot, 'Configuration.xml');
        const originalBytes = fs.readFileSync(configXmlPath);

        fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
        fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'НовыйСправочник.xml'), '<MetaDataObject/>', 'utf-8');

        const target: RepositoryTarget = { configRoot: tempRoot, configKind, extensionName, displayName: label };
        const result = syncConfigurationChildObjects(tempRoot, { added: ['Справочник.НовыйСправочник'], removed: [] }, editor);

        assert.deepStrictEqual(result.warnings, []);
        assert.ok(result.changedFiles.some((file: string) => path.resolve(file) === path.resolve(configXmlPath)));

        const updatedBytes = fs.readFileSync(configXmlPath);
        assert.deepStrictEqual(updatedBytes.subarray(0, 3), originalBytes.subarray(0, 3), 'BOM должен сохраниться.');
        const updatedText = updatedBytes.toString('utf-8');
        assert.ok(updatedText.includes('<Catalog>НовыйСправочник</Catalog>'));
        assert.ok(updatedText.includes('\r\n'), 'Стиль переводов строк (CRLF) должен сохраниться.');

        // resolveObjectScope этого же модуля не нужен — довольно факта появления записи ChildObjects.
        void target;
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  test('добавление уже существующего в ChildObjects объекта — предупреждение, файл не помечается изменённым', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-dup-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      const result = syncConfigurationChildObjects(tempRoot, { added: ['Справочник.Контрагенты'], removed: [] }, editor);
      assert.strictEqual(result.changedFiles.length, 0);
      assert.strictEqual(result.warnings.length, 1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('удаление объекта из ChildObjects', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-remove-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      const configXmlPath = path.join(tempRoot, 'Configuration.xml');

      const result = syncConfigurationChildObjects(tempRoot, { added: [], removed: ['Справочник.Контрагенты'] }, editor);

      assert.deepStrictEqual(result.warnings, []);
      assert.ok(result.changedFiles.some((file: string) => path.resolve(file) === path.resolve(configXmlPath)));
      const updatedText = fs.readFileSync(configXmlPath, 'utf-8');
      assert.ok(!updatedText.includes('<Catalog>Контрагенты</Catalog>'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('удаление объекта, которого нет в ChildObjects — предупреждение', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-remove-missing-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      const result = syncConfigurationChildObjects(tempRoot, { added: [], removed: ['Справочник.НетТакого'] }, editor);
      assert.strictEqual(result.changedFiles.length, 0);
      assert.strictEqual(result.warnings.length, 1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('неизвестный технический тип объекта → предупреждение, ChildObjects не трогается', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-unknown-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      const configXmlPath = path.join(tempRoot, 'Configuration.xml');
      const before = fs.readFileSync(configXmlPath, 'utf-8');

      const result = syncConfigurationChildObjects(tempRoot, { added: ['НеизвестныйТип.Что-то'], removed: [] }, editor);

      assert.strictEqual(result.changedFiles.length, 0);
      assert.strictEqual(result.warnings.length, 1);
      assert.strictEqual(fs.readFileSync(configXmlPath, 'utf-8'), before);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('сентинел корня конфигурации/расширения в added/removed молча пропускается (не объект ChildObjects)', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-root-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      const configXmlPath = path.join(tempRoot, 'Configuration.xml');
      const before = fs.readFileSync(configXmlPath, 'utf-8');
      const target: RepositoryTarget = { configRoot: tempRoot, configKind: 'cf', displayName: 'Тест' };

      const result = syncConfigurationChildObjects(
        tempRoot,
        { added: [getRootLockName(target)], removed: [] },
        editor
      );

      assert.deepStrictEqual(result.warnings, []);
      assert.strictEqual(result.changedFiles.length, 0);
      assert.strictEqual(fs.readFileSync(configXmlPath, 'utf-8'), before);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('вложенная подсистема (файл вложен внутрь родительской, а не на верхнем уровне Subsystems/) — не добавляется в ChildObjects, предупреждение', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-nested-subsystem-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      // "Дочерняя" физически лежит только внутри родительской подсистемы, а не как
      // Subsystems/Дочерняя.xml верхнего уровня — addChildObject не находит файл по
      // ожидаемому верхнеуровневому пути и не должен создавать в Configuration.xml
      // ссылку на несуществующий (для этого уровня) объект.
      fs.mkdirSync(path.join(tempRoot, 'Subsystems', 'Продажи', 'Subsystems'), { recursive: true });
      fs.writeFileSync(
        path.join(tempRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Дочерняя.xml'),
        '<MetaDataObject/>',
        'utf-8'
      );
      const configXmlPath = path.join(tempRoot, 'Configuration.xml');
      const before = fs.readFileSync(configXmlPath, 'utf-8');

      const result = syncConfigurationChildObjects(tempRoot, { added: ['Подсистема.Дочерняя'], removed: [] }, editor);

      assert.strictEqual(result.changedFiles.length, 0);
      assert.strictEqual(result.warnings.length, 1);
      assert.strictEqual(fs.readFileSync(configXmlPath, 'utf-8'), before);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('несколько добавлений разных видов за один вызов — порядок в ChildObjects соответствует META_TYPES (Catalog раньше Report)', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-order-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, 'Reports'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'НовыйСправочник2.xml'), '<MetaDataObject/>', 'utf-8');
      fs.writeFileSync(path.join(tempRoot, 'Reports', 'НовыйОтчет.xml'), '<MetaDataObject/>', 'utf-8');

      // Порядок аргументов намеренно "неправильный" (Report раньше Catalog).
      const result = syncConfigurationChildObjects(
        tempRoot,
        { added: ['Отчет.НовыйОтчет', 'Справочник.НовыйСправочник2'], removed: [] },
        editor
      );

      assert.deepStrictEqual(result.warnings, []);
      const configXmlPath = path.join(tempRoot, 'Configuration.xml');
      const text = fs.readFileSync(configXmlPath, 'utf-8');
      const catalogIndex = text.indexOf('<Catalog>НовыйСправочник2</Catalog>');
      const reportIndex = text.indexOf('<Report>НовыйОтчет</Report>');
      assert.ok(catalogIndex >= 0 && reportIndex >= 0);
      assert.ok(catalogIndex < reportIndex, 'Catalog должен идти раньше Report — порядок META_TYPES.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('added и removed в одном вызове — обе операции применяются', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-both-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'НовыйСправочник3.xml'), '<MetaDataObject/>', 'utf-8');

      const result = syncConfigurationChildObjects(
        tempRoot,
        { added: ['Справочник.НовыйСправочник3'], removed: ['Справочник.Контрагенты'] },
        editor
      );

      assert.deepStrictEqual(result.warnings, []);
      const text = fs.readFileSync(path.join(tempRoot, 'Configuration.xml'), 'utf-8');
      assert.ok(text.includes('<Catalog>НовыйСправочник3</Catalog>'));
      assert.ok(!text.includes('<Catalog>Контрагенты</Catalog>'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('пустые added/removed — не трогают Configuration.xml', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-childobjects-sync-empty-'));
    try {
      copyConfigTree(EXAMPLE_CF, tempRoot);
      const configXmlPath = path.join(tempRoot, 'Configuration.xml');
      const before = fs.readFileSync(configXmlPath, 'utf-8');

      const result = syncConfigurationChildObjects(tempRoot, { added: [], removed: [] }, editor);

      assert.deepStrictEqual(result, { changedFiles: [], warnings: [] });
      assert.strictEqual(fs.readFileSync(configXmlPath, 'utf-8'), before);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
