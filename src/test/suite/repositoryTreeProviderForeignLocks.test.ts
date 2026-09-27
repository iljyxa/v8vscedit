import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findConfigurations } from '../../infra/fs/ConfigLocator';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { createLockWorkspace, lockFixturePath, must, type LockWorkspace } from './support/repositoryLockFixtures';

/**
 * Декорация дерева по статусам захвата с сервера (issue #6): копия example/2.21, реальный
 * файловый опрос фикстуры хранилища 8.5.1 под пользователем Admin. Узлы — из настоящего
 * `getChildren()`, декорация — из `getTreeItem()`.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

interface TreeHarness {
  ws: LockWorkspace;
  treeProvider: MetadataTreeProvider;
  dispose(): void;
}

async function createTree(): Promise<TreeHarness> {
  const ws = await createLockWorkspace({ repoPath: lockFixturePath('8.5.1'), repoUser: 'Admin', repoPassword: '' });
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-foreign-tree-cache-'));
  const treeProvider = new MetadataTreeProvider(findConfigurations(ws.workspaceRoot), vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, undefined, ws.service);
  return {
    ws,
    treeProvider,
    dispose: () => {
      treeProvider.dispose();
      ws.dispose();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    },
  };
}

function label(node: MetadataNode): string {
  return typeof node.label === 'string' ? node.label : String(node.label?.label);
}

/** Узел по цепочке меток от корня (реальный getChildren на каждом уровне). */
function findPath(treeProvider: MetadataTreeProvider, ...labels: string[]): MetadataNode {
  let node: MetadataNode | undefined;
  for (const wanted of labels) {
    const children = treeProvider.getChildren(node);
    node = must(children.find((child) => label(child) === wanted), `${wanted} среди ${children.map(label).join(', ')}`);
  }
  return must(node, labels.join('/'));
}

function decorate(treeProvider: MetadataTreeProvider, node: MetadataNode): MetadataNode {
  treeProvider.getTreeItem(node);
  return node;
}

suite('MetadataTreeProvider — чужие захваты с сервера (issue #6)', () => {
  let harness: TreeHarness;
  setup(async () => {
    harness = await createTree();
    const result = await harness.ws.service.lockStatus.syncTarget(harness.ws.target);
    assert.strictEqual(result.status, 'synced');
  });
  teardown(() => harness.dispose());

  test('Банки: -repoUnlocked-repoForeignLocked, без -repoLocked, правка запрещена, подсказка держателя', () => {
    const { treeProvider } = harness;
    const root = decorate(treeProvider, findPath(treeProvider, 'ТорговыйУчет'));
    const catalogs = findPath(treeProvider, 'ТорговыйУчет', 'Справочники');
    const banks = decorate(treeProvider, must(treeProvider.getChildren(catalogs).find((node) => label(node) === 'Банки'), 'Банки'));
    const context = String(banks.contextValue);
    assert.ok(context.includes('-repoUnlocked-repoForeignLocked'), context);
    assert.ok(!context.includes('-repoLocked'), context);
    assert.ok(context.includes('-repoEditRestricted'), context);
    assert.match(String(banks.repositoryLockTitle), /^Захвачено: Petrov, \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/);
    assert.ok(String(root.contextValue).includes('-repoForeignLocked'), String(root.contextValue));
    assert.match(String(root.repositoryLockTitle), /^Захвачено: Petrov, /);
  });

  test('форма и макет Контрагентов — чужие, сам справочник и ФормаСписка — свои вне проекта', () => {
    const { treeProvider } = harness;
    const kontragenty = decorate(treeProvider, findPath(treeProvider, 'ТорговыйУчет', 'Справочники', 'Контрагенты'));
    const nested = (kind: string, name: string): MetadataNode => {
      const queue = [...treeProvider.getChildren(kontragenty)];
      for (let node = queue.shift(); node; node = queue.shift()) {
        if (node.nodeKind === kind && label(node) === name) {
          return decorate(treeProvider, node);
        }
        queue.push(...treeProvider.getChildren(node));
      }
      throw new Error(`нет ${kind} ${name}`);
    };
    for (const node of [nested('Form', 'ФормаЭлемента'), nested('Template', 'ЗагрузкаИзФайла')]) {
      assert.ok(String(node.contextValue).includes('-repoForeignLocked'), String(node.contextValue));
      assert.match(String(node.repositoryLockTitle), /^Захвачено: Petrov/);
    }
    for (const node of [kontragenty, nested('Form', 'ФормаСписка')]) {
      assert.ok(String(node.contextValue).includes('-repoUnlocked'), String(node.contextValue));
      assert.ok(!String(node.contextValue).includes('-repoForeignLocked'), String(node.contextValue));
      assert.match(String(node.repositoryLockTitle), /^Захвачено вашим пользователем Admin вне проекта, /);
    }
  });

  test('группа «Справочники» (добавление в корень) отражает чужой захват корня', () => {
    const { treeProvider } = harness;
    const catalogs = decorate(treeProvider, findPath(treeProvider, 'ТорговыйУчет', 'Справочники'));
    assert.ok(catalogs.addMetadataTarget?.kind === 'root', 'у группы — цель добавления в корень');
    assert.ok(String(catalogs.contextValue).includes('-repoUnlocked-repoForeignLocked'), String(catalogs.contextValue));
    assert.match(String(catalogs.repositoryLockTitle), /^Захвачено: Petrov/);
  });

  test('свой захват с датой после захвата и опроса; повторный getTreeItem не накапливает суффиксы', async () => {
    const { treeProvider, ws } = harness;
    ws.service.lockState.applyLock(ws.target, { anchor: 'Справочник.Контрагенты', members: ['Справочник.Контрагенты'], mode: 'object' });
    await ws.service.lockStatus.syncTarget(ws.target);
    const node = findPath(treeProvider, 'ТорговыйУчет', 'Справочники', 'Контрагенты');
    decorate(treeProvider, node);
    const first = String(node.contextValue);
    decorate(treeProvider, node);
    assert.strictEqual(String(node.contextValue), first);
    assert.ok(first.includes('-repoLocked') && !first.includes('-repoUnlocked'), first);
    assert.strictEqual((first.match(/-repo/g) ?? []).length, 3, first);
    assert.match(String(node.repositoryLockTitle), /^Захвачено: Admin, \d{2}\.\d{2}\.\d{4}/);
  });

  test('после отключения подсказка захвата снимается — у объекта и у группы добавления в корень', () => {
    const { treeProvider, ws } = harness;
    const node = decorate(treeProvider, findPath(treeProvider, 'ТорговыйУчет', 'Справочники', 'Контрагенты'));
    const catalogs = decorate(treeProvider, findPath(treeProvider, 'ТорговыйУчет', 'Справочники'));
    assert.ok(node.repositoryLockTitle && catalogs.repositoryLockTitle);
    ws.service.setConnected(ws.target, false);
    for (const item of [node, catalogs]) {
      decorate(treeProvider, item);
      assert.strictEqual(item.repositoryLockTitle, undefined);
      assert.ok(String(item.contextValue).includes('-repoDisconnected'), String(item.contextValue));
      assert.ok(!String(item.contextValue).includes('-repoForeignLocked'), String(item.contextValue));
    }
  });
});
