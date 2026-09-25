/**
 * Задача C4: add-путь метаданных (общий для MCP и UI) должен отклонять
 * добавление, если владелец/конфигурация находятся на поддержке с запретом
 * редактирования (`SupportMode.Locked`) — так же, как это уже делает
 * `V8McpServer.assertMetadataEditable` для остальных мутаций.
 *
 * `MetadataMutationService.validateRepositoryAccess` сейчас проверяет ТОЛЬКО
 * репозиторный захват и не знает про `supportService` вовсе — эти тесты
 * фиксируют ожидаемое поведение и должны падать до реализации фикса.
 *
 * Фикстуры реальные, синтетики нет: объекты копируются из `example/2.21/src/cf`,
 * а `Ext/ParentConfigurations.bin` — РЕАЛЬНЫЙ файл той же выгрузки (см.
 * `parentConfigurationsParser.test.ts`): в нём справочник
 * `АвансовыйОтчетПрисоединенныеФайлы` имеет код `a=0` (не редактируется →
 * `SupportMode.Locked`), а `Контрагенты` — код `a=2` (снят с поддержки →
 * `SupportMode.Removed`, issue #21, никогда не `Locked`, несмотря на числовое
 * совпадение со старой — неверной — трактовкой кода 2 как запрета). Для
 * сценария «изменения запрещены» у нового (не входящего в поставку) корня
 * используется другой реальный файл —
 * `example/support/changes-forbidden/ParentConfigurations.bin`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataMutationService } from '../../ui/commands/metadata/MetadataMutationService';
import { MetadataXmlCreator } from '../../infra/xml/MetadataXmlCreator';
import { MetadataXmlRemover } from '../../infra/xml/MetadataXmlRemover';
import { SupportInfoService, SupportMode } from '../../infra/support/SupportInfoService';
import { RepositoryService } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { Logger } from '../../infra/support/Logger';
import type { CommandServices } from '../../ui/commands/_shared';
import { CHANGES_FORBIDDEN_BIN_PATH } from './support/realConfigFixtures';
import { writeParentConfigurationsBin, SUPPORT_BIN_CODE } from './support/flatMetadataFixtures';

/** Фейковый SecretStore на Map — структурный контракт vscode.SecretStorage. */
function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

/** ProjectSecretStorage поверх Map-стора для тестов без Extension Host. */
function createFakeProjectSecretStorage(root: string): ProjectSecretStorage {
  return new ProjectSecretStorage(createFakeSecretStore(), root);
}

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const SAMPLE_CATALOG_XML = path.join(EXAMPLE_CF, 'Catalogs', 'АвансовыйОтчетПрисоединенныеФайлы.xml');
const KONTRAGENTY_XML = path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml');

class TestLogger implements Logger {
  readonly messages: string[] = [];
  appendLine(message: string): void {
    this.messages.push(message);
  }
}

suite('MetadataMutationService — проверка SupportMode.Locked при add (C4)', () => {
  let tempDir: string;
  let configRoot: string;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-add-support-'));
    configRoot = path.join(tempDir, 'cf');
    fs.mkdirSync(configRoot, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Копирует минимальную Configuration.xml с заданным uuid конфигурации. */
  function writeConfigurationXml(configUuid: string): void {
    // BOM через экранирование \uFEFF (не литеральным невидимым символом),
    // чтобы не триггерить no-irregular-whitespace: реальные XML 1С
    // начинаются с UTF-8 BOM, и это нужно сохранить в фикстуре как есть.
    const xml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xs="http://www.w3.org/2001/XMLSchema" version="2.21">
  <Configuration uuid="${configUuid}">
    <Properties>
      <Name>ТестоваяКонфигурация</Name>
      <Synonym/>
    </Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;
    fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), xml, 'utf-8');
  }

  /** Копирует реальный XML-объект из example/2.21 в подготовленный configRoot и возвращает его uuid. */
  function copyRealObject(sourceXmlPath: string, folder: string, destName: string): { xmlPath: string; uuid: string } {
    const dir = path.join(configRoot, folder);
    fs.mkdirSync(dir, { recursive: true });
    const content = fs.readFileSync(sourceXmlPath, 'utf-8');
    fs.writeFileSync(path.join(dir, destName), content, 'utf-8');
    const uuidMatch = /uuid="([0-9a-f-]{36})"/i.exec(content);
    assert.ok(uuidMatch, 'В образце объекта должен быть uuid — иначе фикстура сломана');
    return { xmlPath: path.join(dir, destName), uuid: uuidMatch[1].toLowerCase() };
  }

  /** Копирует реальный справочник из example/2.21 в подготовленный configRoot и возвращает его uuid. */
  function copySampleCatalog(): { xmlPath: string; uuid: string } {
    return copyRealObject(SAMPLE_CATALOG_XML, 'Catalogs', 'ТестовыйСправочник.xml');
  }

  /**
   * Копирует РЕАЛЬНЫЙ `Ext/ParentConfigurations.bin` из `example/2.21/src/cf`
   * (та же поставка, что и `SAMPLE_CATALOG_XML`) — без синтеза: справочник
   * `АвансовыйОтчетПрисоединенныеФайлы` имеет в нём код `a=0` (не
   * редактируется → `SupportMode.Locked`), см. `parentConfigurationsParser.test.ts`.
   */
  function copyRealParentConfigurationsBin(): void {
    const extDir = path.join(configRoot, 'Ext');
    fs.mkdirSync(extDir, { recursive: true });
    fs.copyFileSync(path.join(EXAMPLE_CF, 'Ext', 'ParentConfigurations.bin'), path.join(extDir, 'ParentConfigurations.bin'));
  }

  /**
   * Копирует РЕАЛЬНЫЙ `ParentConfigurations.bin` с флагом «изменения
   * запрещены» в заголовке (`example/support/changes-forbidden`) — та же
   * поставка, но при этом флаге поддержка блокирует ЛЮБОЙ путь под корнем
   * независимо от кода конкретной записи (в т.ч. новый, не входящий в
   * поставку, uuid — как ниже в тесте на корень конфигурации).
   */
  function copyForbiddenParentConfigurationsBin(): void {
    const extDir = path.join(configRoot, 'Ext');
    fs.mkdirSync(extDir, { recursive: true });
    fs.copyFileSync(CHANGES_FORBIDDEN_BIN_PATH, path.join(extDir, 'ParentConfigurations.bin'));
  }

  function createCommandServices(overrides: {
    supportService?: SupportInfoService;
    repositoryService: RepositoryService;
  }): CommandServices {
    const outputMessages: string[] = [];
    // Стаб полей, не участвующих в проверяемом сценарии (не задействуются до
    // ветвления по support/repository или безопасны как no-op на happy-path).
    return {
      treeProvider: { getEntries: () => [], refresh: () => undefined, refreshNodeFromCache: () => false } as unknown as CommandServices['treeProvider'],
      workspaceFolder: { uri: vscode.Uri.file(tempDir), name: 'test', index: 0 },
      metadataXmlCreator: new MetadataXmlCreator(),
      metadataXmlRemover: new MetadataXmlRemover(),
      outputChannel: { appendLine: (m: string) => outputMessages.push(m) } as unknown as vscode.OutputChannel,
      supportService: overrides.supportService,
      repositoryService: overrides.repositoryService,
      reloadEntries: () => Promise.resolve(),
      suppressConfigurationReloadForFiles: () => undefined,
      markChangedConfigurationByFiles: () => undefined,
      refreshActionsView: () => undefined,
    } as unknown as CommandServices;
  }

  test('Отклоняет добавление дочернего элемента к объекту, помеченному SupportMode.Locked', async () => {
    writeConfigurationXml('11111111-1111-1111-1111-111111111111');
    const { xmlPath: catalogXmlPath } = copySampleCatalog();
    // Реальный .bin: АвансовыйОтчетПрисоединенныеФайлы имеет код a=0 (не
    // редактируется) → SupportMode.Locked.
    copyRealParentConfigurationsBin();

    const supportService = new SupportInfoService(new TestLogger());
    supportService.loadConfig(configRoot);
    // Убедимся, что фикстура действительно даёт Locked — иначе тест бессмыслен.
    assert.strictEqual(
      supportService.getSupportMode(catalogXmlPath),
      SupportMode.Locked,
      'Фикстура должна давать SupportMode.Locked для справочника'
    );

    const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
    const services = createCommandServices({ supportService, repositoryService });
    const mutationService = new MetadataMutationService(services);

    const xmlBefore = fs.readFileSync(catalogXmlPath, 'utf-8');

    const result = await mutationService.addMetadata({
      target: {
        kind: 'child',
        ownerObjectXmlPath: catalogXmlPath,
        childTag: 'Attribute',
      },
      name: 'НовыйРеквизит',
    });

    assert.strictEqual(result.success, false, 'Добавление к объекту на поддержке с запретом редактирования должно быть отклонено');
    assert.ok(
      /поддерж/i.test(result.message),
      `Сообщение должно упоминать поддержку/запрет редактирования, получено: "${result.message}"`
    );

    const xmlAfter = fs.readFileSync(catalogXmlPath, 'utf-8');
    assert.strictEqual(xmlAfter, xmlBefore, 'XML объекта не должен измениться при отклонённом добавлении');
  });

  test('Отклоняет добавление корневого объекта, если корень конфигурации помечен SupportMode.Locked', async () => {
    // Синтетический uuid корня намеренно НЕ входит в реальную поставку — при
    // флаге «изменения запрещены» это не важно: Locked действует на любой
    // путь под корнем независимо от того, числится ли его uuid в поставке.
    const configUuid = '22222222-2222-2222-2222-222222222222';
    writeConfigurationXml(configUuid);
    copyForbiddenParentConfigurationsBin();

    const supportService = new SupportInfoService(new TestLogger());
    supportService.loadConfig(configRoot);
    const configXmlPath = path.join(configRoot, 'Configuration.xml');
    assert.strictEqual(
      supportService.getSupportMode(configXmlPath),
      SupportMode.Locked,
      'Фикстура должна давать SupportMode.Locked для корня конфигурации'
    );

    const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
    const services = createCommandServices({ supportService, repositoryService });
    const mutationService = new MetadataMutationService(services);

    const result = await mutationService.addMetadata({
      target: {
        kind: 'root',
        configRoot,
        configKind: 'cf',
        targetKind: 'Catalog',
      },
      name: 'НовыйСправочник',
    });

    assert.strictEqual(result.success, false, 'Добавление корневого объекта в заблокированную поддержкой конфигурацию должно быть отклонено');
    assert.ok(
      /поддерж/i.test(result.message),
      `Сообщение должно упоминать поддержку/запрет редактирования, получено: "${result.message}"`
    );
    assert.ok(
      !fs.existsSync(path.join(configRoot, 'Catalogs', 'НовыйСправочник.xml')),
      'XML нового справочника не должен быть создан при отклонённом добавлении'
    );
  });

  test('РЕГРЕССИЯ: добавление к объекту вне поддержки (SupportMode.None) без хранилища проходит успешно', async () => {
    writeConfigurationXml('33333333-3333-3333-3333-333333333333');
    const { xmlPath: catalogXmlPath } = copySampleCatalog();
    // ParentConfigurations.bin намеренно не создаём — конфигурация не на поддержке.

    const supportService = new SupportInfoService(new TestLogger());
    supportService.loadConfig(configRoot);
    assert.strictEqual(
      supportService.getSupportMode(catalogXmlPath),
      SupportMode.None,
      'Без ParentConfigurations.bin режим должен быть None'
    );

    const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
    const services = createCommandServices({ supportService, repositoryService });
    const mutationService = new MetadataMutationService(services);

    const result = await mutationService.addMetadata({
      target: {
        kind: 'child',
        ownerObjectXmlPath: catalogXmlPath,
        childTag: 'Attribute',
      },
      name: 'РеквизитБезОграничений',
    });

    assert.strictEqual(result.success, true, `Добавление должно пройти без ограничений: ${result.message}`);
    const xml = fs.readFileSync(catalogXmlPath, 'utf-8');
    assert.ok(xml.includes('<Name>РеквизитБезОграничений</Name>'), 'Реквизит должен быть добавлен в XML справочника');
  });

  test('РЕГРЕССИЯ: объект снятый с поддержки (код a=2 в реальном .bin) добавляет реквизит успешно', async () => {
    // Старая (неверная) трактовка использовала «сырой» код `a` файла напрямую
    // как SupportMode — код 2 совпадал с числовым значением SupportMode.Locked
    // и потому «снятый с поддержки» объект (a=2, реально доступен для
    // редактирования — SupportMode.Removed, issue #21) ошибочно блокировался.
    // Контрагенты в реальной поставке имеют именно код a=2.
    writeConfigurationXml('66666666-6666-6666-6666-666666666666');
    const { xmlPath: kontragentyXmlPath } = copyRealObject(KONTRAGENTY_XML, 'Catalogs', 'Контрагенты.xml');
    copyRealParentConfigurationsBin();

    const supportService = new SupportInfoService(new TestLogger());
    supportService.loadConfig(configRoot);
    assert.strictEqual(
      supportService.getSupportMode(kontragentyXmlPath),
      SupportMode.Removed,
      'Контрагенты (a=2 в реальном .bin) должны давать SupportMode.Removed, а не Locked'
    );

    const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
    const services = createCommandServices({ supportService, repositoryService });
    const mutationService = new MetadataMutationService(services);

    const result = await mutationService.addMetadata({
      target: {
        kind: 'child',
        ownerObjectXmlPath: kontragentyXmlPath,
        childTag: 'Attribute',
      },
      name: 'НовыйРеквизитКонтрагента',
    });

    assert.strictEqual(result.success, true, `Добавление должно пройти без ограничений: ${result.message}`);
    const xml = fs.readFileSync(kontragentyXmlPath, 'utf-8');
    assert.ok(xml.includes('<Name>НовыйРеквизитКонтрагента</Name>'), 'Реквизит должен быть добавлен в XML справочника');
  });

  test('РЕГРЕССИЯ: существующая репозиторная проверка продолжает отклонять незахваченный объект', async () => {
    writeConfigurationXml('44444444-4444-4444-4444-444444444444');
    const { xmlPath: catalogXmlPath } = copySampleCatalog();
    // Поддержки нет — проверяем, что старое поведение (репозиторная блокировка) не сломано фиксом C4.

    const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
    const target = repositoryService.resolveTargetByXmlPath(catalogXmlPath);
    assert.ok(target, 'Должна резолвиться цель хранилища для справочника во временном configRoot');
    await repositoryService.saveBinding(target, {
      repoPath: '\\\\repo\\storage',
      repoUser: 'tester',
      repoPassword: 'secret',
    });
    repositoryService.setConnected(target, true);
    // Локальный захват не выставляем — объект должен остаться ограниченным.

    const services = createCommandServices({ repositoryService });
    const mutationService = new MetadataMutationService(services);

    const xmlBefore = fs.readFileSync(catalogXmlPath, 'utf-8');

    const result = await mutationService.addMetadata({
      target: {
        kind: 'child',
        ownerObjectXmlPath: catalogXmlPath,
        childTag: 'Attribute',
      },
      name: 'РеквизитПриЗапрете',
    });

    assert.strictEqual(result.success, false, 'Незахваченный в хранилище объект должен по-прежнему отклонять добавление');
    assert.ok(
      /хранилищ/i.test(result.message),
      `Сообщение должно упоминать хранилище (прежнее поведение), получено: "${result.message}"`
    );
    const xmlAfter = fs.readFileSync(catalogXmlPath, 'utf-8');
    assert.strictEqual(xmlAfter, xmlBefore, 'XML объекта не должен измениться при отклонённом репозиторной проверкой добавлении');
  });

  test('РЕГРЕССИЯ: репозиторная проверка отклоняет незахваченный корень конфигурации (root-ветка validateRepositoryAccess)', async () => {
    // Покрывает ветвь target.kind === 'root' внутри validateRepositoryAccess —
    // C4 оборачивает её в validateEditAccess, но сама ветвь дособытийная и
    // должна остаться доступной, если поддержка не установлена.
    writeConfigurationXml('55555555-5555-5555-5555-555555555555');
    // Поддержки нет — сработать должна именно репозиторная проверка корня.

    const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
    const rootTarget = repositoryService.resolveTargetByConfigRoot(configRoot);
    assert.ok(rootTarget, 'Должна резолвиться цель хранилища для корня конфигурации');
    await repositoryService.saveBinding(rootTarget, {
      repoPath: '\\\\repo\\storage',
      repoUser: 'tester',
      repoPassword: 'secret',
    });
    repositoryService.setConnected(rootTarget, true);
    // Локальный захват корня не выставляем — корень должен остаться ограниченным.

    const services = createCommandServices({ repositoryService });
    const mutationService = new MetadataMutationService(services);

    const result = await mutationService.addMetadata({
      target: {
        kind: 'root',
        configRoot,
        configKind: 'cf',
        targetKind: 'Catalog',
      },
      name: 'СправочникПриЗапретеКорня',
    });

    assert.strictEqual(result.success, false, 'Незахваченный в хранилище корень должен отклонять добавление корневого объекта');
    assert.ok(
      /хранилищ/i.test(result.message),
      `Сообщение должно упоминать хранилище (репозиторная проверка корня), получено: "${result.message}"`
    );
    assert.ok(
      !fs.existsSync(path.join(configRoot, 'Catalogs', 'СправочникПриЗапретеКорня.xml')),
      'XML нового справочника не должен быть создан при отклонённом репозиторной проверкой добавлении'
    );
  });

  /**
   * Issue #22: `getSupportMode` по-прежнему возвращает `Locked` для ЛЮБОГО
   * файла при флаге «изменения запрещены», но `validateEditAccess` обязан
   * различать причину и выдавать другой текст — как для дочернего элемента,
   * так и для корневого объекта, — независимо от исходного кода конкретной
   * записи `.bin` (см. `SupportInfoService — hasChangesForbidden`).
   */
  suite('issue #22 — текст отказа при флаге «изменения запрещены» в настройках поддержки', () => {
    const FORBIDDEN_MESSAGE = 'Добавление запрещено: изменения конфигурации запрещены в настройках поддержки.';

    test('дочерний элемент (Контрагенты, a=2 вне запрета) отклоняется текстом про настройки поддержки', async () => {
      writeConfigurationXml('77777777-7777-7777-7777-777777777777');
      const { xmlPath: kontragentyXmlPath } = copyRealObject(KONTRAGENTY_XML, 'Catalogs', 'Контрагенты.xml');
      copyForbiddenParentConfigurationsBin();

      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(configRoot);
      assert.strictEqual(
        supportService.hasChangesForbidden(kontragentyXmlPath),
        true,
        'фикстура должна давать флаг запрета изменений'
      );

      const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
      const services = createCommandServices({ supportService, repositoryService });
      const mutationService = new MetadataMutationService(services);

      const xmlBefore = fs.readFileSync(kontragentyXmlPath, 'utf-8');

      const result = await mutationService.addMetadata({
        target: { kind: 'child', ownerObjectXmlPath: kontragentyXmlPath, childTag: 'Attribute' },
        name: 'РеквизитПриЗапретеИзменений',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.message, FORBIDDEN_MESSAGE);
      assert.strictEqual(fs.readFileSync(kontragentyXmlPath, 'utf-8'), xmlBefore, 'XML объекта не должен измениться');
    });

    test('корневой объект отклоняется тем же текстом про настройки поддержки', async () => {
      const configUuid = '17171717-1717-1717-1717-171717171717';
      writeConfigurationXml(configUuid);
      copyForbiddenParentConfigurationsBin();

      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(configRoot);
      const configXmlPath = path.join(configRoot, 'Configuration.xml');
      assert.strictEqual(supportService.hasChangesForbidden(configXmlPath), true);

      const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
      const services = createCommandServices({ supportService, repositoryService });
      const mutationService = new MetadataMutationService(services);

      const result = await mutationService.addMetadata({
        target: { kind: 'root', configRoot, configKind: 'cf', targetKind: 'Catalog' },
        name: 'СправочникПриЗапретеИзменений',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.message, FORBIDDEN_MESSAGE);
      assert.ok(!fs.existsSync(path.join(configRoot, 'Catalogs', 'СправочникПриЗапретеИзменений.xml')));
    });

    test('РЕГРЕССИЯ: без флага — дочерний элемент отклоняется прежним текстом «объект находится на поддержке с запретом редактирования»', async () => {
      writeConfigurationXml('27272727-2727-2727-2727-272727272727');
      const { xmlPath: catalogXmlPath } = copySampleCatalog();
      copyRealParentConfigurationsBin();

      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(configRoot);
      assert.strictEqual(supportService.hasChangesForbidden(catalogXmlPath), false);

      const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
      const services = createCommandServices({ supportService, repositoryService });
      const mutationService = new MetadataMutationService(services);

      const result = await mutationService.addMetadata({
        target: { kind: 'child', ownerObjectXmlPath: catalogXmlPath, childTag: 'Attribute' },
        name: 'РеквизитБезФлагаЗапрета',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.message, 'Добавление запрещено: объект находится на поддержке с запретом редактирования.');
    });

    test('РЕГРЕССИЯ: корень Locked без флага запрета (синтетический .bin) отклоняется прежним текстом «конфигурация находится на поддержке»', async () => {
      const configUuid = '37373737-3737-3737-3737-373737373737';
      writeConfigurationXml(configUuid);
      writeParentConfigurationsBin(configRoot, new Map([[configUuid, SUPPORT_BIN_CODE.locked]]), {
        changesForbidden: false,
      });

      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(configRoot);
      const configXmlPath = path.join(configRoot, 'Configuration.xml');
      assert.strictEqual(supportService.getSupportMode(configXmlPath), SupportMode.Locked);
      assert.strictEqual(supportService.hasChangesForbidden(configXmlPath), false);

      const repositoryService = new RepositoryService(tempDir, createFakeProjectSecretStorage(tempDir));
      const services = createCommandServices({ supportService, repositoryService });
      const mutationService = new MetadataMutationService(services);

      const result = await mutationService.addMetadata({
        target: { kind: 'root', configRoot, configKind: 'cf', targetKind: 'Catalog' },
        name: 'СправочникПриЛокеБезФлага',
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.message, 'Добавление запрещено: конфигурация находится на поддержке с запретом редактирования.');
      assert.ok(!fs.existsSync(path.join(configRoot, 'Catalogs', 'СправочникПриЛокеБезФлага.xml')));
    });
  });
});
