import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { RepositoryLockState } from '../../infra/repository/RepositoryLockState';
import { RepositoryLockSnapshotStore } from '../../infra/repository/RepositoryLockSnapshotStore';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import {
  fixtureUuid,
  writeConfigurationXml,
  writeObjectXml,
  type ObjectXmlLayout,
} from './support/flatMetadataFixtures';

/**
 * Issue #1 — `RepositoryService` становится тонким фасадом: снапшоты захвата
 * (issue #2) переехали в `RepositoryLockSnapshotStore` (см.
 * `repositoryLockSnapshotStore.test.ts`), состояние `state.json`/матрица
 * переходов — в `RepositoryLockState` (см. `repositoryLockState.test.ts`),
 * `buildPartialDumpPlan`/`resolveSubsystemMemberFullNames`/`resolveXmlPathByFullName`
 * — в `RepositoryDumpPlan` (см. `repositoryDumpPlan.test.ts`). Здесь остаётся то,
 * что явно перечислено в плане архитектора как ФАСАД: резолвинг цели/привязки,
 * `isLocked`/`isRootLocked`/`setLocked` (совместимость), `isEditRestricted`/
 * `isMetadataEditRestricted` (делегируют в `RepositoryLockState`, но с новой
 * обогащённой семантикой — рекурсивный корень/подсистема/releasedUnderRoot),
 * `onDidChangeLocks` (делегирует), `createObjectsFileForNode`/`resolveFullName`.
 */

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

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example/2.20');
const EXAMPLE_CF = path.join(EXAMPLE_ROOT, 'src', 'cf');

suite('RepositoryService', () => {
  let service: RepositoryService;
  let envBackup: string | undefined;
  let stateBackup: string | undefined;

  const envPath = path.join(EXAMPLE_ROOT, 'env.json');
  const statePath = path.join(EXAMPLE_ROOT, '.v8vscedit', 'repository', 'state.json');
  const snapshotsRoot = path.join(EXAMPLE_ROOT, '.v8vscedit', 'repository', 'snapshots');

  setup(() => {
    service = new RepositoryService(EXAMPLE_ROOT, new ProjectSecretStorage(createFakeSecretStore(), EXAMPLE_ROOT));
    envBackup = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : undefined;
    stateBackup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : undefined;
  });

  teardown(() => {
    restoreFile(envPath, envBackup);
    restoreFile(statePath, stateBackup);
    fs.rmSync(snapshotsRoot, { recursive: true, force: true });
  });

  test('Запрещает редактирование незахваченного модуля объекта при активном подключении к хранилищу', async function () {
    const target_ = findFirstCatalogWithModule();
    if (!target_) {
      this.skip();
    }
    const { xmlPath, modulePath, objectName } = target_;
    const target = service.resolveTargetByXmlPath(xmlPath);

    assert.ok(target, 'Не удалось определить цель хранилища для примера.');

    await service.saveBinding(target, {
      repoPath: '\\\\repo\\storage',
      repoUser: 'tester',
      repoPassword: 'secret',
    });
    service.setConnected(target, true);

    assert.strictEqual(service.isEditRestricted(modulePath), true);

    const fullName = service.resolveFullName({
      nodeKind: 'Catalog',
      label: objectName,
      xmlPath,
    });
    assert.strictEqual(fullName, `Справочник.${objectName}`);

    service.setLocked(target, [fullName], true);
    assert.strictEqual(service.isEditRestricted(modulePath), false);
  });

  test('Для модуля формы использует захват корневого объекта', async function () {
    const target_ = findFirstCatalogWithForm();
    if (!target_) {
      this.skip();
    }
    const { xmlPath, formModulePath, objectName } = target_;
    const target = service.resolveTargetByXmlPath(xmlPath);

    assert.ok(target, 'Не удалось определить цель хранилища для примера.');

    await service.saveBinding(target, {
      repoPath: '\\\\repo\\storage',
      repoUser: 'tester',
      repoPassword: 'secret',
    });
    service.setConnected(target, true);

    assert.strictEqual(service.isEditRestricted(formModulePath), true);

    service.setLocked(target, [`Справочник.${objectName}`], true);
    assert.strictEqual(service.isEditRestricted(formModulePath), false);
  });

  test('Для создания корневых объектов требуется захват корня конфигурации', async () => {
    const configXmlPath = path.join(EXAMPLE_CF, 'Configuration.xml');
    const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);

    assert.ok(target, 'Не удалось определить цель хранилища для корня конфигурации.');

    await service.saveBinding(target, {
      repoPath: '\\\\repo\\storage',
      repoUser: 'tester',
      repoPassword: 'secret',
    });
    service.setConnected(target, true);

    assert.strictEqual(service.isMetadataEditRestricted(target), true);
    assert.strictEqual(service.isRootLocked(target), false);

    const objects = service.createObjectsFileForNode({
      nodeKind: 'configuration',
      label: 'Конфигурация',
      xmlPath: configXmlPath,
    }, false);

    service.setLocked(target, objects.fullNames, true);

    assert.strictEqual(service.isRootLocked(target), true);
    assert.strictEqual(service.isMetadataEditRestricted(target), false);
  });

  test('findConfigRoot — повторный resolveTargetByXmlPath возвращает кэшированный target', () => {
    const target_ = findFirstCatalogWithModule();
    if (!target_) {
      return;
    }
    const { xmlPath } = target_;

    const first = service.resolveTargetByXmlPath(xmlPath);
    assert.ok(first, 'Первый вызов должен найти конфигурацию.');

    const size = service.getConfigRootCacheSize();
    assert.ok(size > 0, 'Кэш findConfigRoot должен заполниться при первом проходе.');

    const second = service.resolveTargetByXmlPath(xmlPath);
    assert.deepStrictEqual(second, first);
    assert.strictEqual(service.getConfigRootCacheSize(), size, 'Повторный вызов не должен расширять кэш.');
  });

  const sampleTarget: RepositoryTarget = {
    configRoot: EXAMPLE_CF,
    configKind: 'cf',
    displayName: 'Тест',
  };

  test('Пустой env.json не роняет чтение привязки', async () => {
    fs.writeFileSync(envPath, '   \n', 'utf-8');
    const fresh = new RepositoryService(EXAMPLE_ROOT, new ProjectSecretStorage(createFakeSecretStore(), EXAMPLE_ROOT));
    assert.doesNotThrow(() => fresh.hasBinding(sampleTarget));
    assert.strictEqual(await fresh.loadBinding(sampleTarget), null);
  });

  test('Битый env.json даёт внятную ошибку', async () => {
    fs.writeFileSync(envPath, '{ не json', 'utf-8');
    const fresh = new RepositoryService(EXAMPLE_ROOT, new ProjectSecretStorage(createFakeSecretStore(), EXAMPLE_ROOT));
    await assert.rejects(() => fresh.loadBinding(sampleTarget), /env\.json повреждён/);
  });

  test('env.json не-объект трактуется как повреждённый', async () => {
    fs.writeFileSync(envPath, '[1,2,3]', 'utf-8');
    const fresh = new RepositoryService(EXAMPLE_ROOT, new ProjectSecretStorage(createFakeSecretStore(), EXAMPLE_ROOT));
    await assert.rejects(() => fresh.loadBinding(sampleTarget), /ожидался объект/);
  });

  test('findConfigRoot — invalidateConfigRootCache сбрасывает кэш', () => {
    const target_ = findFirstCatalogWithModule();
    if (!target_) {
      return;
    }
    const { xmlPath } = target_;

    service.resolveTargetByXmlPath(xmlPath);
    assert.ok(service.getConfigRootCacheSize() > 0);

    service.invalidateConfigRootCache();
    assert.strictEqual(service.getConfigRootCacheSize(), 0);

    service.resolveTargetByXmlPath(xmlPath);
    assert.ok(service.getConfigRootCacheSize() > 0);
  });

  suite('Фасад: lockState/snapshots — стабильные экземпляры, созданные в конструкторе', () => {
    test('lockState/snapshots — один и тот же экземпляр при повторном обращении', () => {
      assert.strictEqual(service.lockState, service.lockState);
      assert.strictEqual(service.snapshots, service.snapshots);
      assert.ok(service.lockState instanceof RepositoryLockState);
      assert.ok(service.snapshots instanceof RepositoryLockSnapshotStore);
    });

    test('lockState — тот же workspaceRoot, что у RepositoryService (состояние видно напрямую через lockState)', () => {
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);
      service.lockState.applyLock(target, { anchor: 'Справочник.Прямой', members: ['Справочник.Прямой'] });
      assert.strictEqual(service.isLocked(target, 'Справочник.Прямой'), true);
    });
  });

  suite('Фасад: isEditRestricted/isMetadataEditRestricted учитывают обогащённую семантику RepositoryLockState', () => {
    test('рекурсивный захват корня снимает ограничение с ЛЮБОГО объекта, включая ранее не захватывавшийся', async function () {
      const target_ = findFirstCatalogWithModule();
      if (!target_) {
        this.skip();
      }
      const { xmlPath, modulePath } = target_;
      const target = service.resolveTargetByXmlPath(xmlPath);
      assert.ok(target);
      await service.saveBinding(target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      service.setConnected(target, true);
      assert.strictEqual(service.isEditRestricted(modulePath), true);

      const rootName = getRootLockName(target);
      service.lockState.applyLock(target, { anchor: rootName, members: [rootName], recursiveRoot: true });

      assert.strictEqual(service.isEditRestricted(modulePath), false);
    });

    test('точечное освобождение объекта при рекурсивном корне (releasedUnderRoot) снова ограничивает именно этот объект', async function () {
      const target_ = findFirstCatalogWithModule();
      if (!target_) {
        this.skip();
      }
      const { xmlPath, modulePath, objectName } = target_;
      const target = service.resolveTargetByXmlPath(xmlPath);
      assert.ok(target);
      await service.saveBinding(target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      service.setConnected(target, true);

      const rootName = getRootLockName(target);
      service.lockState.applyLock(target, { anchor: rootName, members: [rootName], recursiveRoot: true });
      assert.strictEqual(service.isEditRestricted(modulePath), false);

      const fullName = `Справочник.${objectName}`;
      service.lockState.applyUnlock(target, { anchor: fullName, members: [fullName], recursive: false, isRoot: false });

      assert.strictEqual(service.isEditRestricted(modulePath), true, 'Точечно освобождённый объект должен снова требовать явного захвата.');
    });

    test('участник рекурсивно захваченной подсистемы редактируем без отдельного захвата', async function () {
      const target_ = findFirstCatalogWithModule();
      if (!target_) {
        this.skip();
      }
      const { xmlPath, modulePath, objectName } = target_;
      const target = service.resolveTargetByXmlPath(xmlPath);
      assert.ok(target);
      await service.saveBinding(target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      service.setConnected(target, true);
      assert.strictEqual(service.isEditRestricted(modulePath), true);

      const fullName = `Справочник.${objectName}`;
      service.lockState.applyLock(target, { anchor: 'Подсистема.Продажи', members: ['Подсистема.Продажи', fullName] });

      assert.strictEqual(service.isEditRestricted(modulePath), false);
    });

    test('isRootLocked остаётся true только при явном захвате корня, а не из-за rootRecursive произвольного объекта', () => {
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);
      service.lockState.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });
      assert.strictEqual(service.isRootLocked(target), false);
    });
  });

  suite('Фасад: onDidChangeLocks делегирует в RepositoryLockState', () => {
    test('событие приходит и через RepositoryService, и напрямую через lockState — это один и тот же источник', () => {
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);
      const events: unknown[] = [];
      const subscription = service.onDidChangeLocks((event: unknown) => events.push(event));

      service.setLocked(target, ['Справочник.Событие'], true);

      assert.strictEqual(events.length, 1);
      subscription.dispose();

      service.setLocked(target, ['Справочник.Событие2'], true);
      assert.strictEqual(events.length, 1, 'После dispose новые события через RepositoryService приходить не должны.');
    });
  });
});

// Ищет справочник, у которого есть XML и реальный ObjectModule.bsl рядом.
function findFirstCatalogWithModule(): { xmlPath: string; modulePath: string; objectName: string } | null {
  const catalogsDir = path.join(EXAMPLE_CF, 'Catalogs');
  if (!fs.existsSync(catalogsDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(catalogsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.xml')) {
      continue;
    }
    const objectName = path.basename(entry.name, '.xml');
    const xmlPath = path.join(catalogsDir, entry.name);
    const modulePath = path.join(catalogsDir, objectName, 'Ext', 'ObjectModule.bsl');
    if (fs.existsSync(modulePath)) {
      return { xmlPath, modulePath, objectName };
    }
  }
  return null;
}

// Ищет справочник, у которого есть XML и модуль формы рядом.
function findFirstCatalogWithForm(): { xmlPath: string; formModulePath: string; objectName: string } | null {
  const catalogsDir = path.join(EXAMPLE_CF, 'Catalogs');
  if (!fs.existsSync(catalogsDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(catalogsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.xml')) {
      continue;
    }
    const objectName = path.basename(entry.name, '.xml');
    const xmlPath = path.join(catalogsDir, entry.name);
    const formsDir = path.join(catalogsDir, objectName, 'Forms');
    if (!fs.existsSync(formsDir)) {
      continue;
    }
    for (const formEntry of fs.readdirSync(formsDir, { withFileTypes: true })) {
      if (!formEntry.isDirectory()) {
        continue;
      }
      const formModulePath = path.join(formsDir, formEntry.name, 'Ext', 'Form', 'Module.bsl');
      if (fs.existsSync(formModulePath)) {
        return { xmlPath, formModulePath, objectName };
      }
    }
  }
  return null;
}

/**
 * `RepositoryService.resolveOwnerObjectXmlPath` уже умел находить и глубокую, и
 * плоскую раскладку XML владельца — тесты ниже фиксируют это поведение как
 * регрессионную защиту, не как красный сценарий: на временном проекте без
 * `example/` захват/снятие захвата объекта в обеих раскладках должно работать
 * одинаково.
 */
suite('RepositoryService — плоская и вложенная раскладка владельца', () => {
  const layouts: ObjectXmlLayout[] = ['flat', 'deep'];

  for (const layout of layouts) {
    test(`Запрещает редактирование незахваченного модуля и снимает запрет после захвата (раскладка объекта: ${layout})`, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repo-flat-'));
      try {
        const configRoot = path.join(tempDir, 'cf');
        const configUuid = fixtureUuid(`repo-config-${layout}`);
        const objectUuid = fixtureUuid(`repo-object-${layout}`);
        writeConfigurationXml(configRoot, configUuid);
        const objectXmlPath = writeObjectXml(configRoot, 'Catalogs', 'Каталог1', 'Catalog', objectUuid, layout);
        const modulePath = path.join(configRoot, 'Catalogs', 'Каталог1', 'Ext', 'ObjectModule.bsl');
        fs.mkdirSync(path.dirname(modulePath), { recursive: true });
        fs.writeFileSync(modulePath, '', 'utf-8');

        const service = new RepositoryService(tempDir, new ProjectSecretStorage(createFakeSecretStore(), tempDir));
        const target = service.resolveTargetByXmlPath(modulePath);
        assert.ok(target, 'Не удалось определить цель хранилища во временном проекте.');

        await service.saveBinding(target, {
          repoPath: '\\\\repo\\storage',
          repoUser: 'tester',
          repoPassword: 'secret',
        });
        service.setConnected(target, true);

        assert.strictEqual(service.isEditRestricted(modulePath), true);

        const fullName = service.resolveFullName({
          nodeKind: 'Catalog',
          label: 'Каталог1',
          xmlPath: objectXmlPath,
        });
        assert.strictEqual(fullName, 'Справочник.Каталог1');

        service.setLocked(target, [fullName], true);
        assert.strictEqual(service.isEditRestricted(modulePath), false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

/**
 * Раздел 10, Р9: `isEditRestricted` учитывает суффикс ЕДИНИЦЫ (форма/макет/…)
 * после каталога объекта — критерии приёмки 10.1.3/10.1.9. Используется
 * реальная копия `example/2.21/src/cf/Catalogs/Контрагенты` — предсказуемый
 * состав (2 формы + 1 макет), не совпадающий по структуре с объектами,
 * которые мог найти `findFirstCatalogWithModule`/`findFirstCatalogWithForm`
 * в 2.20 (эти helper'ы используются test'ами выше и не меняются).
 *
 * Копия кладётся под `<tmp>/src/cf`, а не берётся напрямую из `example/`:
 * `RepositoryService.findConfigRoot` поднимается по дереву каталогов только
 * до `workspaceRoot` (включительно) — путь вне рабочей области цель
 * хранилища не резолвит.
 */
suite('RepositoryService — isEditRestricted: суффикс единицы (issue #1, раздел 10, Р9)', () => {
  const EXAMPLE_CF_21 = path.resolve(__dirname, '../../../example/2.21/src/cf');
  const tempDirs: string[] = [];

  teardown(() => {
    tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  interface ConnectedSuffixService {
    service: RepositoryService;
    target: RepositoryTarget;
    formModule: string;
    ownerModule: string;
    commandModule: string;
  }

  async function connectedService(): Promise<ConnectedSuffixService> {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repo-unit-suffix-'));
    tempDirs.push(workspaceRoot);
    const configRoot = path.join(workspaceRoot, 'src', 'cf');
    fs.mkdirSync(path.dirname(configRoot), { recursive: true });
    fs.cpSync(EXAMPLE_CF_21, configRoot, { recursive: true });

    const service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
    const target = service.resolveTargetByXmlPath(path.join(configRoot, 'Catalogs', 'Контрагенты.xml'));
    assert.ok(target, 'Не удалось определить цель хранилища для копии example/2.21/src/cf.');
    await service.saveBinding(target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
    service.setConnected(target, true);
    return {
      service,
      target,
      formModule: path.join(configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl'),
      ownerModule: path.join(configRoot, 'Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl'),
      commandModule: path.join(configRoot, 'Catalogs', 'Контрагенты', 'Commands', 'Покупатели', 'Ext', 'CommandModule.bsl'),
    };
  }

  test('критерий 10.1.3: нерекурсивный захват (mode:"object") владельца — файл формы остаётся restricted, файл владельца и Commands — нет', async () => {
    const { service, target, formModule, ownerModule, commandModule } = await connectedService();
    assert.strictEqual(service.isEditRestricted(formModule), true);
    assert.strictEqual(service.isEditRestricted(ownerModule), true);

    service.lockState.applyLock(target, { anchor: 'Справочник.Контрагенты', members: ['Справочник.Контрагенты'], mode: 'object' });

    assert.strictEqual(service.isEditRestricted(ownerModule), false, 'Файл владельца (не единицы) должен стать редактируемым.');
    assert.strictEqual(service.isEditRestricted(commandModule), false, 'Command не является отдельной единицей — редактируем вместе с владельцем.');
    assert.strictEqual(service.isEditRestricted(formModule), true, 'Форма — отдельная единица, нерекурсивный захват её не открывает.');
  });

  test('критерий 10.1.2/10.1.9: рекурсивный захват (mode:"recursive", подчинённые в составе) — форма тоже редактируема', async () => {
    const { service, target, formModule, ownerModule } = await connectedService();
    service.lockState.applyLock(target, {
      anchor: 'Справочник.Контрагенты',
      members: ['Справочник.Контрагенты', 'Справочник.Контрагенты.Форма.ФормаЭлемента', 'Справочник.Контрагенты.Форма.ФормаСписка', 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла'],
      mode: 'recursive',
    });
    assert.strictEqual(service.isEditRestricted(formModule), false);
    assert.strictEqual(service.isEditRestricted(ownerModule), false);
  });

  test('критерий 10.1.9: старая запись (setLocked, без mode) — форма редактируема, как раньше (правило старых записей)', async () => {
    const { service, target, formModule } = await connectedService();
    service.setLocked(target, ['Справочник.Контрагенты'], true);
    assert.strictEqual(service.isEditRestricted(formModule), false, 'Обратная совместимость: старый (плоский) захват владельца исторически открывал и его формы.');
  });

  test('критерий 10.1.9: нерекурсивная отмена после рекурсивного захвата (P4) — владелец снова restricted, формы остаются редактируемыми', async () => {
    const { service, target, formModule, ownerModule } = await connectedService();
    const members = [
      'Справочник.Контрагенты',
      'Справочник.Контрагенты.Форма.ФормаЭлемента',
      'Справочник.Контрагенты.Форма.ФормаСписка',
      'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла',
    ];
    service.lockState.applyLock(target, { anchor: 'Справочник.Контрагенты', members, mode: 'recursive' });
    assert.strictEqual(service.isEditRestricted(formModule), false);

    // Нерекурсивная отмена якоря с группой: из группы убирается только якорь (P4).
    service.lockState.applyUnlock(target, { anchor: 'Справочник.Контрагенты', members: ['Справочник.Контрагенты'], recursive: false, isRoot: false });

    assert.strictEqual(service.isEditRestricted(ownerModule), true, 'Владелец должен снова требовать захвата (P4: на сервере остался незахваченным).');
    assert.strictEqual(service.isEditRestricted(formModule), false, 'Форма должна остаться редактируемой — на сервере она осталась захваченной (P4).');
  });
});

function restoreFile(filePath: string, backup: string | undefined): void {
  if (backup === undefined) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, backup, 'utf-8');
}
