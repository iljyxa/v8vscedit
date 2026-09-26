import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryService, isSubordinateUnitNode, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/**
 * Issue #45: `RepositoryService.resolveFullName` для узлов Form/Template обязан
 * возвращать fullName ЕДИНИЦЫ хранилища (`Справочник.Контрагенты.Форма.ФормаЭлемента`,
 * `…Макет.Y`), а не fullName владельца — иначе захват/освобождение конкретной формы
 * или макета напрямую (а не через владельца) записывает в state.json/Objects.xml
 * ошибочное имя. Остальные `CHILD_LIKE_KINDS` (Attribute/TabularSection/Command/
 * Dimension/Resource/EnumValue/Column/AddressingAttribute) по-прежнему резолвятся
 * через владельца — у них нет собственного XML верхнего уровня в ConfigDumpInfo/
 * хранилище (см. `RepositoryObjectNames.REPOSITORY_SUBORDINATE_LAYOUT`).
 *
 * Все фикстуры — реальная `example/2.21/src/cf` (см. CLAUDE.md TDD п.3): состав
 * форм/макетов/реквизитов снят вручную (см. отчёт test-writer), не выдуман.
 */

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

const EXAMPLE_CF_21 = path.resolve(__dirname, '../../../example/2.21/src/cf');

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  service: RepositoryService;
  dispose(): void;
}

/** Изолированная РЕАЛЬНАЯ копия example/2.21/src/cf — createObjectsFileForNode пишет файлы под workspaceRoot. */
function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-units-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.cpSync(EXAMPLE_CF_21, configRoot, { recursive: true });
  const service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  return { workspaceRoot, configRoot, service, dispose: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }) };
}

function ownerXmlPath(harness: Harness, folder: string, name: string): string {
  const xmlPath = path.join(harness.configRoot, folder, `${name}.xml`);
  assert.ok(fs.existsSync(xmlPath), `ожидался реальный объект фикстуры ${folder}/${name}.xml`);
  return xmlPath;
}

function formNode(harness: Harness, folder: string, ownerName: string, formLabel: string | undefined, rootMetaKind = 'Catalog'): RepositoryNodeRef {
  const xmlPath = ownerXmlPath(harness, folder, ownerName);
  return {
    nodeKind: 'Form',
    label: formLabel,
    xmlPath,
    metaContext: { rootMetaKind, ownerObjectXmlPath: xmlPath },
  };
}

function templateNode(harness: Harness, folder: string, ownerName: string, templateLabel: string | undefined, rootMetaKind: string): RepositoryNodeRef {
  const xmlPath = ownerXmlPath(harness, folder, ownerName);
  return {
    nodeKind: 'Template',
    label: templateLabel,
    xmlPath,
    metaContext: { rootMetaKind, ownerObjectXmlPath: xmlPath },
  };
}

suite('RepositoryService.resolveFullName — единицы Form/Template (issue #45)', () => {
  const formCases: readonly { readonly folder: string; readonly owner: string; readonly form: string; readonly expected: string }[] = [
    { folder: 'Catalogs', owner: 'Контрагенты', form: 'ФормаЭлемента', expected: 'Справочник.Контрагенты.Форма.ФормаЭлемента' },
    { folder: 'Catalogs', owner: 'Контрагенты', form: 'ФормаСписка', expected: 'Справочник.Контрагенты.Форма.ФормаСписка' },
    { folder: 'Catalogs', owner: 'ПричиныВозврата', form: 'ФормаЭлемента', expected: 'Справочник.ПричиныВозврата.Форма.ФормаЭлемента' },
    { folder: 'Catalogs', owner: 'РолиКонтактныхЛиц', form: 'ФормаЭлемента', expected: 'Справочник.РолиКонтактныхЛиц.Форма.ФормаЭлемента' },
  ];

  for (const { folder, owner, form, expected } of formCases) {
    test(`Form "${form}" на ${folder}/${owner} → "${expected}" (не fullName владельца)`, () => {
      const harness = createHarness();
      try {
        const node = formNode(harness, folder, owner, form);
        assert.strictEqual(harness.service.resolveFullName(node), expected);
      } finally {
        harness.dispose();
      }
    });
  }

  const templateCases: readonly { readonly folder: string; readonly owner: string; readonly rootMetaKind: string; readonly template: string; readonly expected: string }[] = [
    { folder: 'Catalogs', owner: 'Контрагенты', rootMetaKind: 'Catalog', template: 'ЗагрузкаИзФайла', expected: 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла' },
    { folder: 'DataProcessors', owner: 'Обработка1', rootMetaKind: 'DataProcessor', template: 'Макет', expected: 'Обработка.Обработка1.Макет.Макет' },
    { folder: 'Documents', owner: 'АвансовыйОтчет', rootMetaKind: 'Document', template: 'Макет', expected: 'Документ.АвансовыйОтчет.Макет.Макет' },
    { folder: 'Reports', owner: 'Запасы', rootMetaKind: 'Report', template: 'ОсновнаяСхемаКомпоновкиДанных', expected: 'Отчет.Запасы.Макет.ОсновнаяСхемаКомпоновкиДанных' },
    { folder: 'Reports', owner: 'ПраваДоступа', rootMetaKind: 'Report', template: 'МакетПараметров', expected: 'Отчет.ПраваДоступа.Макет.МакетПараметров' },
  ];

  for (const { folder, owner, rootMetaKind, template, expected } of templateCases) {
    test(`Template "${template}" на ${folder}/${owner} → "${expected}"`, () => {
      const harness = createHarness();
      try {
        const node = templateNode(harness, folder, owner, template, rootMetaKind);
        assert.strictEqual(harness.service.resolveFullName(node), expected);
      } finally {
        harness.dispose();
      }
    });
  }
});

suite('RepositoryService.resolveFullName — прочие CHILD_LIKE_KINDS остаются владельцем (issue #45, регресс)', () => {
  test('Attribute "ИНН" на Контрагенты → fullName владельца', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Catalogs', 'Контрагенты');
      const node: RepositoryNodeRef = { nodeKind: 'Attribute', label: 'ИНН', xmlPath, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: xmlPath } };
      assert.strictEqual(harness.service.resolveFullName(node), 'Справочник.Контрагенты');
    } finally {
      harness.dispose();
    }
  });

  test('TabularSection "КонтактныеЛица" на Контрагенты → fullName владельца', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Catalogs', 'Контрагенты');
      const node: RepositoryNodeRef = { nodeKind: 'TabularSection', label: 'КонтактныеЛица', xmlPath, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: xmlPath } };
      assert.strictEqual(harness.service.resolveFullName(node), 'Справочник.Контрагенты');
    } finally {
      harness.dispose();
    }
  });

  test('Command "Покупатели" на Контрагенты → fullName владельца', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Catalogs', 'Контрагенты');
      const node: RepositoryNodeRef = { nodeKind: 'Command', label: 'Покупатели', xmlPath, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: xmlPath } };
      assert.strictEqual(harness.service.resolveFullName(node), 'Справочник.Контрагенты');
    } finally {
      harness.dispose();
    }
  });

  test('Dimension "Владелец" и Resource "Значение" на РегистрСведений.КонтактнаяИнформация → fullName владельца', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'InformationRegisters', 'КонтактнаяИнформация');
      const dimensionNode: RepositoryNodeRef = { nodeKind: 'Dimension', label: 'Владелец', xmlPath, metaContext: { rootMetaKind: 'InformationRegister', ownerObjectXmlPath: xmlPath } };
      const resourceNode: RepositoryNodeRef = { nodeKind: 'Resource', label: 'Значение', xmlPath, metaContext: { rootMetaKind: 'InformationRegister', ownerObjectXmlPath: xmlPath } };
      assert.strictEqual(harness.service.resolveFullName(dimensionNode), 'РегистрСведений.КонтактнаяИнформация');
      assert.strictEqual(harness.service.resolveFullName(resourceNode), 'РегистрСведений.КонтактнаяИнформация');
    } finally {
      harness.dispose();
    }
  });

  test('EnumValue "ЗначениеПеречисления1" на Перечисление.PushУведомления → fullName владельца', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Enums', 'PushУведомления');
      const node: RepositoryNodeRef = { nodeKind: 'EnumValue', label: 'ЗначениеПеречисления1', xmlPath, metaContext: { rootMetaKind: 'Enum', ownerObjectXmlPath: xmlPath } };
      assert.strictEqual(harness.service.resolveFullName(node), 'Перечисление.PushУведомления');
    } finally {
      harness.dispose();
    }
  });

  test('Column "Цена" в ТЧ "Товары" документа ПриходТовара → fullName владельца (tabularSectionName не влияет)', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Documents', 'ПриходТовара');
      const node: RepositoryNodeRef = {
        nodeKind: 'Column',
        label: 'Цена',
        xmlPath,
        metaContext: { rootMetaKind: 'Document', tabularSectionName: 'Товары', ownerObjectXmlPath: xmlPath },
      };
      assert.strictEqual(harness.service.resolveFullName(node), 'Документ.ПриходТовара');
    } finally {
      harness.dispose();
    }
  });
});

suite('RepositoryService.resolveFullName — CommonForm/CommonTemplate без изменений (issue #45, регресс)', () => {
  test('CommonForm "АЛКОВводРеквизитовОП" → "ОбщаяФорма.АЛКОВводРеквизитовОП"', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'CommonForms', 'АЛКОВводРеквизитовОП');
      const node: RepositoryNodeRef = { nodeKind: 'CommonForm', label: 'АЛКОВводРеквизитовОП', xmlPath };
      assert.strictEqual(harness.service.resolveFullName(node), 'ОбщаяФорма.АЛКОВводРеквизитовОП');
    } finally {
      harness.dispose();
    }
  });

  test('CommonTemplate "Макет" → "ОбщийМакет.Макет"', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'CommonTemplates', 'Макет');
      const node: RepositoryNodeRef = { nodeKind: 'CommonTemplate', label: 'Макет', xmlPath };
      assert.strictEqual(harness.service.resolveFullName(node), 'ОбщийМакет.Макет');
    } finally {
      harness.dispose();
    }
  });
});

suite('RepositoryService.resolveFullName — guard-ветки Form/Template (issue #45)', () => {
  test('Form без label → null (без fallback на имя владельца)', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Catalogs', 'Контрагенты');
      const node: RepositoryNodeRef = { nodeKind: 'Form', xmlPath, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: xmlPath } };
      assert.strictEqual(harness.service.resolveFullName(node), null);
    } finally {
      harness.dispose();
    }
  });

  test('Template без label → null', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Catalogs', 'Контрагенты');
      const node: RepositoryNodeRef = { nodeKind: 'Template', xmlPath, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: xmlPath } };
      assert.strictEqual(harness.service.resolveFullName(node), null);
    } finally {
      harness.dispose();
    }
  });

  test('Form без metaContext.ownerObjectXmlPath → null', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Catalogs', 'Контрагенты');
      const node: RepositoryNodeRef = { nodeKind: 'Form', label: 'ФормаЭлемента', xmlPath };
      assert.strictEqual(harness.service.resolveFullName(node), null);
    } finally {
      harness.dispose();
    }
  });

  test('Form с ownerObjectXmlPath на несуществующий файл внутри временной копии → null', () => {
    const harness = createHarness();
    try {
      const missingOwnerXml = path.join(harness.configRoot, 'Catalogs', 'НетТакогоСправочника.xml');
      const node: RepositoryNodeRef = {
        nodeKind: 'Form',
        label: 'ФормаЭлемента',
        xmlPath: missingOwnerXml,
        metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: missingOwnerXml },
      };
      assert.strictEqual(harness.service.resolveFullName(node), null);
    } finally {
      harness.dispose();
    }
  });
});

suite('RepositoryService.createObjectsFileForNode — единицы Form/Template (issue #45)', () => {
  const matrix: readonly { readonly label: string; readonly node: (h: Harness) => RepositoryNodeRef; readonly expectedFullName: string }[] = [
    { label: 'Form', node: (h) => formNode(h, 'Catalogs', 'Контрагенты', 'ФормаЭлемента'), expectedFullName: 'Справочник.Контрагенты.Форма.ФормаЭлемента' },
    { label: 'Template', node: (h) => templateNode(h, 'Catalogs', 'Контрагенты', 'ЗагрузкаИзФайла', 'Catalog'), expectedFullName: 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла' },
  ];

  for (const { label, node: buildNode, expectedFullName } of matrix) {
    for (const recursive of [false, true]) {
      test(`${label} × recursive=${String(recursive)}: точная строка Object, fullNames=[единица], без <Subsystem>, файл под .v8vscedit/repository/objects`, () => {
        const harness = createHarness();
        try {
          const result = harness.service.createObjectsFileForNode(buildNode(harness), recursive);

          assert.deepStrictEqual(result.fullNames, [expectedFullName]);
          assert.strictEqual(
            path.dirname(result.filePath),
            path.join(harness.workspaceRoot, '.v8vscedit', 'repository', 'objects')
          );

          const content = fs.readFileSync(result.filePath, 'utf-8');
          assert.ok(
            content.includes(`<Object fullName="${expectedFullName}" includeChildObjects="${recursive ? 'true' : 'false'}">`),
            `ожидалась точная строка <Object fullName="${expectedFullName}" includeChildObjects="${String(recursive)}">, получено: ${content}`
          );
          assert.ok(!content.includes('<Subsystem'), 'Form/Template — не Subsystem, тега <Subsystem не должно быть.');
        } finally {
          harness.dispose();
        }
      });
    }
  }

  test('Form без label → бросает «Для выбранного узла не удалось сформировать полное имя объекта.»', () => {
    const harness = createHarness();
    try {
      const xmlPath = ownerXmlPath(harness, 'Catalogs', 'Контрагенты');
      const node: RepositoryNodeRef = { nodeKind: 'Form', xmlPath, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: xmlPath } };
      assert.throws(
        () => harness.service.createObjectsFileForNode(node, false),
        /Для выбранного узла не удалось сформировать полное имя объекта\./
      );
    } finally {
      harness.dispose();
    }
  });
});

/**
 * Issue #46: `isSubordinateUnitNode` — единая точка определения «узел это
 * ПОДЧИНЁННАЯ ЕДИНИЦА хранилища со своим XML верхнего уровня» (Form/Template
 * с `metaContext.ownerObjectXmlPath`), которую используют и дерево
 * (`MetadataTreeProvider.resolveRepositoryState`), и панель свойств
 * (`resolveRepositoryEditProbePath`). Признак редактируемости такого узла
 * обязан считаться по захвату САМОЙ единицы, а не владельца (нерекурсивный
 * захват владельца её не захватывает — issue #45).
 */
suite('RepositoryService.isSubordinateUnitNode — issue #46', () => {
  test('Form c ownerObjectXmlPath → true', () => {
    assert.strictEqual(
      isSubordinateUnitNode({ nodeKind: 'Form', metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: '/tmp/x.xml' } }),
      true
    );
  });

  test('Template c ownerObjectXmlPath → true', () => {
    assert.strictEqual(
      isSubordinateUnitNode({ nodeKind: 'Template', metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: '/tmp/x.xml' } }),
      true
    );
  });

  test('Form без metaContext → false', () => {
    assert.strictEqual(isSubordinateUnitNode({ nodeKind: 'Form' }), false);
  });

  test('Form с metaContext, но без ownerObjectXmlPath → false', () => {
    assert.strictEqual(
      isSubordinateUnitNode({ nodeKind: 'Form', metaContext: { rootMetaKind: 'Catalog' } }),
      false
    );
  });

  test('Template без metaContext → false', () => {
    assert.strictEqual(isSubordinateUnitNode({ nodeKind: 'Template' }), false);
  });

  test('nodeKind undefined → false', () => {
    assert.strictEqual(isSubordinateUnitNode({ metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: '/tmp/x.xml' } }), false);
  });

  const nonSubordinateKinds = [
    'CommonForm',
    'CommonTemplate',
    'Subsystem',
    'Attribute',
    'TabularSection',
    'Command',
    'Column',
    'Catalog',
  ] as const;

  for (const kind of nonSubordinateKinds) {
    test(`${kind} c ownerObjectXmlPath → false (не подчинённая единица со своим XML)`, () => {
      assert.strictEqual(
        isSubordinateUnitNode({ nodeKind: kind, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: '/tmp/x.xml' } }),
        false
      );
    });
  }
});
