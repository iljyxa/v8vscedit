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
  type ObjectXmlLayout,
} from './support/flatMetadataFixtures';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.20/src/cf');

class TestLogger implements Logger {
  readonly messages: string[] = [];

  appendLine(message: string): void {
    this.messages.push(message);
  }
}

suite('SupportInfoService', () => {
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
 * используется.
 */
suite('SupportInfoService — плоская и вложенная раскладка XML объекта', () => {
  const layouts: ObjectXmlLayout[] = ['flat', 'deep'];
  const modes: { mode: SupportMode; label: string }[] = [
    { mode: SupportMode.None, label: 'None' },
    { mode: SupportMode.Editable, label: 'Editable' },
    { mode: SupportMode.Locked, label: 'Locked' },
  ];

  /** Создаёт временный каталог конфигурации, вызывает fn и гарантированно чистит его. */
  function withConfigRoot(fn: (configRoot: string) => void): void {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-flat-'));
    const configRoot = path.join(tempDir, 'cf');
    try {
      fn(configRoot);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  for (const layout of layouts) {
    for (const { mode, label } of modes) {
      test(`CommonModules/X/Ext/Module.bsl: раскладка объекта ${layout}, режим ${label}`, () => {
        withConfigRoot((configRoot) => {
          const configUuid = fixtureUuid(`config-${layout}-${label}`);
          const moduleUuid = fixtureUuid(`module-${layout}-${label}`);
          writeConfigurationXml(configRoot, configUuid);
          writeObjectXml(configRoot, 'CommonModules', 'ОбщийМодуль1', 'CommonModule', moduleUuid, layout);
          const bslPath = writeBslFile(path.join(configRoot, 'CommonModules', 'ОбщийМодуль1', 'Ext', 'Module.bsl'));
          writeParentConfigurationsBin(configRoot, new Map([[moduleUuid, mode]]));

          const logger = new TestLogger();
          const service = new SupportInfoService(logger);
          service.loadConfig(configRoot);

          assert.strictEqual(service.getSupportMode(bslPath), mode);
          assert.strictEqual(service.isLocked(bslPath), mode === SupportMode.Locked);
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
        `\uFEFF<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Form uuid="${formUuid}"><Properties><Name>Форма1</Name></Properties></Form></MetaDataObject>`,
        'utf-8'
      );
      const bslPath = writeBslFile(
        path.join(configRoot, 'Catalogs', 'Каталог1', 'Forms', 'Форма1', 'Ext', 'Form', 'Module.bsl')
      );
      writeParentConfigurationsBin(configRoot, new Map([
        [ownerUuid, SupportMode.Editable],
        [formUuid, SupportMode.Locked],
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
      writeParentConfigurationsBin(configRoot, new Map([[ownerUuid, SupportMode.Locked]]));

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
      writeParentConfigurationsBin(configRoot, new Map([[ownerUuid, SupportMode.Locked]]));

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
      writeParentConfigurationsBin(configRoot, new Map([[ownerUuid, SupportMode.Locked]]));

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
      writeParentConfigurationsBin(configRoot, new Map([[objectUuid, SupportMode.Locked]]));

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
      writeParentConfigurationsBin(configRoot, new Map([[moduleUuid, SupportMode.Locked]]));

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
