import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveObjectScope,
  isPathInScope,
  collectScopeFiles,
  mapDumpPathToProject,
  resolveOwnerFullNameByRelativePath,
  type ObjectScope,
} from '../../infra/repository/RepositoryObjectScope';
import { CONFIGURATION_ROOT_LOCK_NAME, getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { fixtureUuid, writeConfigurationXml, writeObjectXml } from './support/flatMetadataFixtures';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

const cfTarget: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };

function posix(rel: string): string {
  return rel.split(path.sep).join('/');
}

suite('RepositoryObjectScope — resolveObjectScope', () => {
  test('корневое имя (сентинел) → {kind:"root"}', () => {
    const scope = resolveObjectScope(EXAMPLE_CF, getRootLockName(cfTarget), cfTarget);
    assert.deepStrictEqual(scope, { kind: 'root', fullName: CONFIGURATION_ROOT_LOCK_NAME });
  });

  test('неизвестный fullName → null', () => {
    assert.strictEqual(resolveObjectScope(EXAMPLE_CF, 'НеизвестныйТип.Что-то', cfTarget), null);
    assert.strictEqual(resolveObjectScope(EXAMPLE_CF, 'БезТочки', cfTarget), null);
  });

  test('объект без файла ни в плоской, ни в глубокой раскладке → null', () => {
    assert.strictEqual(resolveObjectScope(EXAMPLE_CF, 'Справочник.НетТакогоСправочника', cfTarget), null);
  });

  test('реальный объект (Контрагенты, плоская раскладка) — xmlRel вне dirRel, дочерние файлы под dirRel', () => {
    const scope = resolveObjectScope(EXAMPLE_CF, 'Справочник.Контрагенты', cfTarget);
    assert.ok(scope?.kind === 'object');
    const objectScope = scope;
    assert.strictEqual(objectScope.fullName, 'Справочник.Контрагенты');
    assert.strictEqual(posix(objectScope.xmlRel), 'Catalogs/Контрагенты.xml');

    const files = collectScopeFiles(EXAMPLE_CF, scope).map(posix);
    assert.ok(files.includes('Catalogs/Контрагенты.xml'));
    assert.ok(files.includes('Catalogs/Контрагенты/Ext/ObjectModule.bsl'));
    assert.ok(files.includes('Catalogs/Контрагенты/Forms/ФормаСписка.xml'));
    assert.ok(files.includes('Catalogs/Контрагенты/Templates/ЗагрузкаИзФайла.xml'));
    // Соседний объект не должен попасть в область.
    assert.ok(!files.some((file: string) => file.includes('Валюты')));
  });

  test('реальный объект с Ext (Валюты) — файлы Ext/Help учитываются', () => {
    const scope = resolveObjectScope(EXAMPLE_CF, 'Справочник.Валюты', cfTarget);
    assert.ok(scope?.kind === 'object');
    const files = collectScopeFiles(EXAMPLE_CF, scope).map(posix);
    assert.ok(files.includes('Catalogs/Валюты.xml'));
    assert.ok(files.includes('Catalogs/Валюты/Ext/Help.xml'));
    assert.ok(files.includes('Catalogs/Валюты/Ext/Help/ru.html'));
    assert.ok(files.includes('Catalogs/Валюты/Ext/ObjectModule.bsl'));
  });

  test('глубокая раскладка (<Folder>/<Name>/<Name>.xml) — xmlRel внутри dirRel', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-scope-deep-'));
    try {
      const configUuid = fixtureUuid('scope-deep-config');
      const objectUuid = fixtureUuid('scope-deep-object');
      writeConfigurationXml(tempDir, configUuid);
      writeObjectXml(tempDir, 'Catalogs', 'Глубокий', 'Catalog', objectUuid, 'deep');
      fs.mkdirSync(path.join(tempDir, 'Catalogs', 'Глубокий', 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'Catalogs', 'Глубокий', 'Ext', 'ObjectModule.bsl'), 'Процедура X() КонецПроцедуры', 'utf-8');

      const target: RepositoryTarget = { configRoot: tempDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(tempDir, 'Справочник.Глубокий', target);
      assert.ok(scope?.kind === 'object');
      const objectScope = scope;
      assert.strictEqual(posix(objectScope.xmlRel), 'Catalogs/Глубокий/Глубокий.xml');

      const files = collectScopeFiles(tempDir, scope).map(posix);
      assert.deepStrictEqual(
        [...files].sort(),
        ['Catalogs/Глубокий/Ext/ObjectModule.bsl', 'Catalogs/Глубокий/Глубокий.xml'].sort()
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('плоская раскладка без каталога объекта (только XML, нет дочерних файлов) — dirRel не даёт лишних файлов', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-scope-flat-nodir-'));
    try {
      const configUuid = fixtureUuid('scope-flat-config');
      const objectUuid = fixtureUuid('scope-flat-object');
      writeConfigurationXml(tempDir, configUuid);
      writeObjectXml(tempDir, 'Catalogs', 'ПростойСправочник', 'Catalog', objectUuid, 'flat');

      const target: RepositoryTarget = { configRoot: tempDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(tempDir, 'Справочник.ПростойСправочник', target);
      assert.ok(scope?.kind === 'object');
      const files = collectScopeFiles(tempDir, scope).map(posix);
      assert.deepStrictEqual(files, ['Catalogs/ПростойСправочник.xml']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('корень — область: Configuration.xml + корневой Ext/**, без объектных папок', () => {
    const scope = resolveObjectScope(EXAMPLE_CF, getRootLockName(cfTarget), cfTarget);
    assert.ok(scope);
    assert.strictEqual(isPathInScope('Configuration.xml', scope), true);
    assert.strictEqual(isPathInScope('Ext/ManagedApplicationModule.bsl', scope), true);
    assert.strictEqual(isPathInScope('Catalogs/Контрагенты.xml', scope), false);
    assert.strictEqual(isPathInScope('ConfigDumpInfo.xml', scope), false);
  });

  test('подсистема с вложенными подсистемами — вложенная ветка Subsystems/** исключается из области', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-scope-subsystem-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'Subsystems', 'Родитель', 'Subsystems'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'Subsystems', 'Родитель.xml'), '<MetaDataObject/>', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, 'Subsystems', 'Родитель', 'Subsystems', 'Дочерняя.xml'),
        '<MetaDataObject/>',
        'utf-8'
      );

      const target: RepositoryTarget = { configRoot: tempDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(tempDir, 'Подсистема.Родитель', target);
      assert.ok(scope?.kind === 'object');
      const objectScope = scope;
      assert.ok(objectScope.excludeDirRels.length > 0, 'excludeDirRels должен содержать вложенную ветку Subsystems/**.');

      assert.strictEqual(isPathInScope('Subsystems/Родитель.xml', scope), true);
      assert.strictEqual(isPathInScope('Subsystems/Родитель/Subsystems/Дочерняя.xml', scope), false);

      const files = collectScopeFiles(tempDir, scope).map(posix);
      assert.ok(files.includes('Subsystems/Родитель.xml'));
      assert.ok(!files.includes('Subsystems/Родитель/Subsystems/Дочерняя.xml'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

suite('RepositoryObjectScope — collectScopeFiles: ConfigDumpInfo.xml всегда исключён, kind:"all" не фильтрует по расширению', () => {
  test('kind:"all" возвращает все файлы дерева, кроме ConfigDumpInfo.xml', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-scope-all-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'Catalogs', 'Товары.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'ConfigDumpInfo.xml'), '<skip/>', 'utf-8');
      fs.writeFileSync(path.join(tempDir, 'Configuration.xml'), '<xml/>', 'utf-8');
      // Бинарный файл (например картинка) не должен отфильтровываться — в отличие
      // от HashCache.isSupportedConfigFile, здесь нужна побайтовая синхронизация ЛЮБОГО файла области.
      fs.writeFileSync(path.join(tempDir, 'Catalogs', 'Значок.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const allScope: ObjectScope = { kind: 'all' };
      const files = collectScopeFiles(tempDir, allScope).map(posix).sort();
      assert.deepStrictEqual(files, ['Catalogs/Значок.png', 'Catalogs/Товары.xml', 'Configuration.xml']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('isPathInScope для kind:"all" всегда true', () => {
    const allScope: ObjectScope = { kind: 'all' };
    assert.strictEqual(isPathInScope('Catalogs/Что-угодно.xml', allScope), true);
    assert.strictEqual(isPathInScope('', allScope), true);
  });
});

suite('RepositoryObjectScope — mapDumpPathToProject', () => {
  test('XML владельца ремапится при разной раскладке dump/project, дочерние файлы не меняются', () => {
    const flatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-scope-map-flat-'));
    const deepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-scope-map-deep-'));
    try {
      const flatTarget: RepositoryTarget = { configRoot: flatDir, configKind: 'cf', displayName: 'Тест' };
      const deepTarget: RepositoryTarget = { configRoot: deepDir, configKind: 'cf', displayName: 'Тест' };
      writeConfigurationXml(flatDir, fixtureUuid('map-flat-config'));
      writeConfigurationXml(deepDir, fixtureUuid('map-deep-config'));
      writeObjectXml(flatDir, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('map-flat-object'), 'flat');
      writeObjectXml(deepDir, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('map-deep-object'), 'deep');
      fs.mkdirSync(path.join(flatDir, 'Catalogs', 'Объект', 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(flatDir, 'Catalogs', 'Объект', 'Ext', 'ObjectModule.bsl'), 'А', 'utf-8');
      fs.mkdirSync(path.join(deepDir, 'Catalogs', 'Объект', 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(deepDir, 'Catalogs', 'Объект', 'Ext', 'ObjectModule.bsl'), 'Б', 'utf-8');

      const flatScope = resolveObjectScope(flatDir, 'Справочник.Объект', flatTarget);
      const deepScope = resolveObjectScope(deepDir, 'Справочник.Объект', deepTarget);
      assert.ok(flatScope?.kind === 'object');
      assert.ok(deepScope?.kind === 'object');

      // dump — плоский, project — глубокий: XML должен ремапиться на глубокий путь project'а.
      const mappedXml = mapDumpPathToProject((flatScope).xmlRel, flatScope, 'deep');
      assert.strictEqual(posix(mappedXml), posix((deepScope).xmlRel));

      // dump и project имеют одинаковую раскладку — путь не меняется.
      const unchangedXml = mapDumpPathToProject((flatScope).xmlRel, flatScope, 'flat');
      assert.strictEqual(posix(unchangedXml), posix((flatScope).xmlRel));

      // Дочерний файл (Ext/ObjectModule.bsl) не зависит от раскладки XML — путь идентичен в обеих раскладках.
      const childRel = posix(path.join('Catalogs', 'Объект', 'Ext', 'ObjectModule.bsl'));
      assert.strictEqual(posix(mapDumpPathToProject(childRel, flatScope, 'deep')), childRel);
    } finally {
      fs.rmSync(flatDir, { recursive: true, force: true });
      fs.rmSync(deepDir, { recursive: true, force: true });
    }
  });

  test('для root/all-области путь возвращается без изменений', () => {
    const rootScope: ObjectScope = { kind: 'root', fullName: CONFIGURATION_ROOT_LOCK_NAME };
    assert.strictEqual(mapDumpPathToProject('Configuration.xml', rootScope, 'deep'), 'Configuration.xml');
    const allScope: ObjectScope = { kind: 'all' };
    assert.strictEqual(mapDumpPathToProject('Catalogs/Товары.xml', allScope, 'flat'), 'Catalogs/Товары.xml');
  });
});

suite('RepositoryObjectScope — resolveOwnerFullNameByRelativePath', () => {
  test('обычный объект (Catalogs/Контрагенты.xml) → "Справочник.Контрагенты"', () => {
    assert.strictEqual(resolveOwnerFullNameByRelativePath('Catalogs/Контрагенты.xml', cfTarget), 'Справочник.Контрагенты');
  });

  test('дочерний файл владельца (Catalogs/Контрагенты/Ext/ObjectModule.bsl) → тот же владелец', () => {
    assert.strictEqual(resolveOwnerFullNameByRelativePath('Catalogs/Контрагенты/Ext/ObjectModule.bsl', cfTarget), 'Справочник.Контрагенты');
  });

  test('форма объекта (Catalogs/Контрагенты/Forms/ФормаСписка.xml) → владелец Контрагенты', () => {
    assert.strictEqual(
      resolveOwnerFullNameByRelativePath('Catalogs/Контрагенты/Forms/ФормаСписка.xml', cfTarget),
      'Справочник.Контрагенты'
    );
  });

  test('Configuration.xml → сентинел корня', () => {
    assert.strictEqual(resolveOwnerFullNameByRelativePath('Configuration.xml', cfTarget), getRootLockName(cfTarget));
  });

  test('корневой Ext/** (модуль сеанса и т.п.) → сентинел корня', () => {
    assert.strictEqual(resolveOwnerFullNameByRelativePath('Ext/SessionModule.bsl', cfTarget), getRootLockName(cfTarget));
  });

  test('ConfigDumpInfo.xml → null (служебный файл, не относится ни к одному владельцу)', () => {
    assert.strictEqual(resolveOwnerFullNameByRelativePath('ConfigDumpInfo.xml', cfTarget), null);
  });

  test('неизвестная папка верхнего уровня → null', () => {
    assert.strictEqual(resolveOwnerFullNameByRelativePath('НеизвестнаяПапка/Файл.xml', cfTarget), null);
  });

  test('расширение (cfe): реальный объект EVOLC резолвится так же, без нового словаря папок', () => {
    const evolcTarget: RepositoryTarget = { configRoot: EXAMPLE_EVOLC, configKind: 'cfe', extensionName: 'EVOLC', displayName: 'EVOLC' };
    assert.strictEqual(resolveOwnerFullNameByRelativePath('Catalogs/Контрагенты.xml', evolcTarget), 'Справочник.Контрагенты');
    assert.strictEqual(resolveOwnerFullNameByRelativePath('Configuration.xml', evolcTarget), getRootLockName(evolcTarget));
  });
});
