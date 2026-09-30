import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SupportInfoService, SupportMode } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import {
  fixtureUuid,
  writeConfigurationXml,
  writeObjectXml,
  writeBslFile,
  writeParentConfigurationsBin,
  SUPPORT_BIN_CODE,
  type ObjectXmlLayout,
  MALFORMED_BIN_CASES,
  buildSupportFixtureRoot,
} from './support/flatMetadataFixtures';
import { skipWithoutCorpus } from './support/corpus';

class TestLogger implements Logger {
  readonly messages: string[] = [];

  appendLine(message: string): void {
    this.messages.push(message);
  }
}

/** Создаёт временный каталог конфигурации, вызывает fn и гарантированно чистит его. */
function withConfigRoot(fn: (configRoot: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-'));
  const configRoot = path.join(tempDir, 'cf');
  try {
    fn(configRoot);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.20/src/cf');

suite('SupportInfoService', () => {
  // `example/` не отслеживается git — без корпуса сьют пропускается, а не падает
  // (единый гейт: support/corpus.ts).
  suiteSetup(function () {
    skipWithoutCorpus(this);
  });

  test('Трактует код 1 из ParentConfigurations.bin как редактирование с сохранением поддержки', function () {
    // Тест требует наличия ParentConfigurations.bin в example/. В минимальной
    // выгрузке без поддержки бинарника нет — тогда тест неприменим, а сервис
    // корректно возвращает None для любого пути (это покрывают другие тесты).
    const binPath = path.join(EXAMPLE_CF, 'Ext', 'ParentConfigurations.bin');
    if (!fs.existsSync(binPath)) {
      this.skip();
    }
    const service = new SupportInfoService(new TestLogger());
    const configurationXml = path.join(EXAMPLE_CF, 'Configuration.xml');

    service.loadConfig(EXAMPLE_CF);

    assert.strictEqual(service.getSupportMode(configurationXml), SupportMode.Editable);
    assert.strictEqual(service.isLocked(configurationXml), false);
  });
});


/**
 * `SupportInfoService.resolveObjectXmlForBsl` раньше искал XML
 * объекта только в глубокой раскладке (`<Тип>/<Имя>/<Имя>.xml`), поэтому
 * плоская выгрузка (`<Тип>/<Имя>.xml`) и общие модули без вложенного XML не
 * давали режим поддержки — платформа 1С кладёт `Ext/<Модуль>.bsl` рядом с
 * объектом даже когда сам XML объекта лежит плоско на уровень выше.
 *
 * Фикстуры — временные каталоги (`fs.mkdtempSync`) с минимальными XML,
 * синтезированными через `support/flatMetadataFixtures.ts`; `example/` не
 * используется. Параметр — код файла `a` (см. `SUPPORT_BIN_CODE`), а не
 * домен-режим: `SupportInfoService` транслирует 0→Locked, 1→Editable,
 * 2→None.
 */
suite('SupportInfoService — плоская и вложенная раскладка XML объекта', () => {
  const layouts: ObjectXmlLayout[] = ['flat', 'deep'];
  const codeCases: { code: number; codeLabel: string; expectedMode: SupportMode; modeLabel: string }[] = [
    { code: SUPPORT_BIN_CODE.locked, codeLabel: 'a=0 (locked)', expectedMode: SupportMode.Locked, modeLabel: 'Locked' },
    { code: SUPPORT_BIN_CODE.editable, codeLabel: 'a=1 (editable)', expectedMode: SupportMode.Editable, modeLabel: 'Editable' },
    { code: SUPPORT_BIN_CODE.removed, codeLabel: 'a=2 (removed)', expectedMode: SupportMode.None, modeLabel: 'None' },
  ];

  for (const layout of layouts) {
    for (const { code, codeLabel, expectedMode, modeLabel } of codeCases) {
      test(`CommonModules/X/Ext/Module.bsl: раскладка объекта ${layout}, код файла ${codeLabel} → ${modeLabel}`, () => {
        withConfigRoot((configRoot) => {
          const configUuid = fixtureUuid(`config-${layout}-${modeLabel}`);
          const moduleUuid = fixtureUuid(`module-${layout}-${modeLabel}`);
          writeConfigurationXml(configRoot, configUuid);
          writeObjectXml(configRoot, 'CommonModules', 'ОбщийМодуль1', 'CommonModule', moduleUuid, layout);
          const bslPath = writeBslFile(path.join(configRoot, 'CommonModules', 'ОбщийМодуль1', 'Ext', 'Module.bsl'));
          writeParentConfigurationsBin(configRoot, new Map([[moduleUuid, code]]));

          const logger = new TestLogger();
          const service = new SupportInfoService(logger);
          service.loadConfig(configRoot);

          assert.strictEqual(service.getSupportMode(bslPath), expectedMode);
          assert.strictEqual(service.isLocked(bslPath), expectedMode === SupportMode.Locked);
          assert.ok(
            !logger.messages.some((m) => /не существует|не найден/.test(m)),
            `Не ожидались ошибки резолвинга XML в логе: ${JSON.stringify(logger.messages)}`
          );
        });
      });
    }
  }

  test('модуль формы: при наличии собственного XML формы с отличным от владельца режимом → режим формы', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-form-own');
      const ownerUuid = fixtureUuid('owner-form-own');
      const formUuid = fixtureUuid('form-form-own');
      writeConfigurationXml(configRoot, configUuid);
      writeObjectXml(configRoot, 'Catalogs', 'Каталог1', 'Catalog', ownerUuid, 'deep');
      // Форма объекта — собственный XML лежит в <owner>/Forms/<Форма>.xml
      // (это существующий формат, не связанный с deep/flat владельца).
      fs.mkdirSync(path.join(configRoot, 'Catalogs', 'Каталог1', 'Forms'), { recursive: true });
      fs.writeFileSync(
        path.join(configRoot, 'Catalogs', 'Каталог1', 'Forms', 'Форма1.xml'),
        // BOM через String.fromCharCode — без литерального невидимого символа в исходнике.
        `${String.fromCharCode(0xfeff)}<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Form uuid="${formUuid}"><Properties><Name>Форма1</Name></Properties></Form></MetaDataObject>`,
        'utf-8'
      );
      const bslPath = writeBslFile(
        path.join(configRoot, 'Catalogs', 'Каталог1', 'Forms', 'Форма1', 'Ext', 'Form', 'Module.bsl')
      );
      writeParentConfigurationsBin(configRoot, new Map([
        [ownerUuid, SUPPORT_BIN_CODE.editable],
        [formUuid, SUPPORT_BIN_CODE.locked],
      ]));

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(bslPath), SupportMode.Locked);
    });
  });

  test('модуль формы: без собственного XML формы → используется режим владельца объекта', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-form-owner-fallback');
      const ownerUuid = fixtureUuid('owner-form-owner-fallback');
      writeConfigurationXml(configRoot, configUuid);
      writeObjectXml(configRoot, 'Catalogs', 'Каталог2', 'Catalog', ownerUuid, 'flat');
      // Форма.xml намеренно не создаётся — только модуль формы на диске.
      const bslPath = writeBslFile(
        path.join(configRoot, 'Catalogs', 'Каталог2', 'Forms', 'Форма1', 'Ext', 'Form', 'Module.bsl')
      );
      writeParentConfigurationsBin(configRoot, new Map([[ownerUuid, SUPPORT_BIN_CODE.locked]]));

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(bslPath), SupportMode.Locked);
    });
  });

  test('шаблон: без собственного XML шаблона → используется режим владельца объекта', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-template-owner-fallback');
      const ownerUuid = fixtureUuid('owner-template-owner-fallback');
      writeConfigurationXml(configRoot, configUuid);
      writeObjectXml(configRoot, 'Catalogs', 'Каталог3', 'Catalog', ownerUuid, 'deep');
      // Templates/<Имя>.xml намеренно не создаётся.
      const bslPath = writeBslFile(
        path.join(configRoot, 'Catalogs', 'Каталог3', 'Templates', 'Шаблон1', 'Ext', 'Template.bsl')
      );
      writeParentConfigurationsBin(configRoot, new Map([[ownerUuid, SUPPORT_BIN_CODE.locked]]));

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(bslPath), SupportMode.Locked);
    });
  });

  test('команда объекта: Commands больше не ищет собственный XML — всегда режим владельца', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-command-owner');
      const ownerUuid = fixtureUuid('owner-command-owner');
      writeConfigurationXml(configRoot, configUuid);
      writeObjectXml(configRoot, 'Catalogs', 'Каталог4', 'Catalog', ownerUuid, 'flat');
      // Commands/<Имя>.xml намеренно не создаётся — у команды объекта нет
      // собственного XML в этой раскладке, режим определяется владельцем.
      const bslPath = writeBslFile(
        path.join(configRoot, 'Catalogs', 'Каталог4', 'Commands', 'Команда1', 'Ext', 'CommandModule.bsl')
      );
      writeParentConfigurationsBin(configRoot, new Map([[ownerUuid, SUPPORT_BIN_CODE.locked]]));

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(bslPath), SupportMode.Locked);
    });
  });

  test('нет XML объекта вовсе → None и лог с «не найден»', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-missing-object');
      writeConfigurationXml(configRoot, configUuid);
      fs.mkdirSync(path.join(configRoot, 'CommonModules'), { recursive: true });
      const bslPath = writeBslFile(
        path.join(configRoot, 'CommonModules', 'НетТакогоМодуля', 'Ext', 'Module.bsl')
      );
      // ParentConfigurations.bin нужен, чтобы конфигурация вообще попала в
      // кэш сервиса (loadConfig без .bin пропускает регистрацию корня).
      writeParentConfigurationsBin(configRoot, new Map());

      const logger = new TestLogger();
      const service = new SupportInfoService(logger);
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(bslPath), SupportMode.None);
      assert.ok(
        logger.messages.some((m) => m.includes('не найден')),
        `Ожидалась строка лога с «не найден»: ${JSON.stringify(logger.messages)}`
      );
    });
  });

  test('неизвестная папка без XML объекта → None (функция резолвинга не завязана на реестр типов)', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-unknown-folder-missing');
      writeConfigurationXml(configRoot, configUuid);
      fs.mkdirSync(path.join(configRoot, 'Foo'), { recursive: true });
      const bslPath = writeBslFile(path.join(configRoot, 'Foo', 'X', 'Ext', 'Module.bsl'));
      writeParentConfigurationsBin(configRoot, new Map());

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(bslPath), SupportMode.None);
    });
  });

  test('неизвестная папка с плоским XML объекта → режим по uuid (функция резолвинга не завязана на реестр типов)', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-unknown-folder-flat');
      const objectUuid = fixtureUuid('object-unknown-folder-flat');
      writeConfigurationXml(configRoot, configUuid);
      writeObjectXml(configRoot, 'Foo', 'X', 'Catalog', objectUuid, 'flat');
      const bslPath = writeBslFile(path.join(configRoot, 'Foo', 'X', 'Ext', 'Module.bsl'));
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.locked]]));

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(bslPath), SupportMode.Locked);
    });
  });

  test('путь без Ext-сегмента → None и лог «не удалось определить XML»', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-no-ext-segment');
      const moduleUuid = fixtureUuid('module-no-ext-segment');
      writeConfigurationXml(configRoot, configUuid);
      writeObjectXml(configRoot, 'CommonModules', 'ОбщийБезExt', 'CommonModule', moduleUuid, 'deep');
      // Модуль лежит прямо в каталоге объекта, минуя Ext/ — платформа так
      // никогда не выгружает, но резолвер должен не найти сегмент 'ext'.
      const bslPath = writeBslFile(path.join(configRoot, 'CommonModules', 'ОбщийБезExt', 'Module.bsl'));
      writeParentConfigurationsBin(configRoot, new Map([[moduleUuid, SUPPORT_BIN_CODE.locked]]));

      const logger = new TestLogger();
      const service = new SupportInfoService(logger);
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(bslPath), SupportMode.None);
      assert.ok(
        logger.messages.some((m) => m.includes('не удалось определить XML')),
        `Ожидалась строка лога «не удалось определить XML»: ${JSON.stringify(logger.messages)}`
      );
    });
  });

  test('BSL вне корня конфигурации → None', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('config-outside-bsl');
      writeConfigurationXml(configRoot, configUuid);
      writeParentConfigurationsBin(configRoot, new Map());

      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-outside-'));
      try {
        const bslPath = writeBslFile(path.join(outsideDir, 'CommonModules', 'X', 'Ext', 'Module.bsl'));

        const service = new SupportInfoService(new TestLogger());
        service.loadConfig(configRoot);

        assert.strictEqual(service.getSupportMode(bslPath), SupportMode.None);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Параметризация по флагу «изменения запрещены» для двух веток, где uuid/XML
 * не резолвятся штатно: при выставленном флаге путь всё равно обязан
 * получить Locked (см. общий контракт выше), при снятом — прежнее поведение.
 */
suite('SupportInfoService — changesForbidden переопределяет отсутствие данных', () => {
  const flags: boolean[] = [false, true];

  for (const changesForbidden of flags) {
    const expectedMode = changesForbidden ? SupportMode.Locked : SupportMode.None;
    const expectedLabel = changesForbidden ? 'Locked' : 'None';

    test(`uuid объекта отсутствует в списке поставки, changesForbidden=${String(changesForbidden)} → ${expectedLabel}`, () => {
      withConfigRoot((configRoot) => {
        const configUuid = fixtureUuid(`cf-not-listed-${String(changesForbidden)}`);
        const objectUuid = fixtureUuid(`obj-not-listed-${String(changesForbidden)}`);
        writeConfigurationXml(configRoot, configUuid);
        const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
        // Записей нет вовсе — объект не значится в поставке.
        writeParentConfigurationsBin(configRoot, new Map(), { changesForbidden });

        const service = new SupportInfoService(new TestLogger());
        service.loadConfig(configRoot);

        assert.strictEqual(service.getSupportMode(xmlPath), expectedMode);
      });
    });

    test(`XML объекта-владельца BSL-модуля не найден, changesForbidden=${String(changesForbidden)} → ${expectedLabel}`, () => {
      withConfigRoot((configRoot) => {
        const configUuid = fixtureUuid(`cf-no-owner-${String(changesForbidden)}`);
        writeConfigurationXml(configRoot, configUuid);
        fs.mkdirSync(path.join(configRoot, 'CommonModules'), { recursive: true });
        const bslPath = writeBslFile(
          path.join(configRoot, 'CommonModules', 'НетТакогоМодуля', 'Ext', 'Module.bsl')
        );
        writeParentConfigurationsBin(configRoot, new Map(), { changesForbidden });

        const service = new SupportInfoService(new TestLogger());
        service.loadConfig(configRoot);

        assert.strictEqual(service.getSupportMode(bslPath), expectedMode);
      });
    });
  }
});

suite('SupportInfoService — нераспознанный ParentConfigurations.bin', () => {
  for (const { label, text } of MALFORMED_BIN_CASES) {
    test(`${label} → hasConfigData=false, getSupportMode=None, лог «не распознан»`, () => {
      withConfigRoot((configRoot) => {
        const configUuid = fixtureUuid(`malformed-${label}`);
        writeConfigurationXml(configRoot, configUuid);
        fs.mkdirSync(path.join(configRoot, 'Ext'), { recursive: true });
        fs.writeFileSync(path.join(configRoot, 'Ext', 'ParentConfigurations.bin'), text, 'utf-8');

        const logger = new TestLogger();
        const service = new SupportInfoService(logger);
        service.loadConfig(configRoot);

        const configXmlPath = path.join(configRoot, 'Configuration.xml');
        assert.strictEqual(service.hasConfigData(configXmlPath), false);
        assert.strictEqual(service.getSupportMode(configXmlPath), SupportMode.None);
        assert.ok(
          logger.messages.some((m) => m.includes('не распознан')),
          `Ожидалась строка лога «не распознан»: ${JSON.stringify(logger.messages)}`
        );
      });
    });
  }
});

suite('SupportInfoService — переходы кэша при перезаписи .bin', () => {
  test('валидный → перезаписан мусором → loadConfig → hasConfigData=false', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('cache-valid-to-garbage');
      const objectUuid = fixtureUuid('cache-valid-to-garbage-object');
      writeConfigurationXml(configRoot, configUuid);
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]));

      const logger = new TestLogger();
      const service = new SupportInfoService(logger);
      service.loadConfig(configRoot);
      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Editable);
      assert.strictEqual(service.hasConfigData(xmlPath), true);

      fs.writeFileSync(path.join(configRoot, 'Ext', 'ParentConfigurations.bin'), 'мусор', 'utf-8');
      service.loadConfig(configRoot);

      assert.strictEqual(service.hasConfigData(xmlPath), false);
      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.None);
    });
  });

  test('флаг запрета 0 → 1 (перезапись с теми же записями) → режимы становятся Locked', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('cache-flag-0-to-1');
      const objectUuid = fixtureUuid('cache-flag-0-to-1-object');
      writeConfigurationXml(configRoot, configUuid);
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]), {
        changesForbidden: false,
      });

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);
      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Editable);

      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]), {
        changesForbidden: true,
      });
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Locked);
    });
  });
});

suite('SupportInfoService — повторный loadConfig без изменения файла', () => {
  test('hash не изменился → кэш переиспользуется, лог «кэш актуален», режим не меняется', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('cache-unchanged-config');
      const objectUuid = fixtureUuid('cache-unchanged-object');
      writeConfigurationXml(configRoot, configUuid);
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]));

      const logger = new TestLogger();
      const service = new SupportInfoService(logger);
      service.loadConfig(configRoot);
      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Editable);

      logger.messages.length = 0;
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Editable);
      assert.ok(
        logger.messages.some((m) => m.includes('кэш актуален')),
        `Ожидалась строка лога «кэш актуален»: ${JSON.stringify(logger.messages)}`
      );
    });
  });
});

suite('SupportInfoService — неизвестный код режима', () => {
  test('код a=7 (не 0/1/2) → Locked, лог «неизвестный код: 1»', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('unknown-code-config');
      const objectUuid = fixtureUuid('unknown-code-object');
      writeConfigurationXml(configRoot, configUuid);
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, 7]]));

      const logger = new TestLogger();
      const service = new SupportInfoService(logger);
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Locked);
      assert.ok(
        logger.messages.some((m) => m.includes('неизвестный код: 1')),
        `Ожидалась строка лога «неизвестный код: 1»: ${JSON.stringify(logger.messages)}`
      );
    });
  });
});

suite('SupportInfoService — рассинхронизация заявленного и фактического числа записей', () => {
  test('объявлено 3, разобрано 2 → лог «объявлено 3, разобрано 2»', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('declared-mismatch-config');
      const uuidA = fixtureUuid('declared-mismatch-a');
      const uuidB = fixtureUuid('declared-mismatch-b');
      writeConfigurationXml(configRoot, configUuid);
      writeParentConfigurationsBin(
        configRoot,
        new Map([
          [uuidA, SUPPORT_BIN_CODE.locked],
          [uuidB, SUPPORT_BIN_CODE.editable],
        ]),
        { declaredCount: 3 }
      );

      const logger = new TestLogger();
      const service = new SupportInfoService(logger);
      service.loadConfig(configRoot);

      assert.ok(
        logger.messages.some((m) => m.includes('объявлено 3, разобрано 2')),
        `Ожидалась строка лога «объявлено 3, разобрано 2»: ${JSON.stringify(logger.messages)}`
      );
    });
  });
});

/**
 * Несколько поставщиков — одна и та же запись объекта встречается в `.bin`
 * несколько раз (по разу на поставщика) с разными кодами. Итоговый домен-режим
 * — самый строгий среди них: Locked > Editable > None.
 */
suite('SupportInfoService — несколько поставщиков (дубли uuid)', () => {
  test('коды (editable, затем locked) → итог Locked, лог «поставщиков: 2»', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('multi-vendor-1-config');
      const objectUuid = fixtureUuid('multi-vendor-1-object');
      writeConfigurationXml(configRoot, configUuid);
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]), {
        vendorCount: 2,
        extraRecords: [[SUPPORT_BIN_CODE.locked, objectUuid]],
      });

      const logger = new TestLogger();
      const service = new SupportInfoService(logger);
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Locked);
      assert.ok(
        logger.messages.some((m) => m.includes('поставщиков: 2')),
        `Ожидалась строка лога «поставщиков: 2»: ${JSON.stringify(logger.messages)}`
      );
    });
  });

  test('коды (removed, затем editable) → итог Editable', () => {
    withConfigRoot((configRoot) => {
      const configUuid = fixtureUuid('multi-vendor-2-config');
      const objectUuid = fixtureUuid('multi-vendor-2-object');
      writeConfigurationXml(configRoot, configUuid);
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.removed]]), {
        vendorCount: 2,
        extraRecords: [[SUPPORT_BIN_CODE.editable, objectUuid]],
      });

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);

      assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Editable);
    });
  });
});

suite('SupportInfoService — BOM в ParentConfigurations.bin', () => {
  for (const bom of [true, false]) {
    test(`${bom ? 'с BOM' : 'без BOM'} → Editable`, () => {
      withConfigRoot((configRoot) => {
        const configUuid = fixtureUuid(`bom-${String(bom)}`);
        const configurationXml = writeConfigurationXml(configRoot, configUuid);
        writeParentConfigurationsBin(configRoot, new Map([[configUuid, SUPPORT_BIN_CODE.editable]]), { bom });

        const service = new SupportInfoService(new TestLogger());
        service.loadConfig(configRoot);

        assert.strictEqual(service.getSupportMode(configurationXml), SupportMode.Editable);
      });
    });
  }
});

/**
 * При флаге «изменения запрещены» `getSupportMode` по-прежнему
 * возвращает `Locked` для ЛЮБОГО файла (это не меняется — см. suite выше), но
 * UI обязан различать ПРИЧИНУ блокировки (объект реально на поддержке vs вся
 * конфигурация закрыта флагом настроек поддержки). `hasChangesForbidden` —
 * новый метод-предикат именно для этой причины, независимый от резолвинга
 * uuid/XML-владельца: при установленном флаге результат `true` для ЛЮБОГО
 * пути под корнем конфигурации, включая несуществующие файлы и BSL-модули без
 * найденного владельца (симметрично с `getSupportMode`, который в этом случае
 * тоже не пытается резолвить XML).
 */
suite('SupportInfoService — hasChangesForbidden', () => {
  test('forbidden: Configuration.xml, объекты трёх разных кодов, BSL без владельца, несуществующий путь под корнем → true', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(fixture.configRoot);

      assert.strictEqual(service.hasChangesForbidden(fixture.configurationXmlPath), true);
      assert.strictEqual(service.hasChangesForbidden(fixture.kontragentyXmlPath), true, 'Контрагенты (a=2 вне запрета)');
      assert.strictEqual(service.hasChangesForbidden(fixture.avansovyOtchetXmlPath), true, 'АвансовыйОтчет… (a=0 вне запрета)');
      assert.strictEqual(service.hasChangesForbidden(fixture.prihodTovaraXmlPath), true, 'ПриходТовара (a=1 вне запрета)');

      const bslPath = writeBslFile(path.join(fixture.configRoot, 'CommonModules', 'Нет', 'Ext', 'Module.bsl'));
      assert.strictEqual(service.hasChangesForbidden(bslPath), true, 'BSL без владельца');

      const missingXmlPath = path.join(fixture.configRoot, 'Catalogs', 'НеСуществующийСправочник.xml');
      assert.strictEqual(service.hasChangesForbidden(missingXmlPath), true, 'несуществующий путь под корнем');
    } finally {
      fixture.dispose();
    }
  });

  test('normal: те же пути → false', () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(fixture.configRoot);

      assert.strictEqual(service.hasChangesForbidden(fixture.configurationXmlPath), false);
      assert.strictEqual(service.hasChangesForbidden(fixture.kontragentyXmlPath), false);
      assert.strictEqual(service.hasChangesForbidden(fixture.avansovyOtchetXmlPath), false);
      assert.strictEqual(service.hasChangesForbidden(fixture.prihodTovaraXmlPath), false);

      const bslPath = writeBslFile(path.join(fixture.configRoot, 'CommonModules', 'Нет', 'Ext', 'Module.bsl'));
      assert.strictEqual(service.hasChangesForbidden(bslPath), false);

      const missingXmlPath = path.join(fixture.configRoot, 'Catalogs', 'НеСуществующийСправочник.xml');
      assert.strictEqual(service.hasChangesForbidden(missingXmlPath), false);
    } finally {
      fixture.dispose();
    }
  });

  test('путь вне корня конфигурации → false, даже если сама конфигурация с флагом запрета', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-forbidden-outside-'));
    try {
      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(fixture.configRoot);

      const outsidePath = writeBslFile(path.join(outsideDir, 'CommonModules', 'X', 'Ext', 'Module.bsl'));
      assert.strictEqual(service.hasChangesForbidden(outsidePath), false);
    } finally {
      fixture.dispose();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('конфигурация без ParentConfigurations.bin → false', () => {
    withConfigRoot((configRoot) => {
      writeConfigurationXml(configRoot, fixtureUuid('has-changes-forbidden-no-bin'));

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);

      assert.strictEqual(service.hasChangesForbidden(path.join(configRoot, 'Configuration.xml')), false);
    });
  });

  for (const { label, text } of MALFORMED_BIN_CASES) {
    test(`нераспознанный ParentConfigurations.bin (${label}) → false`, () => {
      withConfigRoot((configRoot) => {
        writeConfigurationXml(configRoot, fixtureUuid(`has-changes-forbidden-malformed-${label}`));
        fs.mkdirSync(path.join(configRoot, 'Ext'), { recursive: true });
        fs.writeFileSync(path.join(configRoot, 'Ext', 'ParentConfigurations.bin'), text, 'utf-8');

        const service = new SupportInfoService(new TestLogger());
        service.loadConfig(configRoot);

        assert.strictEqual(service.hasChangesForbidden(path.join(configRoot, 'Configuration.xml')), false);
      });
    });
  }

  test('invalidate сбрасывает флаг запрета изменений в false', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(fixture.configRoot);
      assert.strictEqual(service.hasChangesForbidden(fixture.configurationXmlPath), true);

      service.invalidate(fixture.configRoot);

      assert.strictEqual(service.hasChangesForbidden(fixture.configurationXmlPath), false);
    } finally {
      fixture.dispose();
    }
  });

  test('переход 0 → 1: перезапись .bin с выставленным флагом делает hasChangesForbidden true', () => {
    withConfigRoot((configRoot) => {
      const objectUuid = fixtureUuid('has-changes-forbidden-0-to-1-object');
      writeConfigurationXml(configRoot, fixtureUuid('has-changes-forbidden-0-to-1-config'));
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]), {
        changesForbidden: false,
      });

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);
      assert.strictEqual(service.hasChangesForbidden(xmlPath), false);

      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]), {
        changesForbidden: true,
      });
      service.loadConfig(configRoot);

      assert.strictEqual(service.hasChangesForbidden(xmlPath), true);
    });
  });

  test('переход 1 → 0: перезапись .bin со снятым флагом делает hasChangesForbidden false', () => {
    withConfigRoot((configRoot) => {
      const objectUuid = fixtureUuid('has-changes-forbidden-1-to-0-object');
      writeConfigurationXml(configRoot, fixtureUuid('has-changes-forbidden-1-to-0-config'));
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Об1', 'Catalog', objectUuid, 'flat');
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]), {
        changesForbidden: true,
      });

      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);
      assert.strictEqual(service.hasChangesForbidden(xmlPath), true);

      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SUPPORT_BIN_CODE.editable]]), {
        changesForbidden: false,
      });
      service.loadConfig(configRoot);

      assert.strictEqual(service.hasChangesForbidden(xmlPath), false);
    });
  });

  test('регрессия: hasConfigData не зависит от hasChangesForbidden — true и при forbidden, и при normal, false без .bin', () => {
    const forbidden = buildSupportFixtureRoot('forbidden');
    const normal = buildSupportFixtureRoot('normal');
    try {
      const serviceForbidden = new SupportInfoService(new TestLogger());
      serviceForbidden.loadConfig(forbidden.configRoot);
      assert.strictEqual(serviceForbidden.hasConfigData(forbidden.configurationXmlPath), true);

      const serviceNormal = new SupportInfoService(new TestLogger());
      serviceNormal.loadConfig(normal.configRoot);
      assert.strictEqual(serviceNormal.hasConfigData(normal.configurationXmlPath), true);
    } finally {
      forbidden.dispose();
      normal.dispose();
    }

    withConfigRoot((configRoot) => {
      writeConfigurationXml(configRoot, fixtureUuid('has-config-data-no-bin'));
      const service = new SupportInfoService(new TestLogger());
      service.loadConfig(configRoot);
      assert.strictEqual(service.hasConfigData(path.join(configRoot, 'Configuration.xml')), false);
    });
  });
});
