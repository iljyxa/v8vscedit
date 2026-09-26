import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findConfigurations } from '../../infra/fs/ConfigLocator';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/**
 * Issue #45, раздел D: `MetadataTreeProvider.resolveRepositoryLockState` вызывает
 * `RepositoryService.resolveFullName(element)` для решения `-repoLocked`/
 * `-repoUnlocked` в `contextValue` узла. До исправления `resolveFullName` для
 * узлов Form/Template отдавал fullName ВЛАДЕЛЬЦА — состояние захвата ФОРМЫ
 * фактически подменялось состоянием захвата ЕЁ ВЛАДЕЛЬЦА в дереве (индикатор
 * замка на форме не совпадал с реальным локальным захватом самой формы).
 *
 * Узлы берутся через РЕАЛЬНЫЙ `getChildren()` (не строятся вручную) — на
 * временной копии `example/2.21/src/cf`, чтобы `metaContext.ownerObjectXmlPath`
 * и раскладка узлов совпадали с тем, что видит настоящий навигатор.
 */

const EXAMPLE_CF_21 = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

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
  treeProvider: MetadataTreeProvider;
  dispose(): void;
}

function createHarness(): Harness {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-tree-units-')));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(path.dirname(configRoot), { recursive: true });
  fs.cpSync(EXAMPLE_CF_21, configRoot, { recursive: true });

  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const entries = findConfigurations(workspaceRoot);
  assert.ok(entries.length > 0, 'findConfigurations должен найти скопированную выгрузку.');
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-tree-units-cache-'));
  const treeProvider = new MetadataTreeProvider(entries, vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, undefined, repositoryService);
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };

  return {
    workspaceRoot, configRoot, target, repositoryService, treeProvider,
    dispose: () => {
      treeProvider.dispose();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    },
  };
}

function nodeLabel(node: MetadataNode): string | undefined {
  return typeof node.label === 'string' ? node.label : node.label?.label;
}

/** Обходит ВСЕ узлы дерева (реальный getChildren, лениво раскрывая каждый уровень). */
function collectAllNodes(treeProvider: MetadataTreeProvider, node?: MetadataNode): MetadataNode[] {
  const children = treeProvider.getChildren(node);
  const result: MetadataNode[] = [...children];
  for (const child of children) {
    result.push(...collectAllNodes(treeProvider, child));
  }
  return result;
}

function findByKindAndLabel(nodes: readonly MetadataNode[], nodeKind: string, label: string): MetadataNode {
  const found = nodes.find((n) => n.nodeKind === nodeKind && nodeLabel(n) === label);
  assert.ok(found, `узел ${nodeKind} "${label}" не найден среди ${String(nodes.length)} узлов дерева.`);
  return found;
}

function contextSuffix(contextValue: string | undefined): 'locked' | 'unlocked' | 'none' {
  if ((contextValue ?? '').includes('-repoLocked')) {
    return 'locked';
  }
  if ((contextValue ?? '').includes('-repoUnlocked')) {
    return 'unlocked';
  }
  return 'none';
}

suite('MetadataTreeProvider — decorations -repoLocked/-repoUnlocked для Form/Template (issue #45)', () => {
  test('Захват ТОЛЬКО формы (mode:"object"): форма -repoLocked; владелец, соседняя форма и макет -repoUnlocked', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      harness.repositoryService.lockState.applyLock(harness.target, {
        anchor: 'Справочник.Контрагенты.Форма.ФормаЭлемента',
        members: ['Справочник.Контрагенты.Форма.ФормаЭлемента'],
        mode: 'object',
      });

      const allNodes = collectAllNodes(harness.treeProvider);
      const owner = findByKindAndLabel(allNodes, 'Catalog', 'Контрагенты');
      const formaElementa = findByKindAndLabel(collectAllNodes(harness.treeProvider, owner), 'Form', 'ФормаЭлемента');
      const formaSpiska = findByKindAndLabel(collectAllNodes(harness.treeProvider, owner), 'Form', 'ФормаСписка');
      const maket = findByKindAndLabel(collectAllNodes(harness.treeProvider, owner), 'Template', 'ЗагрузкаИзФайла');

      harness.treeProvider.getTreeItem(owner);
      harness.treeProvider.getTreeItem(formaElementa);
      harness.treeProvider.getTreeItem(formaSpiska);
      harness.treeProvider.getTreeItem(maket);

      assert.strictEqual(contextSuffix(formaElementa.contextValue), 'locked', `ожидался -repoLocked на форме, получено: ${String(formaElementa.contextValue)}`);
      assert.strictEqual(contextSuffix(owner.contextValue), 'unlocked', `владелец не захвачен: ${String(owner.contextValue)}`);
      assert.strictEqual(contextSuffix(formaSpiska.contextValue), 'unlocked', `соседняя форма не захвачена: ${String(formaSpiska.contextValue)}`);
      assert.strictEqual(contextSuffix(maket.contextValue), 'unlocked', `макет не захвачен: ${String(maket.contextValue)}`);
    } finally {
      harness.dispose();
    }
  });

  test('Рекурсивный захват группы владельца: владелец, обе формы и макет — все -repoLocked', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      const members = [
        'Справочник.Контрагенты',
        'Справочник.Контрагенты.Форма.ФормаЭлемента',
        'Справочник.Контрагенты.Форма.ФормаСписка',
        'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла',
      ];
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Контрагенты', members, mode: 'recursive' });

      const allNodes = collectAllNodes(harness.treeProvider);
      const owner = findByKindAndLabel(allNodes, 'Catalog', 'Контрагенты');
      const ownerChildren = collectAllNodes(harness.treeProvider, owner);
      const formaElementa = findByKindAndLabel(ownerChildren, 'Form', 'ФормаЭлемента');
      const formaSpiska = findByKindAndLabel(ownerChildren, 'Form', 'ФормаСписка');
      const maket = findByKindAndLabel(ownerChildren, 'Template', 'ЗагрузкаИзФайла');

      for (const node of [owner, formaElementa, formaSpiska, maket]) {
        harness.treeProvider.getTreeItem(node);
      }

      assert.strictEqual(contextSuffix(owner.contextValue), 'locked');
      assert.strictEqual(contextSuffix(formaElementa.contextValue), 'locked');
      assert.strictEqual(contextSuffix(formaSpiska.contextValue), 'locked');
      assert.strictEqual(contextSuffix(maket.contextValue), 'locked');
    } finally {
      harness.dispose();
    }
  });

  test('CommonForm: захват ОбщаяФорма.АЛКОВводРеквизитовОП напрямую — узел -repoLocked (регресс, CommonForm не является CHILD_LIKE_KINDS)', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      harness.repositoryService.lockState.applyLock(harness.target, {
        anchor: 'ОбщаяФорма.АЛКОВводРеквизитовОП',
        members: ['ОбщаяФорма.АЛКОВводРеквизитовОП'],
        mode: 'object',
      });

      const allNodes = collectAllNodes(harness.treeProvider);
      const commonForm = findByKindAndLabel(allNodes, 'CommonForm', 'АЛКОВводРеквизитовОП');
      harness.treeProvider.getTreeItem(commonForm);

      assert.strictEqual(contextSuffix(commonForm.contextValue), 'locked', `ожидался -repoLocked, получено: ${String(commonForm.contextValue)}`);
    } finally {
      harness.dispose();
    }
  });
});
