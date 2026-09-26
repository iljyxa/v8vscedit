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
  resolveUnitXmlRel,
  resolveLockUnitByRelativePath,
  removeEmptyParentDirs,
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

  test('подсистема с вложенными подсистемами, depth="unit" — вложенная ветка Subsystems/** исключается из области (issue #1, раздел 10, Р3)', () => {
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
      // Раздел 10, Р3: НОВОЕ поведение по умолчанию (без depth) — 'tree' (весь каталог,
      // без исключений, см. отдельный тест ниже); исключение вложенных подсистем — это
      // теперь СПЕЦИФИЧНОЕ поведение depth:'unit' (обычная операция слияния/снимка/сравнения).
      const scope = resolveObjectScope(tempDir, 'Подсистема.Родитель', target, 'unit');
      assert.ok(scope?.kind === 'object');
      const objectScope = scope;
      assert.ok(objectScope.excludeDirRels.length > 0, 'excludeDirRels должен содержать вложенную ветку Subsystems/** при depth:"unit".');

      assert.strictEqual(isPathInScope('Subsystems/Родитель.xml', scope), true);
      assert.strictEqual(isPathInScope('Subsystems/Родитель/Subsystems/Дочерняя.xml', scope), false);

      const files = collectScopeFiles(tempDir, scope).map(posix);
      assert.ok(files.includes('Subsystems/Родитель.xml'));
      assert.ok(!files.includes('Subsystems/Родитель/Subsystems/Дочерняя.xml'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('подсистема с вложенными подсистемами, depth="tree" (и умолчание) — весь каталог, БЕЗ исключений (issue #1, раздел 10, Р3)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-scope-subsystem-tree-'));
    try {
      fs.mkdirSync(path.join(tempDir, 'Subsystems', 'Родитель', 'Subsystems'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'Subsystems', 'Родитель.xml'), '<MetaDataObject/>', 'utf-8');
      fs.writeFileSync(
        path.join(tempDir, 'Subsystems', 'Родитель', 'Subsystems', 'Дочерняя.xml'),
        '<MetaDataObject/>',
        'utf-8'
      );

      const target: RepositoryTarget = { configRoot: tempDir, configKind: 'cf', displayName: 'Тест' };
      const explicitTreeScope = resolveObjectScope(tempDir, 'Подсистема.Родитель', target, 'tree');
      const defaultScope = resolveObjectScope(tempDir, 'Подсистема.Родитель', target);
      assert.ok(explicitTreeScope?.kind === 'object' && defaultScope?.kind === 'object');
      assert.deepStrictEqual(explicitTreeScope.excludeDirRels, [], 'depth:"tree" — весь каталог, ничего не исключается.');
      assert.deepStrictEqual(defaultScope.excludeDirRels, [], 'depth по умолчанию должен совпадать с "tree" (сохранение обратной совместимости для необновлённых вызывающих).');

      assert.strictEqual(isPathInScope('Subsystems/Родитель/Subsystems/Дочерняя.xml', explicitTreeScope), true);
      const files = collectScopeFiles(tempDir, explicitTreeScope).map(posix);
      assert.ok(files.includes('Subsystems/Родитель/Subsystems/Дочерняя.xml'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('реальный объект (Контрагенты), depth="unit" — Forms/Templates исключены, Commands (не в REPOSITORY_SUBORDINATE_LAYOUT) остаётся (issue #1, раздел 10, Р3/Р6)', () => {
    const scope = resolveObjectScope(EXAMPLE_CF, 'Справочник.Контрагенты', cfTarget, 'unit');
    assert.ok(scope?.kind === 'object');
    const files = collectScopeFiles(EXAMPLE_CF, scope).map(posix);
    assert.ok(files.includes('Catalogs/Контрагенты.xml'));
    assert.ok(files.includes('Catalogs/Контрагенты/Ext/ObjectModule.bsl'));
    assert.ok(!files.some((file) => file.startsWith('Catalogs/Контрагенты/Forms/')), 'Formsне должны входить в область владельца при depth:"unit" — форма выгружается как отдельная единица (D2).');
    assert.ok(!files.some((file) => file.startsWith('Catalogs/Контрагенты/Templates/')), 'Templates не должны входить в область владельца при depth:"unit".');
    assert.ok(files.some((file) => file.startsWith('Catalogs/Контрагенты/Commands/')), 'Command НЕ входит в REPOSITORY_SUBORDINATE_LAYOUT (выгружается вместе с владельцем) — Commands/** остаётся в области.');
  });

  test('реальный объект (Начисления, РегистрРасчета), depth="unit" — Recalculations исключён', () => {
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
    const scope = resolveObjectScope(EXAMPLE_CF, 'РегистрРасчета.Начисления', target, 'unit');
    assert.ok(scope?.kind === 'object');
    const files = collectScopeFiles(EXAMPLE_CF, scope).map(posix);
    assert.ok(files.includes('CalculationRegisters/Начисления.xml'));
    assert.ok(!files.some((file) => file.startsWith('CalculationRegisters/Начисления/Recalculations/')));
  });

  test('реальный объект (ИнтернетМагазин, ВнешнийИсточникДанных), depth="unit" — Tables/Cubes исключены; depth="tree" — включены', () => {
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
    const unitScope = resolveObjectScope(EXAMPLE_CF, 'ВнешнийИсточникДанных.ИнтернетМагазин', target, 'unit');
    assert.ok(unitScope?.kind === 'object');
    const unitFiles = collectScopeFiles(EXAMPLE_CF, unitScope).map(posix);
    assert.ok(!unitFiles.some((file) => file.startsWith('ExternalDataSources/ИнтернетМагазин/Tables/')));
    assert.ok(!unitFiles.some((file) => file.startsWith('ExternalDataSources/ИнтернетМагазин/Cubes/')));

    const treeScope = resolveObjectScope(EXAMPLE_CF, 'ВнешнийИсточникДанных.ИнтернетМагазин', target, 'tree');
    assert.ok(treeScope?.kind === 'object');
    const treeFiles = collectScopeFiles(EXAMPLE_CF, treeScope).map(posix);
    assert.ok(treeFiles.includes('ExternalDataSources/ИнтернетМагазин/Tables/Заказы.xml'));
    assert.ok(treeFiles.includes('ExternalDataSources/ИнтернетМагазин/Cubes/Продажи.xml'));
    // depth:"tree" — весь каталог рекурсивно, включая таблицы измерения куба.
    assert.ok(treeFiles.includes('ExternalDataSources/ИнтернетМагазин/Cubes/Продажи/DimensionTables/Товары.xml'));
  });

  test('resolveObjectScope понимает имена ЕДИНИЦ (не только верхнеуровневых объектов): форма Контрагенты — область = её собственный каталог', () => {
    const scope = resolveObjectScope(EXAMPLE_CF, 'Справочник.Контрагенты.Форма.ФормаЭлемента', cfTarget, 'unit');
    assert.ok(scope?.kind === 'object');
    assert.strictEqual(scope.fullName, 'Справочник.Контрагенты.Форма.ФормаЭлемента');
    assert.strictEqual(posix(scope.xmlRel), 'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml');
    const files = collectScopeFiles(EXAMPLE_CF, scope).map(posix);
    assert.deepStrictEqual(
      [...files].sort(),
      ['Catalogs/Контрагенты/Forms/ФормаЭлемента.xml', 'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form.xml', 'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form/Module.bsl'].sort()
    );
  });

  test('resolveObjectScope понимает дважды вложенную единицу: таблица измерения куба ИнтернетМагазин', () => {
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
    const scope = resolveObjectScope(
      EXAMPLE_CF,
      'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары',
      target,
      'unit'
    );
    assert.ok(scope?.kind === 'object');
    assert.strictEqual(posix(scope.xmlRel), 'ExternalDataSources/ИнтернетМагазин/Cubes/Продажи/DimensionTables/Товары.xml');
  });

  test('resolveObjectScope для куба (единицы с собственными подчинёнными таблицами измерения), depth="unit" — DimensionTables исключены из СВОЕЙ области', () => {
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
    const scope = resolveObjectScope(EXAMPLE_CF, 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи', target, 'unit');
    assert.ok(scope?.kind === 'object');
    const files = collectScopeFiles(EXAMPLE_CF, scope).map(posix);
    assert.ok(files.includes('ExternalDataSources/ИнтернетМагазин/Cubes/Продажи.xml'));
    assert.ok(!files.some((file) => file.startsWith('ExternalDataSources/ИнтернетМагазин/Cubes/Продажи/DimensionTables/')));
  });

  test('resolveObjectScope: неизвестная единица (нераспознанный подчинённый тег) → null', () => {
    const scope = resolveObjectScope(EXAMPLE_CF, 'Справочник.Контрагенты.НеизвестныйТег.Х', cfTarget, 'unit');
    assert.strictEqual(scope, null);
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

/**
 * `resolveUnitXmlRel` — раздел 10, Р3/Р8: путь к ОСНОВНОМУ XML единицы (владельца
 * или подчинённого) относительно `baseDir`, без сборки полного `ObjectScope`.
 * Нужен планировщику раундов выгрузки (`RepositoryDumpRounds`), чтобы найти XML
 * найденной единицы в каталоге очередного раунда и прочитать её собственные
 * дочерние ссылки (`ChildObjectRefsReader`).
 */
suite('RepositoryObjectScope — resolveUnitXmlRel (issue #1, раздел 10, Р3/Р8)', () => {
  test('владелец верхнего уровня (плоская раскладка)', () => {
    assert.strictEqual(posix(resolveUnitXmlRel(EXAMPLE_CF, 'Справочник.Контрагенты') ?? ''), 'Catalogs/Контрагенты.xml');
  });

  test('форма — подчинённая единица', () => {
    assert.strictEqual(
      posix(resolveUnitXmlRel(EXAMPLE_CF, 'Справочник.Контрагенты.Форма.ФормаЭлемента') ?? ''),
      'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml'
    );
  });

  test('таблица измерения куба — дважды вложенная единица', () => {
    assert.strictEqual(
      posix(resolveUnitXmlRel(EXAMPLE_CF, 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Регионы') ?? ''),
      'ExternalDataSources/ИнтернетМагазин/Cubes/Продажи/DimensionTables/Регионы.xml'
    );
  });

  test('единица не существует в baseDir (нет файла) → null', () => {
    assert.strictEqual(resolveUnitXmlRel(EXAMPLE_CF, 'Справочник.Контрагенты.Форма.НетТакойФормы'), null);
  });

  test('неизвестная единица (нераспознанное имя) → null', () => {
    assert.strictEqual(resolveUnitXmlRel(EXAMPLE_CF, 'БезТочки'), null);
  });

  test('вид без папки в META_TYPES (ЦветПалитры/PaletteColor) → null, а не исключение', () => {
    // ЦветПалитры распознаётся ONE_C_TYPE_NAMES (parseRepositoryUnit успешен), но
    // META_TYPES.PaletteColor.folder не задан (вид без собственной папки выгрузки) —
    // resolveUnitDirRel должен вернуть null, а не упасть на построении пути.
    assert.strictEqual(resolveUnitXmlRel(EXAMPLE_CF, 'ЦветПалитры.Акцент'), null);
  });
});

/**
 * `resolveLockUnitByRelativePath` — раздел 10, Р8: аналог
 * `resolveOwnerFullNameByRelativePath`, но резолвит САМУЮ КОНКРЕТНУЮ единицу
 * (с учётом подчинённых) по пути файла — используется группировкой владельцев
 * рекурсивного корня по единицам (`diffOwnersAgainstBaseline`) и раундами
 * выгрузки. Для файла САМОГО владельца (не внутри подчинённой папки) единица
 * совпадает с владельцем — так же, как `resolveOwnerFullNameByRelativePath`.
 */
suite('RepositoryObjectScope — resolveLockUnitByRelativePath (issue #1, раздел 10, Р8)', () => {
  test('файл владельца (Ext/ObjectModule.bsl) → сама единица-владелец', () => {
    assert.strictEqual(resolveLockUnitByRelativePath('Catalogs/Контрагенты/Ext/ObjectModule.bsl', cfTarget), 'Справочник.Контрагенты');
  });

  test('файл внутри формы → единица формы, а не владелец', () => {
    assert.strictEqual(
      resolveLockUnitByRelativePath('Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form/Module.bsl', cfTarget),
      'Справочник.Контрагенты.Форма.ФормаЭлемента'
    );
  });

  test('сам XML формы → единица формы', () => {
    assert.strictEqual(
      resolveLockUnitByRelativePath('Catalogs/Контрагенты/Forms/ФормаЭлемента.xml', cfTarget),
      'Справочник.Контрагенты.Форма.ФормаЭлемента'
    );
  });

  test('файл внутри Commands (НЕ единица — Command выгружается с владельцем) → владелец', () => {
    assert.strictEqual(
      resolveLockUnitByRelativePath('Catalogs/Контрагенты/Commands/Покупатели/Ext/CommandModule.bsl', cfTarget),
      'Справочник.Контрагенты'
    );
  });

  test('файл дважды вложенной единицы (таблица измерения куба) → полное имя единицы с двумя сегментами', () => {
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
    assert.strictEqual(
      resolveLockUnitByRelativePath('ExternalDataSources/ИнтернетМагазин/Cubes/Продажи/DimensionTables/Товары.xml', target),
      'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары'
    );
  });

  test('файл самого куба (не внутри DimensionTables) → единица куба', () => {
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
    assert.strictEqual(
      resolveLockUnitByRelativePath('ExternalDataSources/ИнтернетМагазин/Cubes/Продажи.xml', target),
      'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи'
    );
  });

  test('Configuration.xml → сентинел корня (как resolveOwnerFullNameByRelativePath)', () => {
    assert.strictEqual(resolveLockUnitByRelativePath('Configuration.xml', cfTarget), getRootLockName(cfTarget));
  });

  test('ConfigDumpInfo.xml → null', () => {
    assert.strictEqual(resolveLockUnitByRelativePath('ConfigDumpInfo.xml', cfTarget), null);
  });

  test('неизвестная папка верхнего уровня → null', () => {
    assert.strictEqual(resolveLockUnitByRelativePath('НеизвестнаяПапка/Файл.xml', cfTarget), null);
  });

  test('путь заканчивается на КАТАЛОГ единицы (не .xml-файл) — имя последнего сегмента не обрезается (stripXmlExtension: ветка без .xml)', () => {
    // Только строковые операции (запрет №11) — resolveUnitSuffixByRelativePath не
    // проверяет существование файла, поэтому «путь к каталогу формы, без имени файла
    // внутри» — легитимный вход, отличный от уже покрытого «путь к самому XML формы».
    assert.strictEqual(
      resolveLockUnitByRelativePath('Catalogs/Контрагенты/Forms/ФормаЭлемента', cfTarget),
      'Справочник.Контрагенты.Форма.ФормаЭлемента'
    );
  });
});

/**
 * `removeEmptyParentDirs` — раздел 10, Р4/Р8: после удаления файла подчинённой
 * единицы освобождает опустевшие промежуточные каталоги (`Forms/`, если из неё
 * убрали последнюю форму), но не трогает каталог, в котором остались другие
 * файлы, и не падает, если каталог уже отсутствует на диске.
 */
suite('RepositoryObjectScope — removeEmptyParentDirs', () => {
  // Область строится для ЕДИНИЦЫ формы (не владельца): область владельца с
  // depth:'unit' исключает Forms/** целиком, а removeEmptyParentDirs здесь
  // вызывается именно для файлов ВНУТРИ уже удалённой единицы (после rmSync
  // самой формы или её содержимого), т.е. по её собственной области.
  function formUnitScope(): Extract<ObjectScope, { kind: 'object' }> {
    return resolveObjectScope(EXAMPLE_CF, 'Справочник.Контрагенты.Форма.ФормаЭлемента', cfTarget, 'unit') as Extract<ObjectScope, { kind: 'object' }>;
  }

  test('каталог после удаления файла остаётся непустым (есть другой файл единицы) — не удаляется, подъём останавливается', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-remove-empty-parent-nonempty-'));
    try {
      const formDir = path.join(baseDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента');
      // Ext/ уже опустел (CommandModule.bsl удалён отдельно, имитация «после rmSync») —
      // подъём должен убрать именно его, но остановиться на ФормаЭлемента/, где
      // остаётся собственный XML формы.
      fs.mkdirSync(path.join(formDir, 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(formDir, 'ФормаЭлемента.xml'), '', 'utf-8');

      removeEmptyParentDirs(baseDir, 'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/CommandModule.bsl', formUnitScope());

      assert.strictEqual(fs.existsSync(formDir), true, 'Каталог с оставшимся файлом единицы не должен удаляться.');
      assert.strictEqual(fs.existsSync(path.join(formDir, 'ФормаЭлемента.xml')), true);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('родительский каталог уже отсутствует на диске — readdirSync бросает, ветка catch отрабатывает без исключения наружу', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-remove-empty-parent-missing-'));
    try {
      // Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext вообще не создавался — readdirSync бросит ENOENT.
      assert.doesNotThrow(() => removeEmptyParentDirs(baseDir, 'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Module.bsl', formUnitScope()));
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
