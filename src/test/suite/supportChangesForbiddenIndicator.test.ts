/**
 * Issue #22: `MetadataTreeProvider.applySupportDecoration` и
 * `UniversalPanelViewProvider.buildStateIcons` обязаны различать ПРИЧИНУ
 * `SupportMode.Locked` — реальный запрет поддержки объекта (`-support2`) от
 * запрета изменений всей конфигурации флагом настроек поддержки
 * (`SupportInfoService.hasChangesForbidden`, дополнительный маркер
 * `-supportChangesForbidden` в `contextValue`).
 *
 * Заодно фиксирует РЕГРЕССИЮ идемпотентности: прежняя регулярка
 * `/-support\d$/` в `applySupportDecoration` была анкерена на конец строки и не
 * снимала суффикс поддержки, если после него уже дописаны суффиксы
 * подключённого хранилища (`applyRepositoryDecoration` выполняется ПОСЛЕ
 * `applySupportDecoration` в `getTreeItem`) — второй вызов `getTreeItem`
 * добавлял ВТОРОЙ `-support<n>`, не удаляя первый.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import { RepositoryService } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { UniversalPanelViewProvider } from '../../ui/views/universal/UniversalPanelViewProvider';
import { CHANGES_FORBIDDEN_TITLE, SUPPORT_CHANGES_FORBIDDEN_SUFFIX } from '../../ui/support/supportLockReason';
import { buildSupportFixtureRoot, EXAMPLE_CF_ROOTS, type SupportFixtureRoot } from './support/realConfigFixtures';

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

class TestLogger implements Logger {
  readonly messages: string[] = [];
  appendLine(message: string): void {
    this.messages.push(message);
  }
}

/** Фейковый SecretStore на Map — структурный контракт vscode.SecretStorage (см. metadataMutationServiceSupport.test.ts). */
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

/** Создаёт изолированный кэш-каталог для MetadataTreeProvider (не участвует в проверках — только требование конструктора). */
function makeCacheRoot(): { cacheRoot: string; dispose: () => void } {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-indicator-cache-'));
  return { cacheRoot, dispose: () => fs.rmSync(cacheRoot, { recursive: true, force: true }) };
}

function makeCatalogNode(label: string, xmlPath: string): MetadataNode {
  return new MetadataNode({ label, nodeKind: 'Catalog', xmlPath }, vscode.TreeItemCollapsibleState.None);
}

function makeDocumentNode(label: string, xmlPath: string): MetadataNode {
  return new MetadataNode({ label, nodeKind: 'Document', xmlPath }, vscode.TreeItemCollapsibleState.None);
}

/** Минимальные сервисы UniversalPanelViewProvider — нужен только приватный buildStateIcons. */
type UniversalServices = ConstructorParameters<typeof UniversalPanelViewProvider>[1];

function createUniversalPanelProvider(treeProvider: MetadataTreeProvider): UniversalPanelViewProvider {
  const services = {
    state: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    treeProvider,
    setTreeMessage: () => undefined,
    isProjectInitialized: () => true,
    getStandaloneServerStatus: () => ({ configured: false, state: 'stopped' }),
    refreshStandaloneServerStatus: () => Promise.resolve({ configured: false, state: 'stopped' }),
    getProcessingState: () => ({ active: false }),
    gitMetadataStatusService: {},
    refreshActionsView: () => undefined,
  } as unknown as UniversalServices;
  return new UniversalPanelViewProvider(vscode.Uri.file(EXTENSION_ROOT), services);
}

interface StateIconApi {
  buildStateIcons(node: MetadataNode): readonly { title: string; icon: { kind: string } }[];
}

function asStateIconApi(provider: UniversalPanelViewProvider): StateIconApi {
  return provider as unknown as StateIconApi;
}

/** Считает количество непересекающихся вхождений суффикса `-support<цифра>` в строке. */
function countSupportModeSuffixes(contextValue: string | undefined): number {
  return (contextValue ?? '').match(/-support\d/g)?.length ?? 0;
}

function countForbiddenMarkers(contextValue: string | undefined): number {
  return (contextValue ?? '').split(SUPPORT_CHANGES_FORBIDDEN_SUFFIX).length - 1;
}

interface ObjectCase {
  readonly label: string;
  readonly nodeKind: 'catalog' | 'document';
  readonly xmlPathOf: (fixture: SupportFixtureRoot) => string;
  /** Ожидаемый суффикс `-support<n>` ВНЕ запрета изменений (normal). */
  readonly normalSuffix: string;
}

const OBJECT_CASES: readonly ObjectCase[] = [
  { label: 'Контрагенты (a=2 → Removed вне запрета, issue #21)', nodeKind: 'catalog', xmlPathOf: (f) => f.kontragentyXmlPath, normalSuffix: '-support3' },
  { label: 'АвансовыйОтчетПрисоединенныеФайлы (a=0 → Locked вне запрета)', nodeKind: 'catalog', xmlPathOf: (f) => f.avansovyOtchetXmlPath, normalSuffix: '-support2' },
  { label: 'ПриходТовара (a=1 → Editable вне запрета)', nodeKind: 'document', xmlPathOf: (f) => f.prihodTovaraXmlPath, normalSuffix: '-support1' },
];

function makeNodeFor(kind: ObjectCase['nodeKind'], label: string, xmlPath: string): MetadataNode {
  return kind === 'catalog' ? makeCatalogNode(label, xmlPath) : makeDocumentNode(label, xmlPath);
}

suite('MetadataTreeProvider — applySupportDecoration различает запрет изменений поддержкой (issue #22)', () => {
  for (const objectCase of OBJECT_CASES) {
    test(`normal: ${objectCase.label} → ${objectCase.normalSuffix}, без маркера запрета изменений`, () => {
      const fixture = buildSupportFixtureRoot('normal');
      const { cacheRoot, dispose } = makeCacheRoot();
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
        try {
          const node = makeNodeFor(objectCase.nodeKind, objectCase.label, objectCase.xmlPathOf(fixture));
          const item = treeProvider.getTreeItem(node);

          assert.ok(
            (item.contextValue ?? '').includes(objectCase.normalSuffix),
            `contextValue должен содержать ${objectCase.normalSuffix}: ${String(item.contextValue)}`
          );
          assert.strictEqual(countForbiddenMarkers(item.contextValue), 0, 'вне запрета изменений маркер не ставится');
        } finally {
          treeProvider.dispose();
        }
      } finally {
        dispose();
        fixture.dispose();
      }
    });

    test(`forbidden: ${objectCase.label} → -support2 + маркер запрета изменений (независимо от исходного кода)`, () => {
      const fixture = buildSupportFixtureRoot('forbidden');
      const { cacheRoot, dispose } = makeCacheRoot();
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
        try {
          const node = makeNodeFor(objectCase.nodeKind, objectCase.label, objectCase.xmlPathOf(fixture));
          const item = treeProvider.getTreeItem(node);

          assert.ok(
            (item.contextValue ?? '').includes('-support2'),
            `при запрете изменений режим всегда Locked: ${String(item.contextValue)}`
          );
          assert.strictEqual(countSupportModeSuffixes(item.contextValue), 1, 'ровно один суффикс режима поддержки');
          assert.strictEqual(countForbiddenMarkers(item.contextValue), 1, 'ровно один маркер запрета изменений');

          const provider = createUniversalPanelProvider(treeProvider);
          try {
            const icons = asStateIconApi(provider).buildStateIcons(node);
            const supportIcon = icons.find((icon) => icon.title === CHANGES_FORBIDDEN_TITLE);
            assert.ok(
              supportIcon,
              `UniversalPanelViewProvider должен показать подсказку «${CHANGES_FORBIDDEN_TITLE}»: ${JSON.stringify(icons)}`
            );
          } finally {
            provider.dispose();
          }
        } finally {
          treeProvider.dispose();
        }
      } finally {
        dispose();
        fixture.dispose();
      }
    });
  }
});

suite('MetadataTreeProvider — applySupportDecoration идемпотентна (issue #22, регрессия накопления суффикса)', () => {
  test('повторный getTreeItem без подключённого хранилища не дублирует -support<n>', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    const { cacheRoot, dispose } = makeCacheRoot();
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
      try {
        const node = makeCatalogNode('Контрагенты', fixture.kontragentyXmlPath);

        const first = treeProvider.getTreeItem(node).contextValue;
        const second = treeProvider.getTreeItem(node).contextValue;

        assert.strictEqual(second, first, 'повторный вызов getTreeItem не должен менять contextValue');
        assert.strictEqual(countSupportModeSuffixes(second), 1);
        assert.strictEqual(countForbiddenMarkers(second), 1);
      } finally {
        treeProvider.dispose();
      }
    } finally {
      dispose();
      fixture.dispose();
    }
  });

  test('повторный getTreeItem С подключённым хранилищем не дублирует -support<n> (регрессия: раньше /-support\\d$/ не снимал суффикс перед -repo*)', async () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    const { cacheRoot, dispose } = makeCacheRoot();
    try {
      const secretStorage = new ProjectSecretStorage(createFakeSecretStore(), fixture.tempDir);
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const repositoryService = new RepositoryService(fixture.tempDir, secretStorage);
      const treeProvider = new MetadataTreeProvider(
        [],
        vscode.Uri.file(EXTENSION_ROOT),
        cacheRoot,
        undefined,
        supportService,
        repositoryService
      );
      try {
        const node = makeCatalogNode('Контрагенты', fixture.kontragentyXmlPath);
        // Подключаем узел к хранилищу БЕЗ локального захвата — воспроизводит
        // ветку applyRepositoryDecoration, добавляющую суффиксы ПОСЛЕ
        // -support<n>, из-за чего старая анкерная регулярка их не снимала.
        const target = repositoryService.resolveTargetByXmlPath(fixture.kontragentyXmlPath);
        assert.ok(target, 'должна резолвиться цель хранилища для справочника фикстуры');
        await repositoryService.saveBinding(target, {
          repoPath: '\\\\repo\\storage',
          repoUser: 'tester',
          repoPassword: 'secret',
        });
        repositoryService.setConnected(target, true);

        const first = treeProvider.getTreeItem(node).contextValue;
        const second = treeProvider.getTreeItem(node).contextValue;

        assert.strictEqual(second, first, 'повторный вызов getTreeItem не должен менять contextValue');
        assert.strictEqual(countSupportModeSuffixes(second), 1, `дублирование -support<n>: ${String(second)}`);
        assert.strictEqual(countForbiddenMarkers(second), 1, `дублирование маркера запрета изменений: ${String(second)}`);
      } finally {
        treeProvider.dispose();
      }
    } finally {
      dispose();
      fixture.dispose();
    }
  });

  test('переход forbidden → normal на одном и том же узле: маркер исчезает, Контрагенты получает -support3 (Removed, issue #21)', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    const { cacheRoot, dispose } = makeCacheRoot();
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
      try {
        const node = makeCatalogNode('Контрагенты', fixture.kontragentyXmlPath);

        const forbiddenContextValue = treeProvider.getTreeItem(node).contextValue;
        assert.strictEqual(countForbiddenMarkers(forbiddenContextValue), 1);
        assert.ok((forbiddenContextValue ?? '').includes('-support2'));

        // Тот же configRoot, но .bin перезаписан обычным (без флага) — реальный
        // сценарий снятия запрета изменений администратором поддержки.
        fs.copyFileSync(
          path.join(EXAMPLE_CF_ROOTS['2.21'], 'Ext', 'ParentConfigurations.bin'),
          path.join(fixture.configRoot, 'Ext', 'ParentConfigurations.bin')
        );
        supportService.loadConfig(fixture.configRoot);

        const normalContextValue = treeProvider.getTreeItem(node).contextValue;
        assert.strictEqual(countForbiddenMarkers(normalContextValue), 0, 'маркер запрета изменений должен исчезнуть');
        assert.strictEqual(countSupportModeSuffixes(normalContextValue), 1);
        assert.ok(
          (normalContextValue ?? '').includes('-support3'),
          `Контрагенты (a=2) вне запрета — SupportMode.Removed (issue #21): ${String(normalContextValue)}`
        );
      } finally {
        treeProvider.dispose();
      }
    } finally {
      dispose();
      fixture.dispose();
    }
  });
});

suite('MetadataTreeProvider — applySupportDecoration: ранние выходы без суффикса (issue #22)', () => {
  test('без supportService — contextValue не получает суффикс поддержки', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    const { cacheRoot, dispose } = makeCacheRoot();
    try {
      const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot);
      try {
        const node = makeCatalogNode('Контрагенты', fixture.kontragentyXmlPath);
        const item = treeProvider.getTreeItem(node);

        assert.strictEqual(countSupportModeSuffixes(item.contextValue), 0);
        assert.strictEqual(countForbiddenMarkers(item.contextValue), 0);
      } finally {
        treeProvider.dispose();
      }
    } finally {
      dispose();
      fixture.dispose();
    }
  });

  test('supportService есть, но .bin для этого корня не загружен (hasConfigData=false) — суффикса нет', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-indicator-no-bin-'));
    const { cacheRoot, dispose } = makeCacheRoot();
    try {
      const configRoot = path.join(tempDir, 'cf');
      fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
      fs.copyFileSync(
        path.join(EXAMPLE_CF_ROOTS['2.21'], 'Catalogs', 'Контрагенты.xml'),
        path.join(configRoot, 'Catalogs', 'Контрагенты.xml')
      );
      // ParentConfigurations.bin намеренно не создаётся — loadConfig не
      // зарегистрирует корень, hasConfigData(...) вернёт false.
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(configRoot);

      const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
      try {
        const node = makeCatalogNode('Контрагенты', path.join(configRoot, 'Catalogs', 'Контрагенты.xml'));
        const item = treeProvider.getTreeItem(node);

        assert.strictEqual(countSupportModeSuffixes(item.contextValue), 0);
        assert.strictEqual(countForbiddenMarkers(item.contextValue), 0);
      } finally {
        treeProvider.dispose();
      }
    } finally {
      dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
