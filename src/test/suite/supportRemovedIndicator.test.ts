/**
 * Issue #21: отдельный режим поддержки «снят с поддержки» (код `a=2` в
 * `ParentConfigurations.bin`) — `SupportMode.Removed`, а не бывший `None`.
 * Объект остаётся редактируемым (как и раньше — это НЕ регрессия), но UI
 * обязан визуально отличать его от объекта, вообще не входящего в поставку
 * (реальный `None`): отдельный суффикс `contextValue` (`-support3`), отдельная
 * иконка (`support-removed`) и отдельная подсказка (`SUPPORT_REMOVED_TITLE`).
 *
 * Под флагом «изменения запрещены» (`hasChangesForbidden`) режим Removed не
 * показывается вовсе — всё становится `Locked` с маркером запрета изменений
 * (см. `supportChangesForbiddenIndicator.test.ts`), это проверяется здесь же
 * как регрессия по всем четырём объектам.
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
import { CHANGES_FORBIDDEN_TITLE, SUPPORT_REMOVED_TITLE } from '../../ui/support/supportLockReason';
import { buildSupportFixtureRoot, type SupportFixtureRoot } from './support/realConfigFixtures';

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

class TestLogger implements Logger {
  readonly messages: string[] = [];
  appendLine(message: string): void {
    this.messages.push(message);
  }
}

/** Фейковый SecretStore на Map — структурный контракт vscode.SecretStorage (см. supportChangesForbiddenIndicator.test.ts). */
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
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-removed-cache-'));
  return { cacheRoot, dispose: () => fs.rmSync(cacheRoot, { recursive: true, force: true }) };
}

function makeNode(nodeKind: 'Catalog' | 'Document', label: string, xmlPath: string): MetadataNode {
  return new MetadataNode({ label, nodeKind, xmlPath }, vscode.TreeItemCollapsibleState.None);
}

/** Минимальные сервисы UniversalPanelViewProvider — нужны только приватные buildStateIcons/toDto. */
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
    // toDto резолвит git-статус через resolveGitStatus → gitMetadataStatusService.getStatus;
    // в этих тестах git-декорации не проверяются — стаб всегда «нет статуса».
    gitMetadataStatusService: { getStatus: () => undefined },
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

interface DtoApi {
  toDto(node: MetadataNode, depth: number, id: string, parentKey: string): { supportMode?: string };
}

function asDtoApi(provider: UniversalPanelViewProvider): DtoApi {
  return provider as unknown as DtoApi;
}

/** Считает количество непересекающихся вхождений суффикса `-support<цифра>` в строке. */
function countSupportModeSuffixes(contextValue: string | undefined): number {
  return (contextValue ?? '').match(/-support\d/g)?.length ?? 0;
}

interface RemovedCase {
  readonly label: string;
  readonly nodeKind: 'Catalog' | 'Document';
  readonly xmlPathOf: (fixture: SupportFixtureRoot) => string;
  /** Ожидаемый суффикс `-support<n>` ВНЕ запрета изменений (normal). */
  readonly normalSuffix: string;
  /** Ожидаемое значение TreeNodeDto.supportMode ВНЕ запрета изменений (normal). */
  readonly normalSupportModeDto: 'none' | 'editable' | 'locked' | 'removed';
  /** Ожидаемая подсказка индикатора ВНЕ запрета изменений (normal). */
  readonly normalHintTitle: string;
}

const REMOVED_CASES: readonly RemovedCase[] = [
  {
    label: 'Контрагенты (a=2 → Removed)',
    nodeKind: 'Catalog',
    xmlPathOf: (f) => f.kontragentyXmlPath,
    normalSuffix: '-support3',
    normalSupportModeDto: 'removed',
    normalHintTitle: SUPPORT_REMOVED_TITLE,
  },
  {
    label: 'АвансовыйОтчетПрисоединенныеФайлы (a=0 → Locked)',
    nodeKind: 'Catalog',
    xmlPathOf: (f) => f.avansovyOtchetXmlPath,
    normalSuffix: '-support2',
    normalSupportModeDto: 'locked',
    normalHintTitle: 'На поддержке, редактирование запрещено',
  },
  {
    label: 'ПриходТовара (a=1 → Editable)',
    nodeKind: 'Document',
    xmlPathOf: (f) => f.prihodTovaraXmlPath,
    normalSuffix: '-support1',
    normalSupportModeDto: 'editable',
    normalHintTitle: 'На поддержке, редактирование разрешено',
  },
  {
    label: 'СобственныйСправочник (синтетический, вне поставки → None)',
    nodeKind: 'Catalog',
    xmlPathOf: (f) => f.unlistedCatalogXmlPath,
    normalSuffix: '-support0',
    normalSupportModeDto: 'none',
    normalHintTitle: 'Не на поддержке',
  },
];

suite('MetadataTreeProvider/UniversalPanelViewProvider — режим Removed (issue #21)', () => {
  for (const removedCase of REMOVED_CASES) {
    test(`normal: ${removedCase.label} → contextValue ${removedCase.normalSuffix}, ровно один суффикс, без маркера запрета`, () => {
      const fixture = buildSupportFixtureRoot('normal');
      const { cacheRoot, dispose } = makeCacheRoot();
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
        try {
          const node = makeNode(removedCase.nodeKind, removedCase.label, removedCase.xmlPathOf(fixture));
          const item = treeProvider.getTreeItem(node);

          assert.ok(
            (item.contextValue ?? '').includes(removedCase.normalSuffix),
            `contextValue должен содержать ${removedCase.normalSuffix}: ${String(item.contextValue)}`
          );
          assert.strictEqual(countSupportModeSuffixes(item.contextValue), 1, 'ровно один суффикс режима поддержки');
          assert.ok(!(item.contextValue ?? '').includes('supportChangesForbidden'), 'вне запрета изменений маркер не ставится');
        } finally {
          treeProvider.dispose();
        }
      } finally {
        dispose();
        fixture.dispose();
      }
    });

    test(`normal: ${removedCase.label} → подсказка «${removedCase.normalHintTitle}»`, () => {
      const fixture = buildSupportFixtureRoot('normal');
      const { cacheRoot, dispose } = makeCacheRoot();
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
        try {
          const node = makeNode(removedCase.nodeKind, removedCase.label, removedCase.xmlPathOf(fixture));
          treeProvider.getTreeItem(node);

          const provider = createUniversalPanelProvider(treeProvider);
          try {
            const icons = asStateIconApi(provider).buildStateIcons(node);
            const supportIcon = icons.find((icon) => icon.title === removedCase.normalHintTitle);
            assert.ok(
              supportIcon,
              `Ожидалась подсказка «${removedCase.normalHintTitle}»: ${JSON.stringify(icons)}`
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

    test(`normal: ${removedCase.label} → toDto(...).supportMode === '${removedCase.normalSupportModeDto}'`, () => {
      const fixture = buildSupportFixtureRoot('normal');
      const { cacheRoot, dispose } = makeCacheRoot();
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
        try {
          const node = makeNode(removedCase.nodeKind, removedCase.label, removedCase.xmlPathOf(fixture));
          const provider = createUniversalPanelProvider(treeProvider);
          try {
            const dto = asDtoApi(provider).toDto(node, 0, 'n0', '');
            assert.strictEqual(dto.supportMode, removedCase.normalSupportModeDto);
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

    test(`forbidden: ${removedCase.label} → -support2 + маркер запрета изменений, подсказка «${CHANGES_FORBIDDEN_TITLE}», toDto.supportMode === 'locked'`, () => {
      const fixture = buildSupportFixtureRoot('forbidden');
      const { cacheRoot, dispose } = makeCacheRoot();
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const treeProvider = new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, supportService);
        try {
          const node = makeNode(removedCase.nodeKind, removedCase.label, removedCase.xmlPathOf(fixture));
          const item = treeProvider.getTreeItem(node);

          assert.ok(
            (item.contextValue ?? '').includes('-support2'),
            `при запрете изменений режим всегда Locked (не Removed): ${String(item.contextValue)}`
          );
          assert.strictEqual(countSupportModeSuffixes(item.contextValue), 1, 'ровно один суффикс режима поддержки');
          assert.ok((item.contextValue ?? '').includes('supportChangesForbidden'), 'ожидался маркер запрета изменений');

          const provider = createUniversalPanelProvider(treeProvider);
          try {
            const icons = asStateIconApi(provider).buildStateIcons(node);
            const supportIcon = icons.find((icon) => icon.title === CHANGES_FORBIDDEN_TITLE);
            assert.ok(supportIcon, `Ожидалась подсказка «${CHANGES_FORBIDDEN_TITLE}»: ${JSON.stringify(icons)}`);

            const dto = asDtoApi(provider).toDto(node, 0, 'n0', '');
            assert.strictEqual(dto.supportMode, 'locked');
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

  test('идемпотентность: повторный getTreeItem Контрагентов с подключённым хранилищем даёт ровно один -support3 (Removed)', async () => {
    const fixture = buildSupportFixtureRoot('normal');
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
        const node = makeNode('Catalog', 'Контрагенты', fixture.kontragentyXmlPath);
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
        assert.ok((second ?? '').includes('-support3'), `ожидался -support3 (Removed): ${String(second)}`);
      } finally {
        treeProvider.dispose();
      }
    } finally {
      dispose();
      fixture.dispose();
    }
  });
});
