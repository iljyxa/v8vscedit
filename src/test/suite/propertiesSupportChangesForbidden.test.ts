/**
 * Issue #22: при флаге «изменения запрещены» в `Ext/ParentConfigurations.bin`
 * панель свойств обязана отличать причину блокировки от обычного «объект на
 * поддержке» — новый `readonlyReason: 'supportChangesForbidden'` и отдельный
 * текст предупреждения при попытке изменить свойство. Ветвление живёт в двух
 * местах:
 *  а) `propertyEditLock.isChangesForbiddenBySupport(node, deps)` — чистый
 *     резолвер пути объекта-владельца (аналог `isEditLockedBySupport`);
 *  б) `PropertiesViewController.getViewState`/`handleWebviewMessage` — читают
 *     этот резолвер, чтобы выбрать `readonlyReason` и текст предупреждения.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { BasedOnXmlService } from '../../infra/xml/BasedOnXmlService';
import { ConfigurationXmlEditor } from '../../infra/xml/ConfigurationXmlEditor';
import { ExchangePlanContentService } from '../../infra/xml/ExchangePlanContentService';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import type { RepositoryService } from '../../infra/repository/RepositoryService';
import { MetadataNode } from '../../ui/tree/TreeNode';
import type { MetaTreeNodeContext } from '../../ui/tree/TreeNodeModel';
import { PropertiesViewController } from '../../ui/views/properties/PropertiesViewController';
import { TypeRegistryService } from '../../ui/views/properties/TypeRegistryService';
import {
  isChangesForbiddenBySupport,
  type PropertyEditLockDeps,
} from '../../ui/views/properties/propertyEditLock';
import { buildSupportFixtureRoot, type SupportFixtureRoot } from './support/realConfigFixtures';

class TestLogger implements Logger {
  readonly messages: string[] = [];
  appendLine(message: string): void {
    this.messages.push(message);
  }
}

/** Образец — propertiesViewControllerCharacterization.test.ts: createController/createController-хелперы. */
function createController(supportService?: SupportInfoService, repositoryService?: RepositoryService): PropertiesViewController {
  return new PropertiesViewController(
    new SubsystemXmlService(),
    new ExchangePlanContentService(),
    new TypeRegistryService(),
    new ConfigurationXmlEditor(),
    new BasedOnXmlService(),
    {
      refreshActiveView: () => undefined,
      replaceActiveNode: () => undefined,
    },
    supportService,
    repositoryService
  );
}

function makeNode(
  nodeKind: 'Catalog' | 'Document' | 'Attribute',
  label: string,
  xmlPath: string,
  metaContext?: MetaTreeNodeContext
): MetadataNode {
  return new MetadataNode({ label, nodeKind, xmlPath, metaContext }, vscode.TreeItemCollapsibleState.None);
}

interface ObjectCase {
  readonly label: string;
  readonly nodeKind: 'Catalog' | 'Document';
  readonly xmlPathOf: (fixture: SupportFixtureRoot) => string;
}

const OBJECT_CASES: readonly ObjectCase[] = [
  { label: 'Контрагенты (a=2)', nodeKind: 'Catalog', xmlPathOf: (f) => f.kontragentyXmlPath },
  { label: 'АвансовыйОтчетПрисоединенныеФайлы (a=0)', nodeKind: 'Catalog', xmlPathOf: (f) => f.avansovyOtchetXmlPath },
  { label: 'ПриходТовара (a=1)', nodeKind: 'Document', xmlPathOf: (f) => f.prihodTovaraXmlPath },
];

suite('propertyEditLock.isChangesForbiddenBySupport (issue #22)', () => {
  test('без deps.supportService → false', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const node = makeNode('Catalog', 'Контрагенты', fixture.kontragentyXmlPath);
      const deps: PropertyEditLockDeps = {};

      assert.strictEqual(isChangesForbiddenBySupport(node, deps), false);
    } finally {
      fixture.dispose();
    }
  });

  test('без xmlPath (и без metaContext.ownerObjectXmlPath) → false', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const node = new MetadataNode({ label: 'Без пути', nodeKind: 'Catalog' }, vscode.TreeItemCollapsibleState.None);

      assert.strictEqual(isChangesForbiddenBySupport(node, { supportService }), false);
    } finally {
      fixture.dispose();
    }
  });

  test('metaContext.ownerObjectXmlPath имеет приоритет над node.xmlPath', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      // xmlPath узла указывает на несуществующий файл — резолвер обязан
      // использовать ownerObjectXmlPath, а не сам xmlPath.
      const node = makeNode('Attribute', 'ИНН', '/nonexistent/Missing.xml', {
        rootMetaKind: 'Catalog',
        ownerObjectXmlPath: fixture.kontragentyXmlPath,
      });

      assert.strictEqual(isChangesForbiddenBySupport(node, { supportService }), true);
    } finally {
      fixture.dispose();
    }
  });

  for (const objectCase of OBJECT_CASES) {
    test(`forbidden: ${objectCase.label} → true`, () => {
      const fixture = buildSupportFixtureRoot('forbidden');
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const node = makeNode(objectCase.nodeKind, objectCase.label, objectCase.xmlPathOf(fixture));

        assert.strictEqual(isChangesForbiddenBySupport(node, { supportService }), true);
      } finally {
        fixture.dispose();
      }
    });

    test(`normal: ${objectCase.label} → false`, () => {
      const fixture = buildSupportFixtureRoot('normal');
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const node = makeNode(objectCase.nodeKind, objectCase.label, objectCase.xmlPathOf(fixture));

        assert.strictEqual(isChangesForbiddenBySupport(node, { supportService }), false);
      } finally {
        fixture.dispose();
      }
    });
  }
});

suite('PropertiesViewController.getViewState — readonlyReason при issue #22', () => {
  for (const objectCase of OBJECT_CASES) {
    test(`forbidden: ${objectCase.label} → readonly=true, readonlyReason='supportChangesForbidden'`, () => {
      const fixture = buildSupportFixtureRoot('forbidden');
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const controller = createController(supportService);
        const node = makeNode(objectCase.nodeKind, objectCase.label, objectCase.xmlPathOf(fixture));
        controller.setActiveNode(node);

        const state = controller.getViewState();

        assert.ok(state, 'getViewState не должен вернуть null для реального объекта фикстуры');
        assert.strictEqual(state.readonly, true);
        assert.strictEqual(state.readonlyReason, 'supportChangesForbidden');
      } finally {
        fixture.dispose();
      }
    });
  }

  test("normal: АвансовыйОтчетПрисоединенныеФайлы (a=0, Locked без флага) → readonly=true, readonlyReason='support'", () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const controller = createController(supportService);
      const node = makeNode('Catalog', 'АвансовыйОтчетПрисоединенныеФайлы', fixture.avansovyOtchetXmlPath);
      controller.setActiveNode(node);

      const state = controller.getViewState();

      assert.ok(state);
      assert.strictEqual(state.readonly, true);
      assert.strictEqual(state.readonlyReason, 'support');
    } finally {
      fixture.dispose();
    }
  });

  test('normal: ПриходТовара (a=1, Editable) → readonly=false, readonlyReason не задан', () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const controller = createController(supportService);
      const node = makeNode('Document', 'ПриходТовара', fixture.prihodTovaraXmlPath);
      controller.setActiveNode(node);

      const state = controller.getViewState();

      assert.ok(state);
      assert.strictEqual(state.readonly, false);
      assert.strictEqual(state.readonlyReason, undefined);
    } finally {
      fixture.dispose();
    }
  });

  test('normal: Контрагенты (a=2, снят с поддержки → Removed, issue #21) → readonly=false, readonlyReason не задан', () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const controller = createController(supportService);
      const node = makeNode('Catalog', 'Контрагенты', fixture.kontragentyXmlPath);
      controller.setActiveNode(node);

      const state = controller.getViewState();

      assert.ok(state);
      assert.strictEqual(state.readonly, false);
      assert.strictEqual(state.readonlyReason, undefined);
    } finally {
      fixture.dispose();
    }
  });
});

suite('PropertiesViewController.handleWebviewMessage(propertyChanged) — issue #22', () => {
  let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
  let warningCalls: unknown[][];
  const windowRef = vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage };

  setup(() => {
    warningCalls = [];
    originalShowWarningMessage = vscode.window.showWarningMessage;
    windowRef.showWarningMessage = ((message: string, ...rest: unknown[]) => {
      warningCalls.push([message, ...rest]);
      return Promise.resolve(undefined);
    });
  });

  teardown(() => {
    windowRef.showWarningMessage = originalShowWarningMessage;
  });

  test('forbidden: Контрагенты → новый текст, XML не изменён', async () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const controller = createController(supportService);
      const node = makeNode('Catalog', 'Контрагенты', fixture.kontragentyXmlPath);
      controller.setActiveNode(node);
      const xmlBefore = fs.readFileSync(fixture.kontragentyXmlPath, 'utf-8');

      await controller.handleWebviewMessage({ type: 'propertyChanged', key: 'Comment', value: 'новое значение' });

      assert.strictEqual(warningCalls.length, 1, `ожидалось ровно одно предупреждение: ${JSON.stringify(warningCalls)}`);
      assert.strictEqual(
        warningCalls[0][0],
        'Редактирование свойств запрещено: изменения конфигурации запрещены в настройках поддержки.'
      );
      assert.strictEqual(fs.readFileSync(fixture.kontragentyXmlPath, 'utf-8'), xmlBefore);
    } finally {
      fixture.dispose();
    }
  });

  test('normal: АвансовыйОтчетПрисоединенныеФайлы (a=0, Locked без флага) → прежний текст, XML не изменён', async () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const controller = createController(supportService);
      const node = makeNode('Catalog', 'АвансовыйОтчетПрисоединенныеФайлы', fixture.avansovyOtchetXmlPath);
      controller.setActiveNode(node);
      const xmlBefore = fs.readFileSync(fixture.avansovyOtchetXmlPath, 'utf-8');

      await controller.handleWebviewMessage({ type: 'propertyChanged', key: 'Comment', value: 'новое значение' });

      assert.strictEqual(warningCalls.length, 1, `ожидалось ровно одно предупреждение: ${JSON.stringify(warningCalls)}`);
      assert.strictEqual(warningCalls[0][0], 'Редактирование свойств запрещено поддержкой для этого объекта.');
      assert.strictEqual(fs.readFileSync(fixture.avansovyOtchetXmlPath, 'utf-8'), xmlBefore);
    } finally {
      fixture.dispose();
    }
  });
});
