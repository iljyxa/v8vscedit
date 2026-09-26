import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findConfigurations } from '../../infra/fs/ConfigLocator';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { MetadataNode } from '../../ui/tree/TreeNode';
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

/**
 * Issue #46: `resolveRepositoryState` для узлов Form/Template с собственным
 * XML верхнего уровня (`isSubordinateUnitNode`) обязан считать
 * `-repoEditRestricted`/`-repoEditAllowed` по захвату САМОЙ единицы, а не
 * владельца — иначе форма/макет, которую владелец не захватывал (или наоборот,
 * захватил только сам), в UI ошибочно показывались бы редактируемыми/
 * защищёнными по чужому состоянию.
 *
 * Матрица режимов M1–M5 воспроизводит `RepositoryLockState.applyLock`/
 * `applyUnlock` буквально, а не через вычисленные ожидания — так расхождение
 * с `RepositoryLockState.isLocked` (правило предка старой записи, группы,
 * `recursiveRoot`) остаётся видимым в самом тесте.
 */
function editSuffix(contextValue: string | undefined): 'restricted' | 'allowed' | 'none' {
  if ((contextValue ?? '').includes('-repoEditRestricted')) {
    return 'restricted';
  }
  if ((contextValue ?? '').includes('-repoEditAllowed')) {
    return 'allowed';
  }
  return 'none';
}

interface UnitNodes {
  readonly owner: MetadataNode;
  readonly formaElementa: MetadataNode;
  readonly formaSpiska: MetadataNode;
  readonly maket: MetadataNode;
  readonly attribute: MetadataNode;
  readonly formsGroup: MetadataNode;
}

function findUnitNodes(harness: Harness): UnitNodes {
  const allNodes = collectAllNodes(harness.treeProvider);
  const owner = findByKindAndLabel(allNodes, 'Catalog', 'Контрагенты');
  const ownerChildren = collectAllNodes(harness.treeProvider, owner);
  const formaElementa = findByKindAndLabel(ownerChildren, 'Form', 'ФормаЭлемента');
  const formaSpiska = findByKindAndLabel(ownerChildren, 'Form', 'ФормаСписка');
  const maket = findByKindAndLabel(ownerChildren, 'Template', 'ЗагрузкаИзФайла');
  const attribute = ownerChildren.find((n) => n.nodeKind === 'Attribute');
  assert.ok(attribute, 'у Контрагенты должен быть хотя бы один реальный реквизит.');
  const formsGroup = ownerChildren.find((n) => n.nodeKind === 'group-type' && nodeLabel(n) === 'Формы');
  assert.ok(formsGroup, 'у Контрагенты должна быть группа узлов «Формы».');
  return { owner, formaElementa, formaSpiska, maket, attribute, formsGroup };
}

function refreshAll(harness: Harness, nodes: UnitNodes): void {
  const list: readonly MetadataNode[] = [nodes.owner, nodes.formaElementa, nodes.formaSpiska, nodes.maket, nodes.attribute, nodes.formsGroup];
  for (const node of list) {
    harness.treeProvider.getTreeItem(node);
  }
}

const OWNER = 'Справочник.Контрагенты';
const FORMA_ELEMENTA = 'Справочник.Контрагенты.Форма.ФормаЭлемента';
const FORMA_SPISKA = 'Справочник.Контрагенты.Форма.ФормаСписка';
const MAKET = 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла';

suite('MetadataTreeProvider — -repoEditRestricted/-repoEditAllowed для единиц Form/Template по своему захвату (issue #46)', () => {
  test('M1: захват ТОЛЬКО владельца (mode:"object") — формы/макет restricted+unlocked, владелец allowed+locked, реквизит/группа «Формы» allowed', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: OWNER, members: [OWNER], mode: 'object' });

      const nodes = findUnitNodes(harness);
      refreshAll(harness, nodes);

      assert.strictEqual(editSuffix(nodes.formaElementa.contextValue), 'restricted');
      assert.strictEqual(contextSuffix(nodes.formaElementa.contextValue), 'unlocked');
      assert.strictEqual(editSuffix(nodes.formaSpiska.contextValue), 'restricted');
      assert.strictEqual(contextSuffix(nodes.formaSpiska.contextValue), 'unlocked');
      assert.strictEqual(editSuffix(nodes.maket.contextValue), 'restricted');
      assert.strictEqual(contextSuffix(nodes.maket.contextValue), 'unlocked');
      assert.strictEqual(editSuffix(nodes.owner.contextValue), 'allowed');
      assert.strictEqual(contextSuffix(nodes.owner.contextValue), 'locked');
      assert.strictEqual(editSuffix(nodes.attribute.contextValue), 'allowed');
      assert.strictEqual(editSuffix(nodes.formsGroup.contextValue), 'allowed');
      assert.strictEqual(contextSuffix(nodes.formsGroup.contextValue), 'none', 'у группы узлов не бывает признака захвата.');
    } finally {
      harness.dispose();
    }
  });

  test('M2: рекурсивный захват владельца и всех единиц (mode:"recursive") — все четыре allowed+locked', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      harness.repositoryService.lockState.applyLock(harness.target, {
        anchor: OWNER,
        members: [OWNER, FORMA_ELEMENTA, FORMA_SPISKA, MAKET],
        mode: 'recursive',
      });

      const nodes = findUnitNodes(harness);
      refreshAll(harness, nodes);

      for (const node of [nodes.owner, nodes.formaElementa, nodes.formaSpiska, nodes.maket]) {
        assert.strictEqual(editSuffix(node.contextValue), 'allowed', `узел ${node.nodeKind} должен быть allowed: ${String(node.contextValue)}`);
        assert.strictEqual(contextSuffix(node.contextValue), 'locked', `узел ${node.nodeKind} должен быть locked: ${String(node.contextValue)}`);
      }
    } finally {
      harness.dispose();
    }
  });

  test('M3: старая запись владельца без mode (правило предка) — формы/макет allowed+locked через RepositoryLockState.isLocked, владелец allowed+locked', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      // Без `mode` — совместимость со старыми записями state.json (issue #45).
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: OWNER, members: [OWNER] });

      const nodes = findUnitNodes(harness);
      refreshAll(harness, nodes);

      assert.strictEqual(
        harness.repositoryService.lockState.isLocked(harness.target, FORMA_ELEMENTA),
        true,
        'правило предка обязано покрывать форму записью владельца без mode.'
      );
      assert.strictEqual(
        harness.repositoryService.lockState.isLocked(harness.target, MAKET),
        true
      );

      for (const node of [nodes.owner, nodes.formaElementa, nodes.formaSpiska, nodes.maket]) {
        assert.strictEqual(editSuffix(node.contextValue), 'allowed', `узел ${node.nodeKind} должен быть allowed: ${String(node.contextValue)}`);
        assert.strictEqual(contextSuffix(node.contextValue), 'locked', `узел ${node.nodeKind} должен быть locked: ${String(node.contextValue)}`);
      }
    } finally {
      harness.dispose();
    }
  });

  test('M4: захват ТОЛЬКО формы ФормаЭлемента (mode:"object") — она allowed; владелец, соседняя форма, макет, реквизит, группа «Формы» restricted', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: FORMA_ELEMENTA, members: [FORMA_ELEMENTA], mode: 'object' });

      const nodes = findUnitNodes(harness);
      refreshAll(harness, nodes);

      assert.strictEqual(editSuffix(nodes.formaElementa.contextValue), 'allowed');
      assert.strictEqual(contextSuffix(nodes.formaElementa.contextValue), 'locked');
      assert.strictEqual(editSuffix(nodes.owner.contextValue), 'restricted');
      assert.strictEqual(editSuffix(nodes.formaSpiska.contextValue), 'restricted');
      assert.strictEqual(contextSuffix(nodes.formaSpiska.contextValue), 'unlocked');
      assert.strictEqual(editSuffix(nodes.maket.contextValue), 'restricted');
      assert.strictEqual(editSuffix(nodes.attribute.contextValue), 'restricted');
      assert.strictEqual(editSuffix(nodes.formsGroup.contextValue), 'restricted');
    } finally {
      harness.dispose();
    }
  });

  test('M5: рекурсивный захват (M2), затем нерекурсивная отмена ТОЛЬКО владельца — владелец restricted+unlocked, формы/макет остаются allowed+locked', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      harness.repositoryService.lockState.applyLock(harness.target, {
        anchor: OWNER,
        members: [OWNER, FORMA_ELEMENTA, FORMA_SPISKA, MAKET],
        mode: 'recursive',
      });
      harness.repositoryService.lockState.applyUnlock(harness.target, {
        anchor: OWNER,
        members: [OWNER],
        recursive: false,
        isRoot: false,
      });

      const nodes = findUnitNodes(harness);
      refreshAll(harness, nodes);

      assert.strictEqual(editSuffix(nodes.owner.contextValue), 'restricted');
      assert.strictEqual(contextSuffix(nodes.owner.contextValue), 'unlocked');
      for (const node of [nodes.formaElementa, nodes.formaSpiska, nodes.maket]) {
        assert.strictEqual(editSuffix(node.contextValue), 'allowed', `узел ${node.nodeKind} должен остаться allowed: ${String(node.contextValue)}`);
        assert.strictEqual(contextSuffix(node.contextValue), 'locked', `узел ${node.nodeKind} должен остаться locked: ${String(node.contextValue)}`);
      }
    } finally {
      harness.dispose();
    }
  });

  test('CommonForm захвачена напрямую (mode:"object") — -repoEditAllowed (регресс, CommonForm вне isSubordinateUnitNode)', async () => {
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

      assert.strictEqual(editSuffix(commonForm.contextValue), 'allowed');
    } finally {
      harness.dispose();
    }
  });

  test('Отключено (setConnected(false)): форма получает только -repoDisconnected, без -repoEdit*/-repoLocked/-repoUnlocked', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, false);
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: FORMA_ELEMENTA, members: [FORMA_ELEMENTA], mode: 'object' });

      const nodes = findUnitNodes(harness);
      harness.treeProvider.getTreeItem(nodes.formaElementa);

      assert.ok(nodes.formaElementa.contextValue?.includes('-repoDisconnected'));
      assert.strictEqual(editSuffix(nodes.formaElementa.contextValue), 'none');
      assert.strictEqual(contextSuffix(nodes.formaElementa.contextValue), 'none');
    } finally {
      harness.dispose();
    }
  });

  test('Guard: узел Form без label (ручная сборка поверх реального ownerObjectXmlPath) — restricted, без суффикса захвата (resolveFullName не может собрать имя единицы)', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);

      const nodes = findUnitNodes(harness);
      const ownerXmlPath = nodes.owner.xmlPath;
      assert.ok(ownerXmlPath, 'у Контрагенты должен быть реальный xmlPath.');
      const brokenForm = new MetadataNode(
        {
          label: '',
          nodeKind: 'Form',
          metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXmlPath },
        },
        vscode.TreeItemCollapsibleState.None
      );

      harness.treeProvider.getTreeItem(brokenForm);

      assert.strictEqual(editSuffix(brokenForm.contextValue), 'restricted', `ожидался -repoEditRestricted (safe default), получено: ${String(brokenForm.contextValue)}`);
      assert.strictEqual(contextSuffix(brokenForm.contextValue), 'none', 'resolveFullName не может собрать имя единицы без label — суффикса захвата быть не должно.');
    } finally {
      harness.dispose();
    }
  });

  test('Повторный getTreeItem после смены режима (M1 → M4) не накапливает суффиксы -repoEdit*/-repoLocked/-repoUnlocked', async () => {
    const harness = createHarness();
    try {
      await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
      harness.repositoryService.setConnected(harness.target, true);
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: OWNER, members: [OWNER], mode: 'object' });

      const nodes = findUnitNodes(harness);
      harness.treeProvider.getTreeItem(nodes.formaElementa);
      assert.strictEqual(editSuffix(nodes.formaElementa.contextValue), 'restricted');

      harness.repositoryService.lockState.applyUnlock(harness.target, { anchor: OWNER, members: [OWNER], recursive: false, isRoot: false });
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: FORMA_ELEMENTA, members: [FORMA_ELEMENTA], mode: 'object' });
      harness.treeProvider.getTreeItem(nodes.formaElementa);

      const value = nodes.formaElementa.contextValue ?? '';
      assert.strictEqual(editSuffix(value), 'allowed');
      assert.strictEqual(contextSuffix(value), 'locked');
      assert.strictEqual(countOccurrences(value, '-repoEditAllowed'), 1);
      assert.strictEqual(countOccurrences(value, '-repoEditRestricted'), 0);
      assert.strictEqual(countOccurrences(value, '-repoLocked'), 1);
      assert.strictEqual(countOccurrences(value, '-repoUnlocked'), 0);
      assert.strictEqual(countOccurrences(value, '-repoConnected'), 1);
    } finally {
      harness.dispose();
    }
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
