import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { getHandlerForNode } from '../../ui/tree/nodeBuilders';
import {
  isEditLockedByRepository,
  resolveEditLockReason,
  resolveRepositoryEditProbePath,
  type PropertyEditLockDeps,
} from '../../ui/views/properties/propertyEditLock';
import { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { ExchangePlanContentService } from '../../infra/xml/ExchangePlanContentService';
import { TypeRegistryService } from '../../ui/views/properties/TypeRegistryService';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { BasedOnXmlService } from '../../infra/xml/BasedOnXmlService';

/**
 * Issue #46: панель свойств проверяет захват формы/макета по САМОЙ единице
 * хранилища, а не по владельцу. `isEditLockedByRepository` резолвит XML-файл
 * узла через `resolveRepositoryEditProbePath` и передаёт его в
 * `RepositoryService.isEditRestricted` — метод уже unit-aware по относительному
 * пути файла (issue #45), поэтому единственный необходимый фикс здесь — дать
 * ему НАСТОЯЩИЙ путь единицы (`Forms/ФормаЭлемента.xml`), а не путь владельца
 * (`metaContext.ownerObjectXmlPath`), который раньше подставлялся напрямую и
 * лишал `isEditRestricted` информации о вложенности.
 *
 * Фикстура — реальная временная копия `example/2.21/src/cf` (CLAUDE.md TDD п.3).
 */

const EXAMPLE_CF_21 = path.resolve(__dirname, '../../../example/2.21/src/cf');

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  dispose(): void;
}

function createHarness(): Harness {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-propedit-')));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(path.dirname(configRoot), { recursive: true });
  fs.cpSync(EXAMPLE_CF_21, configRoot, { recursive: true });
  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };
  return {
    workspaceRoot,
    configRoot,
    target,
    repositoryService,
    dispose: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

async function bindAndConnect(harness: Harness): Promise<void> {
  await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
  harness.repositoryService.setConnected(harness.target, true);
}

const OWNER = 'Справочник.Контрагенты';
const FORMA_ELEMENTA = 'Справочник.Контрагенты.Форма.ФормаЭлемента';

function ownerXmlPath(harness: Harness): string {
  return path.join(harness.configRoot, 'Catalogs', 'Контрагенты.xml');
}

/** Узел Form, поле xmlPath которого совпадает с production-раскладкой MetadataCache (см. `resolveLeafXmlPath`: для Form узел получает xmlPath владельца). */
function formNode(harness: Harness, formLabel: string): MetadataNode {
  const owner = ownerXmlPath(harness);
  return new MetadataNode(
    { label: formLabel, nodeKind: 'Form', xmlPath: owner, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: owner } },
    vscode.TreeItemCollapsibleState.None
  );
}

function templateNode(harness: Harness, templateLabel: string): MetadataNode {
  const owner = ownerXmlPath(harness);
  const ownXml = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Templates', `${templateLabel}.xml`);
  return new MetadataNode(
    { label: templateLabel, nodeKind: 'Template', xmlPath: ownXml, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: owner } },
    vscode.TreeItemCollapsibleState.None
  );
}

function attributeNode(harness: Harness, attributeLabel: string): MetadataNode {
  const owner = ownerXmlPath(harness);
  return new MetadataNode(
    { label: attributeLabel, nodeKind: 'Attribute', xmlPath: owner, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: owner } },
    vscode.TreeItemCollapsibleState.None
  );
}

function catalogNode(harness: Harness): MetadataNode {
  return new MetadataNode(
    { label: 'Контрагенты', nodeKind: 'Catalog', xmlPath: ownerXmlPath(harness) },
    vscode.TreeItemCollapsibleState.None
  );
}

function commonFormNode(harness: Harness): MetadataNode {
  return new MetadataNode(
    { label: 'АЛКОВводРеквизитовОП', nodeKind: 'CommonForm', xmlPath: path.join(harness.configRoot, 'CommonForms', 'АЛКОВводРеквизитовОП.xml') },
    vscode.TreeItemCollapsibleState.None
  );
}

// ─── 1. resolveRepositoryEditProbePath ──────────────────────────────────────

suite('resolveRepositoryEditProbePath — issue #46', () => {
  test('Form → путь единицы Forms/ФормаЭлемента.xml (не путь владельца)', () => {
    const harness = createHarness();
    try {
      const node = formNode(harness, 'ФормаЭлемента');
      const expected = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml');
      assert.ok(fs.existsSync(expected), 'фикстура должна содержать реальный Forms/ФормаЭлемента.xml.');
      assert.strictEqual(resolveRepositoryEditProbePath(node), expected);
    } finally {
      harness.dispose();
    }
  });

  test('Template → путь единицы Templates/ЗагрузкаИзФайла.xml', () => {
    const harness = createHarness();
    try {
      const node = templateNode(harness, 'ЗагрузкаИзФайла');
      const expected = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Templates', 'ЗагрузкаИзФайла.xml');
      assert.ok(fs.existsSync(expected), 'фикстура должна содержать реальный Templates/ЗагрузкаИзФайла.xml.');
      assert.strictEqual(resolveRepositoryEditProbePath(node), expected);
    } finally {
      harness.dispose();
    }
  });

  test('Attribute → XML владельца (не подчинённая единица со своим XML)', () => {
    const harness = createHarness();
    try {
      const node = attributeNode(harness, 'ИНН');
      assert.strictEqual(resolveRepositoryEditProbePath(node), ownerXmlPath(harness));
    } finally {
      harness.dispose();
    }
  });

  test('Catalog (корневой объект, без metaContext) → собственный xmlPath', () => {
    const harness = createHarness();
    try {
      const node = catalogNode(harness);
      assert.strictEqual(resolveRepositoryEditProbePath(node), ownerXmlPath(harness));
    } finally {
      harness.dispose();
    }
  });

  test('CommonForm (без metaContext) → собственный xmlPath', () => {
    const harness = createHarness();
    try {
      const node = commonFormNode(harness);
      assert.strictEqual(resolveRepositoryEditProbePath(node), node.xmlPath);
    } finally {
      harness.dispose();
    }
  });

  test('Form в копии с удалённым Forms/ФормаСписка.xml → откат на XML владельца (нет дескриптора единицы)', () => {
    const harness = createHarness();
    try {
      const flatXml = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаСписка.xml');
      assert.ok(fs.existsSync(flatXml));
      fs.rmSync(flatXml);
      const node = formNode(harness, 'ФормаСписка');
      assert.strictEqual(resolveRepositoryEditProbePath(node), ownerXmlPath(harness));
    } finally {
      harness.dispose();
    }
  });

  test('Узел без xmlPath и без metaContext → undefined', () => {
    const node = new MetadataNode({ label: 'X', nodeKind: 'Attribute' }, vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(resolveRepositoryEditProbePath(node), undefined);
  });
});

// ─── 2. isEditLockedByRepository/resolveEditLockReason — матрица M1–M5 ──────

type LockMode = 'M1' | 'M2' | 'M3' | 'M4' | 'M5';

function applyMode(harness: Harness, mode: LockMode): void {
  const FORMA_SPISKA = 'Справочник.Контрагенты.Форма.ФормаСписка';
  const MAKET = 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла';
  switch (mode) {
    case 'M1':
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: OWNER, members: [OWNER], mode: 'object' });
      break;
    case 'M2':
      harness.repositoryService.lockState.applyLock(harness.target, {
        anchor: OWNER,
        members: [OWNER, FORMA_ELEMENTA, FORMA_SPISKA, MAKET],
        mode: 'recursive',
      });
      break;
    case 'M3':
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: OWNER, members: [OWNER] });
      break;
    case 'M4':
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: FORMA_ELEMENTA, members: [FORMA_ELEMENTA], mode: 'object' });
      break;
    case 'M5':
      harness.repositoryService.lockState.applyLock(harness.target, {
        anchor: OWNER,
        members: [OWNER, FORMA_ELEMENTA, FORMA_SPISKA, MAKET],
        mode: 'recursive',
      });
      harness.repositoryService.lockState.applyUnlock(harness.target, { anchor: OWNER, members: [OWNER], recursive: false, isRoot: false });
      break;
  }
}

/** Ожидание editRestricted (== isEditLockedByRepository) для ФормаЭлемента по режиму — зеркало матрицы дерева (issue #46). */
const FORMA_ELEMENTA_EXPECTATION: Record<LockMode, boolean> = {
  M1: true,
  M2: false,
  M3: false,
  M4: false,
  M5: false,
};

/** Владелец (Catalog) не является подчинённой единицей — блокировка считается по-старому, по своему собственному захвату. */
const OWNER_EXPECTATION: Record<LockMode, boolean> = {
  M1: false,
  M2: false,
  M3: false,
  M4: true,
  M5: true,
};

/** Attribute адресуется владельцем (CHILD_LIKE, но не подчинённая единица со своим XML). */
const ATTRIBUTE_EXPECTATION: Record<LockMode, boolean> = OWNER_EXPECTATION;

/**
 * Макет «ЗагрузкаИзФайла» ни в одном режиме не входит в захват НАПРЯМУЮ, кроме
 * рекурсивной группы M2/M5 — в отличие от ФормаЭлемента, которую в M4 захватывают
 * персонально. Поэтому в M4 макет остаётся заблокированным (в отличие от формы).
 */
const MAKET_EXPECTATION: Record<LockMode, boolean> = {
  M1: true,
  M2: false,
  M3: false,
  M4: true,
  M5: false,
};

const MODES: readonly LockMode[] = ['M1', 'M2', 'M3', 'M4', 'M5'];

suite('isEditLockedByRepository — матрица M1–M5 × {Catalog, Form, Template, Attribute} (issue #46)', () => {
  for (const mode of MODES) {
    test(`${mode}: Form ФормаЭлемента → editLocked=${String(FORMA_ELEMENTA_EXPECTATION[mode])}`, async () => {
      const harness = createHarness();
      try {
        await bindAndConnect(harness);
        applyMode(harness, mode);
        const deps: PropertyEditLockDeps = { repositoryService: harness.repositoryService };
        const node = formNode(harness, 'ФормаЭлемента');
        assert.strictEqual(isEditLockedByRepository(node, deps), FORMA_ELEMENTA_EXPECTATION[mode]);
        assert.strictEqual(resolveEditLockReason(node, deps), FORMA_ELEMENTA_EXPECTATION[mode] ? 'repository' : undefined);
      } finally {
        harness.dispose();
      }
    });

    test(`${mode}: Catalog Контрагенты (владелец) → editLocked=${String(OWNER_EXPECTATION[mode])}`, async () => {
      const harness = createHarness();
      try {
        await bindAndConnect(harness);
        applyMode(harness, mode);
        const deps: PropertyEditLockDeps = { repositoryService: harness.repositoryService };
        const node = catalogNode(harness);
        assert.strictEqual(isEditLockedByRepository(node, deps), OWNER_EXPECTATION[mode]);
      } finally {
        harness.dispose();
      }
    });

    test(`${mode}: Template ЗагрузкаИзФайла → editLocked=${String(MAKET_EXPECTATION[mode])}`, async () => {
      const harness = createHarness();
      try {
        await bindAndConnect(harness);
        applyMode(harness, mode);
        const deps: PropertyEditLockDeps = { repositoryService: harness.repositoryService };
        const node = templateNode(harness, 'ЗагрузкаИзФайла');
        assert.strictEqual(isEditLockedByRepository(node, deps), MAKET_EXPECTATION[mode]);
      } finally {
        harness.dispose();
      }
    });

    test(`${mode}: Attribute (владелец) → editLocked=${String(ATTRIBUTE_EXPECTATION[mode])}`, async () => {
      const harness = createHarness();
      try {
        await bindAndConnect(harness);
        applyMode(harness, mode);
        const deps: PropertyEditLockDeps = { repositoryService: harness.repositoryService };
        const node = attributeNode(harness, 'ИНН');
        assert.strictEqual(isEditLockedByRepository(node, deps), ATTRIBUTE_EXPECTATION[mode]);
      } finally {
        harness.dispose();
      }
    });
  }

  test('без repositoryService → всегда false', () => {
    const harness = createHarness();
    try {
      const node = formNode(harness, 'ФормаЭлемента');
      assert.strictEqual(isEditLockedByRepository(node, {}), false);
      assert.strictEqual(resolveEditLockReason(node, {}), undefined);
    } finally {
      harness.dispose();
    }
  });
});

suite('isEditLockedByRepository — хранилище отключено (issue #46, регресс)', () => {
  test('привязано, но setConnected(false) → editLocked=false', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, false);
      const deps: PropertyEditLockDeps = { repositoryService: harness.repositoryService };
      const node = formNode(harness, 'ФормаЭлемента');
      assert.strictEqual(isEditLockedByRepository(node, deps), false);
    } finally {
      harness.dispose();
    }
  });
});

// ─── 3. Интеграция через PropertiesViewController ───────────────────────────

function createController(repositoryService: RepositoryService): PropertiesViewController {
  return new PropertiesViewController(
    new SubsystemXmlService(),
    new ExchangePlanContentService(),
    new TypeRegistryService(),
    new ConfigurationXmlEditor(),
    new BasedOnXmlService(),
    { refreshActiveView: () => undefined, replaceActiveNode: () => undefined },
    undefined,
    repositoryService
  );
}

suite('PropertiesViewController — isEditLockedByRepository через buildRenderContext/handleWebviewMessage (issue #46)', () => {
  test('M1 (захвачен только владелец): isEditLockedByRepository=true на форме, правка Comment НЕ применяется, файл формы не изменился', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      applyMode(harness, 'M1');
      const controller = createController(harness.repositoryService);
      const node = formNode(harness, 'ФормаЭлемента');
      const handler = getHandlerForNode(node);
      assert.ok(handler && typeof handler.getProperties === 'function', 'у узла Form должен быть обработчик со свойствами (structuredMetaChildHandler).');
      const properties = handler.getProperties(node);
      assert.ok(properties.some((p) => p.key === 'Comment'), 'схема формы должна содержать свойство Comment.');

      const context = controller.buildRenderContext(node, properties);
      assert.strictEqual(context.isEditLockedByRepository, true);

      const formXmlPath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml');
      const before = fs.readFileSync(formXmlPath, 'utf-8');
      await controller.handleWebviewMessage({ type: 'propertyChanged', key: 'Comment', value: 'issue-46' });
      assert.strictEqual(fs.readFileSync(formXmlPath, 'utf-8'), before, 'запись при editLockedByRepository=true запрещена — файл не должен измениться.');
    } finally {
      harness.dispose();
    }
  });

  test('M4 (захвачена сама форма): isEditLockedByRepository=false, правка Comment применяется — файл формы изменяется', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      applyMode(harness, 'M4');
      const controller = createController(harness.repositoryService);
      const node = formNode(harness, 'ФормаЭлемента');
      const handler = getHandlerForNode(node);
      assert.ok(handler && typeof handler.getProperties === 'function');
      const properties = handler.getProperties(node);

      const context = controller.buildRenderContext(node, properties);
      assert.strictEqual(context.isEditLockedByRepository, false);

      const formXmlPath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml');
      const before = fs.readFileSync(formXmlPath, 'utf-8');
      await controller.handleWebviewMessage({ type: 'propertyChanged', key: 'Comment', value: 'issue-46' });
      assert.notStrictEqual(fs.readFileSync(formXmlPath, 'utf-8'), before, 'при editLockedByRepository=false правка обязана примениться к файлу формы.');
    } finally {
      harness.dispose();
    }
  });
});
