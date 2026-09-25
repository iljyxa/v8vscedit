import * as assert from 'assert';
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
