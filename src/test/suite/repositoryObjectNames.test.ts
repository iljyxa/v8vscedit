import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { META_TYPES } from '../../domain/MetaTypes';
import {
  ONE_C_TYPE_NAMES,
  convertContentRefToRepositoryFullName,
  parseRepositoryFullName,
  toChildObjectRef,
  dumpInfoOwnerToRepositoryFullName,
  buildRootDumpListName,
  CONFIGURATION_ROOT_LOCK_NAME,
  EXTENSION_ROOT_LOCK_NAME,
  getRootLockName,
  isRootLockName,
  REPOSITORY_SUBORDINATE_LAYOUT,
  isRepositorySubordinateTag,
  parseRepositoryUnit,
  formatRepositoryUnit,
  subordinateUnitFullName,
  getRepositoryUnitAncestors,
  type RepositorySubordinateTag,
} from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';

/**
 * `RepositoryObjectNames` — перенос технической таблицы «MetaKind → русское имя
 * типа хранилища 1С» (`ONE_C_TYPE_NAMES`) и функций перевода между тремя разными
 * «алфавитами» имён объекта, с которыми работает синхронизация хранилища:
 *  - технический fullName хранилища (`Справочник.Товары`, `-Objects`/`-listFile`);
 *  - ссылка ChildObjects/Content подсистемы (`Catalog.Товары`, английский kind);
 *  - «сырое» имя записи ConfigDumpInfo (тот же английский алфавит, что и Content).
 *
 * Таблица параллельна `META_TYPES` — известный технический долг (перенос без
 * изменения поведения, CLAUDE.md «Известные технические долги»), поэтому тест
 * параметризуется по РЕАЛЬНОЙ таблице (`Object.entries(ONE_C_TYPE_NAMES)`), а не по
 * скопированному вручную списку — иначе тест дублировал бы тот же долг ещё раз.
 */

const cfTarget: RepositoryTarget = { configRoot: '/tmp/cf', configKind: 'cf', displayName: 'ТорговыйУчет' };
const cfeTarget: RepositoryTarget = { configRoot: '/tmp/cfe', configKind: 'cfe', extensionName: 'EVOLC', displayName: 'EVOLC' };

suite('RepositoryObjectNames — таблица ONE_C_TYPE_NAMES: round-trip parseRepositoryFullName/toChildObjectRef', () => {
  const entries = Object.entries(ONE_C_TYPE_NAMES) as [keyof typeof META_TYPES, string][];

  test('таблица не пуста (защита от случайно опустошённого переноса)', () => {
    assert.ok(entries.length > 40, `Ожидалось значительное число типов, получено ${String(entries.length)}.`);
  });

  entries.forEach(([kind, ru]) => {
    test(`"${ru}.Тест" → parseRepositoryFullName даёт {kind:"${kind}", name:"Тест"}`, () => {
      assert.deepStrictEqual(parseRepositoryFullName(`${ru}.Тест`), { kind, name: 'Тест' });
    });

    test(`"${ru}.Тест" → toChildObjectRef даёт "${META_TYPES[kind].englishKind ?? kind}.Тест"`, () => {
      const expectedEnglishKind = META_TYPES[kind].englishKind ?? kind;
      assert.strictEqual(toChildObjectRef(`${ru}.Тест`), `${expectedEnglishKind}.Тест`);
    });
  });
});

suite('RepositoryObjectNames — parseRepositoryFullName: граничные случаи', () => {
  test('неизвестный русский префикс → null', () => {
    assert.strictEqual(parseRepositoryFullName('НеизвестныйТип.Имя'), null);
  });

  test('имя без точки → null', () => {
    assert.strictEqual(parseRepositoryFullName('БезТочки'), null);
  });

  test('точка в конце (пустое имя объекта) → null', () => {
    assert.strictEqual(parseRepositoryFullName('Справочник.'), null);
  });

  test('составное имя объекта с точками внутри (Имя.Часть) — тип по первому сегменту, имя — остаток', () => {
    assert.deepStrictEqual(parseRepositoryFullName('Справочник.Контрагенты.Доп'), { kind: 'Catalog', name: 'Контрагенты.Доп' });
  });
});

suite('RepositoryObjectNames — toChildObjectRef: граничные случаи', () => {
  test('неизвестный русский префикс → null', () => {
    assert.strictEqual(toChildObjectRef('НеизвестныйТип.Имя'), null);
  });

  test('имя без точки → null', () => {
    assert.strictEqual(toChildObjectRef('БезТочки'), null);
  });
});

suite('RepositoryObjectNames — convertContentRefToRepositoryFullName', () => {
  test('известный английский префикс переводится в русский технический fullName', () => {
    assert.strictEqual(convertContentRefToRepositoryFullName('Catalog.Товары'), 'Справочник.Товары');
    assert.strictEqual(convertContentRefToRepositoryFullName('Document.ЗаказПокупателя'), 'Документ.ЗаказПокупателя');
  });

  test('неизвестный английский префикс → null', () => {
    assert.strictEqual(convertContentRefToRepositoryFullName('НеизвестныйКлассXDTO.Имя'), null);
  });

  test('ссылка без точки (например «голый» UUID) → null', () => {
    assert.strictEqual(convertContentRefToRepositoryFullName('e3f02c095df5254b82f0f49f44aa5355'), null);
  });

  test('точка на конце (пустое имя) → null', () => {
    assert.strictEqual(convertContentRefToRepositoryFullName('Catalog.'), null);
  });
});

suite('RepositoryObjectNames — dumpInfoOwnerToRepositoryFullName', () => {
  test('обычный объект: английский kind ConfigDumpInfo → русский технический fullName', () => {
    assert.strictEqual(dumpInfoOwnerToRepositoryFullName('Catalog.Контрагенты', cfTarget), 'Справочник.Контрагенты');
    assert.strictEqual(dumpInfoOwnerToRepositoryFullName('Document.Заказ', cfTarget), 'Документ.Заказ');
  });

  test('владелец Configuration.* нормализуется в сентинел корня конфигурации (cf)', () => {
    assert.strictEqual(dumpInfoOwnerToRepositoryFullName('Configuration.ТорговыйУчет', cfTarget), CONFIGURATION_ROOT_LOCK_NAME);
  });

  test('владелец Configuration.* нормализуется в сентинел корня расширения (cfe)', () => {
    assert.strictEqual(dumpInfoOwnerToRepositoryFullName('Configuration.EVOLC', cfeTarget), EXTENSION_ROOT_LOCK_NAME);
  });

  test('неизвестный английский kind → null', () => {
    assert.strictEqual(dumpInfoOwnerToRepositoryFullName('НеизвестныйКласс.Имя', cfTarget), null);
  });

  test('имя без точки → null', () => {
    assert.strictEqual(dumpInfoOwnerToRepositoryFullName('БезТочки', cfTarget), null);
  });
});

suite('RepositoryObjectNames — buildRootDumpListName', () => {
  test('cf: "Конфигурация.<displayName>"', () => {
    assert.strictEqual(buildRootDumpListName(cfTarget), 'Конфигурация.ТорговыйУчет');
  });

  test('cfe: тот же формат "Конфигурация.<displayName>" (см. риск в плане архитектора — требует ручной проверки на реальном Конфигураторе)', () => {
    assert.strictEqual(buildRootDumpListName(cfeTarget), 'Конфигурация.EVOLC');
  });
});

suite('RepositoryObjectNames — getRootLockName/isRootLockName', () => {
  test('cf → CONFIGURATION_ROOT_LOCK_NAME, cfe → EXTENSION_ROOT_LOCK_NAME', () => {
    assert.strictEqual(getRootLockName(cfTarget), CONFIGURATION_ROOT_LOCK_NAME);
    assert.strictEqual(getRootLockName(cfeTarget), EXTENSION_ROOT_LOCK_NAME);
  });

  test('isRootLockName распознаёт оба сентинела и отклоняет обычный fullName', () => {
    assert.strictEqual(isRootLockName(CONFIGURATION_ROOT_LOCK_NAME), true);
    assert.strictEqual(isRootLockName(EXTENSION_ROOT_LOCK_NAME), true);
    assert.strictEqual(isRootLockName('Справочник.Товары'), false);
  });
});

/**
 * Раздел 10 плана: D1 — платформа 1С 8.5.1 (10.12) принимает только
 * `ПараметрФункциональныхОпций`, старое значение `ПараметрФункциональнойОпции`
 * (единственное число) она отбивает. Проверка на реальном объекте выгрузки
 * (`example/2.21/src/cf/FunctionalOptionsParameters/ПараметрФункциональныхОпций.xml`,
 * его собственное `<Name>` совпадает с исправленным русским именем типа —
 * совпадение фикстуры, а не подгонка теста).
 */
suite('RepositoryObjectNames — D1: ONE_C_TYPE_NAMES.FunctionalOptionsParameter (issue #1, раздел 10)', () => {
  const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

  test('исправленное значение — "ПараметрФункциональныхОпций" (множественное число), проверено на платформе', () => {
    assert.strictEqual(ONE_C_TYPE_NAMES.FunctionalOptionsParameter, 'ПараметрФункциональныхОпций');
  });

  test('старое (неверное) значение больше не используется', () => {
    assert.notStrictEqual(ONE_C_TYPE_NAMES.FunctionalOptionsParameter, 'ПараметрФункциональнойОпции');
  });

  test('реальный объект example/2.21: fullName по исправленной таблице резолвится к существующему файлу выгрузки', () => {
    const fullName = `${String(ONE_C_TYPE_NAMES.FunctionalOptionsParameter)}.ПараметрФункциональныхОпций`;
    const parsed = parseRepositoryFullName(fullName);
    assert.deepStrictEqual(parsed, { kind: 'FunctionalOptionsParameter', name: 'ПараметрФункциональныхОпций' });
    const xmlPath = path.join(EXAMPLE_CF, META_TYPES.FunctionalOptionsParameter.folder ?? '', 'ПараметрФункциональныхОпций.xml');
    assert.ok(fs.existsSync(xmlPath), `Ожидался реальный файл выгрузки: ${xmlPath}`);
  });
});

/**
 * Раздел 10, Р2: «Единица хранилища» — объект верхнего уровня ИЛИ подчинённый
 * объект с собственным XML (форма/макет/перерасчёт/таблица/куб/таблица
 * измерения/вложенная подсистема). `REPOSITORY_SUBORDINATE_LAYOUT` — единственная
 * таблица перевода тега подчинённого элемента в папку выгрузки и русское имя типа
 * для `-listFile`/ConfigDumpInfo. Значения проверены попарно с реальной раскладкой
 * `example/2.21/src/cf` (Контрагенты — Forms/Templates, Начисления —
 * Recalculations, ИнтернетМагазин — Tables/Cubes/DimensionTables) и с фактами
 * платформы 10.12 («Имена подчинённых»).
 */
suite('RepositoryObjectNames — REPOSITORY_SUBORDINATE_LAYOUT (issue #1, раздел 10, Р2)', () => {
  const EXPECTED: Readonly<Record<RepositorySubordinateTag, { folder: string; oneCName: string }>> = {
    Form: { folder: 'Forms', oneCName: 'Форма' },
    Template: { folder: 'Templates', oneCName: 'Макет' },
    Recalculation: { folder: 'Recalculations', oneCName: 'Перерасчет' },
    Table: { folder: 'Tables', oneCName: 'Таблица' },
    Cube: { folder: 'Cubes', oneCName: 'Куб' },
    DimensionTable: { folder: 'DimensionTables', oneCName: 'ТаблицаИзмерения' },
    Subsystem: { folder: 'Subsystems', oneCName: 'Подсистема' },
  };

  test('ровно 7 тегов, состав таблицы не содержит Command (выгружается вместе с владельцем)', () => {
    const tags = Object.keys(REPOSITORY_SUBORDINATE_LAYOUT).sort();
    assert.deepStrictEqual(tags, Object.keys(EXPECTED).sort());
    assert.ok(!('Command' in REPOSITORY_SUBORDINATE_LAYOUT));
  });

  (Object.keys(EXPECTED) as RepositorySubordinateTag[]).forEach((tag) => {
    test(`"${tag}" → ${JSON.stringify(EXPECTED[tag])}`, () => {
      assert.deepStrictEqual(REPOSITORY_SUBORDINATE_LAYOUT[tag], EXPECTED[tag]);
    });
  });

  test('Form/Template согласованы с CHILD_TAG_CONFIG.pathSegment (не отдельный литерал русского имени)', () => {
    assert.strictEqual(REPOSITORY_SUBORDINATE_LAYOUT.Form.oneCName, 'Форма');
    assert.strictEqual(REPOSITORY_SUBORDINATE_LAYOUT.Template.oneCName, 'Макет');
  });

  test('Subsystem согласован с ONE_C_TYPE_NAMES.Subsystem и META_TYPES.Subsystem.folder', () => {
    assert.strictEqual(REPOSITORY_SUBORDINATE_LAYOUT.Subsystem.oneCName, ONE_C_TYPE_NAMES.Subsystem);
    assert.strictEqual(REPOSITORY_SUBORDINATE_LAYOUT.Subsystem.folder, META_TYPES.Subsystem.folder);
  });

  test('isRepositorySubordinateTag распознаёт все 7 тегов и отклоняет посторонние теги (Attribute, Command)', () => {
    (Object.keys(EXPECTED) as RepositorySubordinateTag[]).forEach((tag) => {
      assert.strictEqual(isRepositorySubordinateTag(tag), true, `"${tag}" должен распознаваться как тег подчинённого элемента.`);
    });
    assert.strictEqual(isRepositorySubordinateTag('Command'), false);
    assert.strictEqual(isRepositorySubordinateTag('Attribute'), false);
    assert.strictEqual(isRepositorySubordinateTag('НеизвестныйТег'), false);
  });
});

/**
 * Раздел 10, Р2/Р10: грамматика имён единиц в трёх алфавитах — единственное
 * место перевода. Проверено на реальных единицах примера (10.12: «Имена
 * подчинённых» — приняты платформой) плюс D3 (вложенная подсистема
 * `Подсистема.A.Подсистема.B`, а не просто `Подсистема.B`).
 */
suite('RepositoryObjectNames — parseRepositoryUnit/formatRepositoryUnit (issue #1, раздел 10, Р2/Р10)', () => {
  const UNIT_CASES: readonly { label: string; fullName: string; ownerKind: string; segments: readonly [RepositorySubordinateTag, string][] }[] = [
    { label: 'верхнеуровневый объект без подчинённых', fullName: 'Справочник.Контрагенты', ownerKind: 'Catalog', segments: [] },
    { label: 'форма', fullName: 'Справочник.Контрагенты.Форма.ФормаЭлемента', ownerKind: 'Catalog', segments: [['Form', 'ФормаЭлемента']] },
    { label: 'макет', fullName: 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла', ownerKind: 'Catalog', segments: [['Template', 'ЗагрузкаИзФайла']] },
    { label: 'перерасчёт регистра расчёта', fullName: 'РегистрРасчета.Начисления.Перерасчет.Перерасчеты', ownerKind: 'CalculationRegister', segments: [['Recalculation', 'Перерасчеты']] },
    { label: 'таблица внешнего источника данных', fullName: 'ВнешнийИсточникДанных.ИнтернетМагазин.Таблица.Заказы', ownerKind: 'ExternalDataSource', segments: [['Table', 'Заказы']] },
    { label: 'куб внешнего источника данных', fullName: 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи', ownerKind: 'ExternalDataSource', segments: [['Cube', 'Продажи']] },
    {
      label: 'таблица измерения куба (двойная вложенность)',
      fullName: 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары',
      ownerKind: 'ExternalDataSource',
      segments: [['Cube', 'Продажи'], ['DimensionTable', 'Товары']],
    },
    {
      label: 'D3: вложенная подсистема (Подсистема.A.Подсистема.B, а НЕ просто Подсистема.B)',
      fullName: 'Подсистема.Продажи.Подсистема.Розница',
      ownerKind: 'Subsystem',
      segments: [['Subsystem', 'Розница']],
    },
    {
      label: 'D3: дважды вложенная подсистема (Подсистема.A.Подсистема.B.Подсистема.C)',
      fullName: 'Подсистема.Продажи.Подсистема.Розница.Подсистема.Интернет',
      ownerKind: 'Subsystem',
      segments: [['Subsystem', 'Розница'], ['Subsystem', 'Интернет']],
    },
  ];

  UNIT_CASES.forEach(({ label, fullName, ownerKind, segments }) => {
    test(`parseRepositoryUnit: ${label} ("${fullName}")`, () => {
      const unit = parseRepositoryUnit(fullName);
      assert.ok(unit, `"${fullName}" должен разбираться.`);
      assert.strictEqual(unit.kind, ownerKind);
      assert.deepStrictEqual(
        unit.segments.map((s: { tag: RepositorySubordinateTag; name: string }) => [s.tag, s.name]),
        segments
      );
    });

    test(`formatRepositoryUnit — обратное преобразование восстанавливает исходный fullName: "${fullName}"`, () => {
      const unit = parseRepositoryUnit(fullName);
      assert.ok(unit);
      assert.strictEqual(formatRepositoryUnit(unit), fullName);
    });
  });

  test('неизвестный владелец → null', () => {
    assert.strictEqual(parseRepositoryUnit('НеизвестныйТип.Имя'), null);
  });

  test('известный владелец, но неизвестный тег подчинённого сегмента → null', () => {
    assert.strictEqual(parseRepositoryUnit('Справочник.Контрагенты.НеизвестныйТег.Имя'), null);
  });

  test('нечётное число сегментов после владельца (оборванная пара тег/имя) → null', () => {
    assert.strictEqual(parseRepositoryUnit('Справочник.Контрагенты.Форма'), null);
  });

  test('имя без точки → null', () => {
    assert.strictEqual(parseRepositoryUnit('БезТочки'), null);
  });
});

suite('RepositoryObjectNames — subordinateUnitFullName (issue #1, раздел 10, Р2/Р10)', () => {
  test('добавляет один сегмент к верхнеуровневому владельцу (форма)', () => {
    assert.strictEqual(
      subordinateUnitFullName('Справочник.Контрагенты', 'Form', 'ФормаЭлемента'),
      'Справочник.Контрагенты.Форма.ФормаЭлемента'
    );
  });

  test('добавляет сегмент к уже подчинённой единице (таблица измерения куба)', () => {
    assert.strictEqual(
      subordinateUnitFullName('ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи', 'DimensionTable', 'Товары'),
      'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары'
    );
  });

  test('D3: вложенная подсистема называется Подсистема.A.Подсистема.B, а не просто Подсистема.B', () => {
    const result = subordinateUnitFullName('Подсистема.Продажи', 'Subsystem', 'Розница');
    assert.strictEqual(result, 'Подсистема.Продажи.Подсистема.Розница');
    assert.notStrictEqual(result, 'Подсистема.Розница', 'Старое (неверное) поведение resolveSubsystemMemberFullNames — регресс D3.');
  });

  test('родитель не распознан → бросает описательную ошибку (внутренняя ошибка вызывающего кода, не защитная ветка данных пользователя)', () => {
    assert.throws(() => subordinateUnitFullName('НеизвестныйТип.Имя', 'Form', 'X'));
  });
});

suite('RepositoryObjectNames — getRepositoryUnitAncestors (issue #1, раздел 10, Р7/Р9)', () => {
  test('верхнеуровневый объект — предков нет', () => {
    assert.deepStrictEqual(getRepositoryUnitAncestors('Справочник.Контрагенты'), []);
  });

  test('форма — единственный предок: сам владелец', () => {
    assert.deepStrictEqual(
      getRepositoryUnitAncestors('Справочник.Контрагенты.Форма.ФормаЭлемента'),
      ['Справочник.Контрагенты']
    );
  });

  test('таблица измерения куба — предки от ближайшего к владельцу: [куб, владелец]', () => {
    assert.deepStrictEqual(
      getRepositoryUnitAncestors('ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары'),
      ['ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи', 'ВнешнийИсточникДанных.ИнтернетМагазин']
    );
  });

  test('D3: дважды вложенная подсистема — предки [родительская подсистема, корневая подсистема]', () => {
    assert.deepStrictEqual(
      getRepositoryUnitAncestors('Подсистема.Продажи.Подсистема.Розница.Подсистема.Интернет'),
      ['Подсистема.Продажи.Подсистема.Розница', 'Подсистема.Продажи']
    );
  });

  test('нераспознанное имя → пустой список (защитная ветка — не должно ронять вызывающий код)', () => {
    assert.deepStrictEqual(getRepositoryUnitAncestors('НеизвестныйТип.Имя'), []);
  });
});

/**
 * Р5: root-incremental по единицам — `dumpInfoOwnerToRepositoryFullName` должен
 * уметь переводить владельца ConfigDumpInfo, являющегося ПОДЧИНЁННОЙ единицей
 * (`Catalog.Контрагенты.Form.ФормаЭлемента`), а не только верхнеуровневым
 * объектом. Неизвестный тег подчинённого → единица-родитель (Р5: «неизвестный
 * тег подчинённого → единица-родитель»).
 */
suite('RepositoryObjectNames — dumpInfoOwnerToRepositoryFullName: единицы (issue #1, раздел 10, Р5)', () => {
  test('владелец ConfigDumpInfo — подчинённая единица (форма) → полное имя единицы хранилища', () => {
    assert.strictEqual(
      dumpInfoOwnerToRepositoryFullName('Catalog.Контрагенты.Form.ФормаЭлемента', cfTarget),
      'Справочник.Контрагенты.Форма.ФормаЭлемента'
    );
  });

  test('владелец ConfigDumpInfo — таблица измерения куба (двойная вложенность)', () => {
    assert.strictEqual(
      dumpInfoOwnerToRepositoryFullName('ExternalDataSource.ИнтернетМагазин.Cube.Продажи.DimensionTable.Товары', cfTarget),
      'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары'
    );
  });

  test('D3: владелец ConfigDumpInfo — вложенная подсистема (Subsystem.A.Subsystem.B)', () => {
    assert.strictEqual(
      dumpInfoOwnerToRepositoryFullName('Subsystem.Продажи.Subsystem.Розница', cfTarget),
      'Подсистема.Продажи.Подсистема.Розница'
    );
  });

  test('неизвестный тег подчинённого сегмента → откатывается к единице-родителю (владельцу верхнего уровня)', () => {
    assert.strictEqual(
      dumpInfoOwnerToRepositoryFullName('Catalog.Контрагенты.НеизвестныйТег.X', cfTarget),
      'Справочник.Контрагенты'
    );
  });
});
