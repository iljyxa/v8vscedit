/**
 * `SupportInfoService` (в отличие от других резолверов XML объекта)
 * не находил объект в плоской выгрузке `<root>/<folder>/<name>.xml` — искали
 * только глубокую `<root>/<folder>/<name>/<name>.xml`. `findObjectXmlInFolder`
 * — единая функция поиска (deep → flat → null), которую переиспользуют
 * `MetaPathResolver.resolveXml`, `RepositoryService.resolveOwnerObjectXmlPath`
 * и `SupportInfoService.resolveObjectXmlForBsl`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findObjectXmlInFolder } from '../../infra/fs/ObjectLocation';
import { findObjectXmlInFolder as findObjectXmlInFolderViaIndex } from '../../infra/fs';

suite('findObjectXmlInFolder', () => {
  let tempRoot: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-object-location-'));
  });

  teardown(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('находит объект в глубокой раскладке (<folder>/<name>/<name>.xml), когда плоской нет', () => {
    const deepPath = path.join(tempRoot, 'CommonModules', 'Общий', 'Общий.xml');
    fs.mkdirSync(path.dirname(deepPath), { recursive: true });
    fs.writeFileSync(deepPath, '<MetaDataObject/>', 'utf-8');

    const result = findObjectXmlInFolder(tempRoot, 'CommonModules', 'Общий');

    assert.strictEqual(result, deepPath);
  });

  test('находит объект в плоской раскладке (<folder>/<name>.xml), когда глубокой нет', () => {
    const flatPath = path.join(tempRoot, 'CommonModules', 'Общий.xml');
    fs.mkdirSync(path.dirname(flatPath), { recursive: true });
    fs.writeFileSync(flatPath, '<MetaDataObject/>', 'utf-8');

    const result = findObjectXmlInFolder(tempRoot, 'CommonModules', 'Общий');

    assert.strictEqual(result, flatPath);
  });

  test('при наличии обеих раскладок отдаёт приоритет глубокой (порядок: deep → flat)', () => {
    const folderDir = path.join(tempRoot, 'CommonModules');
    const deepPath = path.join(folderDir, 'Общий', 'Общий.xml');
    const flatPath = path.join(folderDir, 'Общий.xml');
    fs.mkdirSync(path.dirname(deepPath), { recursive: true });
    fs.writeFileSync(deepPath, '<MetaDataObject/>', 'utf-8');
    fs.writeFileSync(flatPath, '<MetaDataObject/>', 'utf-8');

    const result = findObjectXmlInFolder(tempRoot, 'CommonModules', 'Общий');

    assert.strictEqual(result, deepPath);
  });

  test('возвращает null, если ни глубокого, ни плоского файла нет, но папка категории существует', () => {
    fs.mkdirSync(path.join(tempRoot, 'CommonModules'), { recursive: true });

    const result = findObjectXmlInFolder(tempRoot, 'CommonModules', 'Отсутствующий');

    assert.strictEqual(result, null);
  });

  test('возвращает null, если папка категории отсутствует вовсе', () => {
    const result = findObjectXmlInFolder(tempRoot, 'НетТакойПапки', 'Что-угодно');

    assert.strictEqual(result, null);
  });

  test('реэкспортируется через infra/fs/index.ts (export *)', () => {
    const deepPath = path.join(tempRoot, 'Catalogs', 'Спр', 'Спр.xml');
    fs.mkdirSync(path.dirname(deepPath), { recursive: true });
    fs.writeFileSync(deepPath, '<MetaDataObject/>', 'utf-8');

    assert.strictEqual(findObjectXmlInFolderViaIndex(tempRoot, 'Catalogs', 'Спр'), deepPath);
  });
});
