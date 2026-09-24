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
} from './support/flatMetadataFixtures';
import {
  EXAMPLE_CF_ROOTS,
  CHANGES_FORBIDDEN_BIN_PATH,
  MALFORMED_BIN_CASES,
  firstAttributeUuid,
} from './support/realConfigFixtures';

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

suite('SupportInfoService', () => {
  test('Трактует код 1 из ParentConfigurations.bin как редактирование с сохранением поддержки', () => {
    const configRoot = EXAMPLE_CF_ROOTS['2.20'];
    const service = new SupportInfoService(new TestLogger());
    const configurationXml = path.join(configRoot, 'Configuration.xml');

    service.loadConfig(configRoot);

    assert.strictEqual(service.getSupportMode(configurationXml), SupportMode.Editable);
    assert.strictEqual(service.isLocked(configurationXml), false);
  });
});

/**
 * Реальная выгрузка `example/2.20` и `example/2.21` — одна и та же поставка
 * (`example/tools/support-rules.json`): Configuration, Document.ПриходТовара,
 * AccumulationRegister.ТоварыНаСкладах — editable (код `a`=1); Catalog.Контрагенты
 * — снят с поддержки (код `a`=2 → SupportMode.None); всё остальное — locked
 * (код `a`=0), включая последнюю запись файла (IntegrationServices/
 * СервисИнтеграции1) — регрессия «последней записи», которую старая реализация
 * не находила вовсе (искала совпадение до конца файла без учёта хвоста).
 */
suite('SupportInfoService — реальная фикстура (228 записей одной поставки)', () => {
  const versions: ('2.20' | '2.21')[] = ['2.20', '2.21'];

  for (const version of versions) {
    const configRoot = EXAMPLE_CF_ROOTS[version];

    suite(`example/${version}/src/cf`, () => {
      let service: SupportInfoService;
      let logger: TestLogger;

      setup(() => {
        logger = new TestLogger();
        service = new SupportInfoService(logger);
        service.loadConfig(configRoot);
      });

      const editableCases: { label: string; relPath: string[] }[] = [
        { label: 'Configuration.xml', relPath: ['Configuration.xml'] },
        { label: 'Documents/ПриходТовара.xml', relPath: ['Documents', 'ПриходТовара.xml'] },
        { label: 'AccumulationRegisters/ТоварыНаСкладах.xml', relPath: ['AccumulationRegisters', 'ТоварыНаСкладах.xml'] },
      ];
      for (const { label, relPath } of editableCases) {
        test(`${label} → Editable`, () => {
          const xmlPath = path.join(configRoot, ...relPath);
          assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Editable);
          assert.strictEqual(service.isLocked(xmlPath), false);
        });
      }

      test('Catalogs/Контрагенты.xml → None (снят с поддержки), isLocked=false', () => {
        const xmlPath = path.join(configRoot, 'Catalogs', 'Контрагенты.xml');
        assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.None);
        assert.strictEqual(service.isLocked(xmlPath), false);
      });

      test('Catalogs/Номенклатура.xml → Locked', () => {
        const xmlPath = path.join(configRoot, 'Catalogs', 'Номенклатура.xml');
        assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Locked);
        assert.strictEqual(service.isLocked(xmlPath), true);
      });

      test('IntegrationServices/СервисИнтеграции1.xml → Locked (регрессия последней записи файла)', () => {
        const xmlPath = path.join(configRoot, 'IntegrationServices', 'СервисИнтеграции1.xml');
        assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Locked);
        assert.strictEqual(service.isLocked(xmlPath), true);
      });

      test('hasConfigData → true', () => {
        assert.strictEqual(service.hasConfigData(path.join(configRoot, 'Configuration.xml')), true);
      });

      test('getSupportModeByUuid для uuid реквизита ПриходТовара (не владельца) → Editable', () => {
        const documentXmlPath = path.join(configRoot, 'Documents', 'ПриходТовара.xml');
        const attributeUuid = firstAttributeUuid(documentXmlPath);
        assert.strictEqual(service.getSupportModeByUuid(documentXmlPath, attributeUuid), SupportMode.Editable);
      });

      test('getSupportModeByUuid для случайного uuid → None', () => {
        const documentXmlPath = path.join(configRoot, 'Documents', 'ПриходТовара.xml');
        const randomUuid = fixtureUuid(`not-in-real-fixture-${version}`);
        assert.strictEqual(service.getSupportModeByUuid(documentXmlPath, randomUuid), SupportMode.None);
      });

      test('BSL-модуль владельца (Catalogs/Контрагенты/Ext/ObjectModule.bsl, владелец a=2) → None', () => {
        // Контрагенты снят с поддержки (код a=2 в реальном .bin) — модуль
        // объекта резолвится к владельцу (у него нет собственного XML) и
        // должен унаследовать None, а не остаться заблокированным по старой
        // (неверной) трактовке кода 2 как Locked.
        const bslPath = path.join(configRoot, 'Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl');
        assert.strictEqual(service.getSupportMode(bslPath), SupportMode.None);
      });

      test('BSL-модуль формы с собственным XML (Catalogs/Контрагенты/Forms/ФормаЭлемента, a=2) → None', () => {
        // У формы есть собственный Forms/ФормаЭлемента.xml с отдельным uuid и
        // отдельным кодом (a=2) в .bin — режим модуля формы берётся из него,
        // а не из владельца-справочника.
        const bslPath = path.join(
          configRoot,
          'Catalogs',
          'Контрагенты',
          'Forms',
          'ФормаЭлемента',
          'Ext',
          'Form',
          'Module.bsl'
        );
        assert.strictEqual(service.getSupportMode(bslPath), SupportMode.None);
      });

      test('BSL-модуль заведомо заблокированного объекта (HTTPServices/Chatbot/Ext/Module.bsl, a=0) → Locked', () => {
        const bslPath = path.join(configRoot, 'HTTPServices', 'Chatbot', 'Ext', 'Module.bsl');
        assert.strictEqual(service.getSupportMode(bslPath), SupportMode.Locked);
      });
    });
  }
});

/**
 * Реальный `example/support/changes-forbidden/ParentConfigurations.bin` — та же
 * поставка, что и в `example/2.21`, но с флагом «изменения запрещены» в
 * заголовке (`{6,1,…}`). При этом флаге ЛЮБОЙ путь под корнем конфигурации
 * обязан резолвиться в Locked — независимо от кода конкретной записи, наличия
 * uuid в списке и даже наличия XML-владельца у BSL-модуля.
 */
suite('SupportInfoService — изменения запрещены (реальная фикстура)', () => {
  let tempDir: string;
  let configRoot: string;
  let logger: TestLogger;
  let service: SupportInfoService;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-forbidden-'));
    configRoot = path.join(tempDir, 'cf');
    const source = EXAMPLE_CF_ROOTS['2.21'];

    fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
    fs.mkdirSync(path.join(configRoot, 'Documents'), { recursive: true });
    fs.mkdirSync(path.join(configRoot, 'Ext'), { recursive: true });

    fs.copyFileSync(path.join(source, 'Configuration.xml'), path.join(configRoot, 'Configuration.xml'));
    fs.copyFileSync(
      path.join(source, 'Catalogs', 'Контрагенты.xml'),
      path.join(configRoot, 'Catalogs', 'Контрагенты.xml')
    );
    fs.copyFileSync(
      path.join(source, 'Documents', 'ПриходТовара.xml'),
      path.join(configRoot, 'Documents', 'ПриходТовара.xml')
    );
    fs.copyFileSync(CHANGES_FORBIDDEN_BIN_PATH, path.join(configRoot, 'Ext', 'ParentConfigurations.bin'));

    logger = new TestLogger();
    service = new SupportInfoService(logger);
    service.loadConfig(configRoot);
  });

  teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('hasConfigData → true', () => {
    assert.strictEqual(service.hasConfigData(path.join(configRoot, 'Configuration.xml')), true);
  });

  test('Configuration.xml (код a=1, editable вне запрета) → Locked', () => {
    assert.strictEqual(service.getSupportMode(path.join(configRoot, 'Configuration.xml')), SupportMode.Locked);
  });

  test('Catalogs/Контрагенты.xml (код a=2, None вне запрета) → Locked', () => {
    assert.strictEqual(service.getSupportMode(path.join(configRoot, 'Catalogs', 'Контрагенты.xml')), SupportMode.Locked);
  });

  test('Documents/ПриходТовара.xml (код a=1, editable вне запрета) → Locked', () => {
    assert.strictEqual(service.getSupportMode(path.join(configRoot, 'Documents', 'ПриходТовара.xml')), SupportMode.Locked);
  });

  test('объект с uuid, отсутствующим в списке поставки → Locked', () => {
    const newUuid = fixtureUuid('forbidden-new-object');
    const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'НовыйСправочник', 'Catalog', newUuid, 'flat');
    assert.strictEqual(service.getSupportMode(xmlPath), SupportMode.Locked);
  });

  test('BSL-модуль общего модуля без XML-владельца → Locked', () => {
    const bslPath = writeBslFile(path.join(configRoot, 'CommonModules', 'Нет', 'Ext', 'Module.bsl'));
    assert.strictEqual(service.getSupportMode(bslPath), SupportMode.Locked);
  });

  test('getSupportModeByUuid для случайного uuid → Locked', () => {
    const configXmlPath = path.join(configRoot, 'Configuration.xml');
    assert.strictEqual(
      service.getSupportModeByUuid(configXmlPath, fixtureUuid('forbidden-random-uuid')),
      SupportMode.Locked
    );
  });

  test('лог содержит сообщение о запрете изменений', () => {
    assert.ok(
      logger.messages.some((m) => m.includes('изменения конфигурации запрещены')),
      `Ожидалась строка лога о запрете изменений: ${JSON.stringify(logger.messages)}`
    );
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

suite('SupportInfoService — BOM реального .bin', () => {
  const variants: { label: string; bom: boolean }[] = [
    { label: 'с BOM (как в реальном файле)', bom: true },
    { label: 'без BOM', bom: false },
  ];

  for (const { label, bom } of variants) {
    test(`временная копия реального .bin и реального Configuration.xml, ${label} → Editable`, () => {
      withConfigRoot((configRoot) => {
        const source = EXAMPLE_CF_ROOTS['2.21'];
        fs.mkdirSync(configRoot, { recursive: true });
        fs.mkdirSync(path.join(configRoot, 'Ext'), { recursive: true });
        fs.copyFileSync(path.join(source, 'Configuration.xml'), path.join(configRoot, 'Configuration.xml'));

        const rawBin = fs.readFileSync(path.join(source, 'Ext', 'ParentConfigurations.bin'), 'utf-8');
        const withoutBom = rawBin.charCodeAt(0) === 0xfeff ? rawBin.slice(1) : rawBin;
        const content = bom ? String.fromCharCode(0xfeff) + withoutBom : withoutBom;
        fs.writeFileSync(path.join(configRoot, 'Ext', 'ParentConfigurations.bin'), content, 'utf-8');

        const service = new SupportInfoService(new TestLogger());
        service.loadConfig(configRoot);

        assert.strictEqual(service.getSupportMode(path.join(configRoot, 'Configuration.xml')), SupportMode.Editable);
      });
    });
  }
});
