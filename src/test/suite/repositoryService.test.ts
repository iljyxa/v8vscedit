import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

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

    // После прогрева внутренний кэш findConfigRoot должен содержать запись
    // ровно для директории файла. Это и есть наблюдаемое свидетельство мемоизации.
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
    // Свежий сервис, чтобы исключить попадание в кэш предыдущего чтения.
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

    // После сброса кэша повторный вызов снова прогревает кэш.
    service.resolveTargetByXmlPath(xmlPath);
    assert.ok(service.getConfigRootCacheSize() > 0);
  });

  suite('Снапшот захвата (issue #2 — откат при unlock)', () => {
    test('Без изменений после захвата diff пуст, а после discard снапшота нет', () => {
      const target_ = findFirstCatalogWithModule();
      if (!target_) {
        return;
      }
      const { xmlPath, objectName } = target_;
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { nodeKind: 'Catalog', label: objectName, xmlPath };
      service.captureLockSnapshot(target, node);

      const diff = service.getLockSnapshotDiff(target, node);
      assert.strictEqual(diff.hasSnapshot, true);
      assert.deepStrictEqual(diff.changedFiles, []);

      service.discardLockSnapshot(target, node);
      const afterDiscard = service.getLockSnapshotDiff(target, node);
      assert.strictEqual(afterDiscard.hasSnapshot, false);
    });

    test('Изменение модуля объекта после захвата попадает в diff и откатывается restoreLockSnapshot', () => {
      const target_ = findFirstCatalogWithModule();
      if (!target_) {
        return;
      }
      const { xmlPath, modulePath, objectName } = target_;
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { nodeKind: 'Catalog', label: objectName, xmlPath };
      const originalModuleContent = fs.readFileSync(modulePath);
      try {
        service.captureLockSnapshot(target, node);

        fs.writeFileSync(modulePath, `${originalModuleContent.toString('utf-8')}\n// локальная правка теста\n`, 'utf-8');
        const relativeModulePath = path.relative(EXAMPLE_CF, modulePath).split(path.sep).join('/');

        const diff = service.getLockSnapshotDiff(target, node);
        assert.strictEqual(diff.hasSnapshot, true);
        assert.deepStrictEqual(diff.changedFiles, [relativeModulePath]);

        const restored = service.restoreLockSnapshot(target, node);
        assert.ok(restored.some((p) => path.resolve(p) === path.resolve(modulePath)));
        assert.ok(fs.readFileSync(modulePath).equals(originalModuleContent), 'Файл должен вернуться к исходному содержимому.');

        const diffAfterRestore = service.getLockSnapshotDiff(target, node);
        assert.deepStrictEqual(diffAfterRestore.changedFiles, []);

        service.discardLockSnapshot(target, node);
      } finally {
        fs.writeFileSync(modulePath, originalModuleContent);
      }
    });

    test('Удаление файла объекта после захвата попадает в diff и восстанавливается', () => {
      const target_ = findFirstCatalogWithForm();
      if (!target_) {
        return;
      }
      const { xmlPath, formModulePath, objectName } = target_;
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { nodeKind: 'Catalog', label: objectName, xmlPath };
      const originalContent = fs.readFileSync(formModulePath);
      try {
        service.captureLockSnapshot(target, node);
        fs.unlinkSync(formModulePath);

        const diff = service.getLockSnapshotDiff(target, node);
        assert.strictEqual(diff.hasSnapshot, true);
        assert.ok(diff.changedFiles.length > 0);

        service.restoreLockSnapshot(target, node);
        assert.ok(fs.existsSync(formModulePath), 'Удалённый файл должен быть восстановлен из снапшота.');
        assert.ok(fs.readFileSync(formModulePath).equals(originalContent));

        service.discardLockSnapshot(target, node);
      } finally {
        fs.mkdirSync(path.dirname(formModulePath), { recursive: true });
        fs.writeFileSync(formModulePath, originalContent);
      }
    });

    test('Для дочернего узла снапшот снимается по файлам владельца', () => {
      const target_ = findFirstCatalogWithModule();
      if (!target_) {
        return;
      }
      const { xmlPath, modulePath, objectName } = target_;
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const childNode = {
        nodeKind: 'Attribute',
        label: 'Реквизит',
        metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: xmlPath },
      };
      service.captureLockSnapshot(target, childNode);

      const ownerNode = { nodeKind: 'Catalog', label: objectName, xmlPath };
      const diffByOwner = service.getLockSnapshotDiff(target, ownerNode);
      assert.strictEqual(diffByOwner.hasSnapshot, true);
      assert.deepStrictEqual(diffByOwner.changedFiles, []);

      const relativeModulePath = path.relative(EXAMPLE_CF, modulePath).split(path.sep).join('/');
      const originalModuleContent = fs.readFileSync(modulePath);
      try {
        fs.writeFileSync(modulePath, `${originalModuleContent.toString('utf-8')}\n// правка через дочерний узел\n`, 'utf-8');
        const diffAfterEdit = service.getLockSnapshotDiff(target, childNode);
        assert.deepStrictEqual(diffAfterEdit.changedFiles, [relativeModulePath]);
      } finally {
        fs.writeFileSync(modulePath, originalModuleContent);
        service.discardLockSnapshot(target, childNode);
      }
    });

    test('Для корня конфигурации снапшот не снимается', () => {
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(EXAMPLE_CF, 'Configuration.xml') };
      service.captureLockSnapshot(target, node);

      const diff = service.getLockSnapshotDiff(target, node);
      assert.strictEqual(diff.hasSnapshot, false);
      assert.deepStrictEqual(diff.changedFiles, []);

      assert.doesNotThrow(() => {
        service.restoreLockSnapshot(target, node);
        service.discardLockSnapshot(target, node);
      });
    });

    test('Узел без nodeKind не создаёт снапшот и не роняет операции', () => {
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { label: 'Без типа' };
      assert.doesNotThrow(() => {
        service.captureLockSnapshot(target, node);
      });
      const diff = service.getLockSnapshotDiff(target, node);
      assert.strictEqual(diff.hasSnapshot, false);
      assert.deepStrictEqual(service.restoreLockSnapshot(target, node), []);
    });

    test('Дочерний узел без ownerObjectXmlPath в metaContext не создаёт снапшот', () => {
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { nodeKind: 'Attribute', label: 'Реквизит без владельца' };
      assert.doesNotThrow(() => {
        service.captureLockSnapshot(target, node);
      });
      assert.strictEqual(service.getLockSnapshotDiff(target, node).hasSnapshot, false);
    });

    test('Узел без xmlPath (fullName не резолвится) не создаёт снапшот', () => {
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { nodeKind: 'Catalog' };
      assert.doesNotThrow(() => {
        service.captureLockSnapshot(target, node);
      });
      assert.strictEqual(service.getLockSnapshotDiff(target, node).hasSnapshot, false);
      assert.deepStrictEqual(service.restoreLockSnapshot(target, node), []);
      assert.doesNotThrow(() => service.discardLockSnapshot(target, node));
    });

    test('xmlPath указывает на несуществующий файл — снапшот не снимается', () => {
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = {
        nodeKind: 'Catalog',
        label: 'НесуществующийСправочник',
        xmlPath: path.join(EXAMPLE_CF, 'Catalogs', 'НесуществующийСправочник.xml'),
      };
      assert.doesNotThrow(() => {
        service.captureLockSnapshot(target, node);
      });
      assert.strictEqual(service.getLockSnapshotDiff(target, node).hasSnapshot, false);
    });

    test('diff/restore без предварительного captureLockSnapshot отдают "снапшота нет"', () => {
      const target_ = findFirstCatalogWithModule();
      if (!target_) {
        return;
      }
      const { xmlPath, objectName } = target_;
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { nodeKind: 'Catalog', label: objectName, xmlPath };
      const diff = service.getLockSnapshotDiff(target, node);
      assert.strictEqual(diff.hasSnapshot, false);
      assert.deepStrictEqual(service.restoreLockSnapshot(target, node), []);
    });

    test('Повторный захват объекта затирает старый снапшот', () => {
      const target_ = findFirstCatalogWithModule();
      if (!target_) {
        return;
      }
      const { xmlPath, modulePath, objectName } = target_;
      const target = service.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);

      const node = { nodeKind: 'Catalog', label: objectName, xmlPath };
      const originalModuleContent = fs.readFileSync(modulePath);
      try {
        service.captureLockSnapshot(target, node);
        // Правка "просачивается" в новый снапшот, снятый повторным захватом.
        fs.writeFileSync(modulePath, `${originalModuleContent.toString('utf-8')}\n// A\n`, 'utf-8');
        service.captureLockSnapshot(target, node);

        const diff = service.getLockSnapshotDiff(target, node);
        assert.deepStrictEqual(diff.changedFiles, [], 'Второй захват должен переснять снапшот с текущим содержимым.');

        service.discardLockSnapshot(target, node);
      } finally {
        fs.writeFileSync(modulePath, originalModuleContent);
      }
    });
  });

  test('resolveXmlPathByFullName — находит файл объекта в hierarchical- и flat-структуре, null для неизвестного', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-resolve-fullname-'));

    // Плоский вариант: <Папка>/<Имя>.xml (как в реальной выгрузке справочников).
    fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Номенклатура.xml'), '<MetaDataObject/>', 'utf-8');

    // Вложенный вариант: <Папка>/<Имя>/<Имя>.xml.
    fs.mkdirSync(path.join(configRoot, 'Documents', 'ЗаказПокупателя'), { recursive: true });
    fs.writeFileSync(
      path.join(configRoot, 'Documents', 'ЗаказПокупателя', 'ЗаказПокупателя.xml'),
      '<MetaDataObject/>',
      'utf-8'
    );

    assert.strictEqual(
      service.resolveXmlPathByFullName(configRoot, 'Справочник.Номенклатура'),
      path.join(configRoot, 'Catalogs', 'Номенклатура.xml')
    );
    assert.strictEqual(
      service.resolveXmlPathByFullName(configRoot, 'Документ.ЗаказПокупателя'),
      path.join(configRoot, 'Documents', 'ЗаказПокупателя', 'ЗаказПокупателя.xml')
    );
    assert.strictEqual(service.resolveXmlPathByFullName(configRoot, 'Справочник.НеСуществует'), null);
    assert.strictEqual(service.resolveXmlPathByFullName(configRoot, 'НеизвестныйТип.Что-то'), null);
    assert.strictEqual(service.resolveXmlPathByFullName(configRoot, 'БезТочки'), null);

    fs.rmSync(configRoot, { recursive: true, force: true });
  });

  test('resolveSubsystemMemberFullNames — раскрывает Content с переводом типа в русский fullName, рекурсивно по дочерним подсистемам', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-subsystem-members-'));
    fs.mkdirSync(path.join(configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница'), { recursive: true });

    // Content хранит английский префикс (Catalog/Document — MetaKind), а не русский
    // технический fullName хранилища — это и должен переводить resolveSubsystemMemberFullNames.
    fs.writeFileSync(
      path.join(configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', ['Catalog.Товары'], ['Розница']),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница', 'Розница.xml'),
      buildSubsystemXml('Розница', ['Document.ЗаказПокупателя'], []),
      'utf-8'
    );

    const subsystemXmlPath = path.join(configRoot, 'Subsystems', 'Продажи.xml');

    const nonRecursive = service.resolveSubsystemMemberFullNames(subsystemXmlPath, false);
    assert.deepStrictEqual(
      [...nonRecursive].sort(),
      ['Подсистема.Продажи', 'Справочник.Товары'].sort()
    );

    const recursive = service.resolveSubsystemMemberFullNames(subsystemXmlPath, true);
    assert.deepStrictEqual(
      [...recursive].sort(),
      ['Подсистема.Продажи', 'Справочник.Товары', 'Подсистема.Розница', 'Документ.ЗаказПокупателя'].sort()
    );

    fs.rmSync(configRoot, { recursive: true, force: true });
  });

  test('buildPartialDumpPlan — три ветки: корень целиком, рекурсивная Подсистема, обычный объект', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-partial-plan-'));
    fs.mkdirSync(path.join(configRoot, 'Subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', ['Catalog.Товары'], []),
      'utf-8'
    );

    // Захват корня конфигурации/расширения целиком — частичная выгрузка не имеет смысла.
    const rootPlan = service.buildPartialDumpPlan(
      { nodeKind: 'configuration' },
      { fullNames: ['__configuration_root__'] },
      true
    );
    assert.strictEqual(rootPlan.rootCaptureFull, true);
    assert.deepStrictEqual(rootPlan.fullNames, []);

    // Рекурсивный захват Подсистемы — состав раскрывается через resolveSubsystemMemberFullNames.
    const subsystemXmlPath = path.join(configRoot, 'Subsystems', 'Продажи.xml');
    const subsystemPlan = service.buildPartialDumpPlan(
      { nodeKind: 'Subsystem', xmlPath: subsystemXmlPath },
      { fullNames: ['Подсистема.Продажи'] },
      true
    );
    assert.strictEqual(subsystemPlan.rootCaptureFull, false);
    assert.deepStrictEqual([...subsystemPlan.fullNames].sort(), ['Подсистема.Продажи', 'Справочник.Товары'].sort());

    // Обычный объект (в т.ч. с recursive=true) — fullName узла достаточно как есть.
    const objectPlan = service.buildPartialDumpPlan(
      { nodeKind: 'Catalog', xmlPath: path.join(configRoot, 'Catalogs', 'Товары.xml') },
      { fullNames: ['Справочник.Товары'] },
      true
    );
    assert.strictEqual(objectPlan.rootCaptureFull, false);
    assert.deepStrictEqual(objectPlan.fullNames, ['Справочник.Товары']);

    fs.rmSync(configRoot, { recursive: true, force: true });
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

// Минимальный валидный XML подсистемы — тот же формат, что в subsystemXmlService.test.ts.
function buildSubsystemXml(name: string, refs: string[], childSubsystems: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MetaDataObject>
  <Subsystem>
    <Properties>
      <Name>${name}</Name>
      <Synonym/>
      ${refs.length > 0
        ? `<Content>${refs.map((ref) => `<xr:Item xsi:type="xr:MDObjectRef">${ref}</xr:Item>`).join('')}</Content>`
        : '<Content/>'}
    </Properties>
    ${childSubsystems.length > 0
      ? `<ChildObjects>${childSubsystems.map((child) => `<Subsystem>${child}</Subsystem>`).join('')}</ChildObjects>`
      : '<ChildObjects/>'}
  </Subsystem>
</MetaDataObject>`;
}

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
