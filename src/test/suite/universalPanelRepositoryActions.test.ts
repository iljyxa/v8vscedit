import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { UniversalPanelViewProvider } from '../../ui/views/universal/UniversalPanelViewProvider';

/**
 * Issue #61: получение конкретной версии из хранилища — отдельная команда контекстного
 * меню узла, стоящая сразу за обычным «Получить из хранилища», и только у узлов с
 * активным подключением к хранилищу. Меню строит приватный `getNodeActions`.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');
const CATALOG_XML = path.join(EXTENSION_ROOT, 'example', '2.21', 'src', 'cf', 'Catalogs', 'Контрагенты.xml');

type UniversalServices = ConstructorParameters<typeof UniversalPanelViewProvider>[1];

interface NodeActionsApi {
  getNodeActions(node: MetadataNode): readonly { command: string }[];
}

function createProvider(): NodeActionsApi {
  const services = {
    state: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    // Настоящий провайдер без конфигураций: getNodeActions спрашивает у него, есть ли расширения.
    treeProvider: new MetadataTreeProvider([], vscode.Uri.file(EXTENSION_ROOT), EXTENSION_ROOT),
    setTreeMessage: () => undefined,
    isProjectInitialized: () => true,
    refreshActionsView: () => undefined,
  } as unknown as UniversalServices;
  return new UniversalPanelViewProvider(vscode.Uri.file(EXTENSION_ROOT), services) as unknown as NodeActionsApi;
}

function catalogNode(contextValue: string): MetadataNode {
  const node = new MetadataNode({ label: 'Контрагенты', nodeKind: 'Catalog', xmlPath: CATALOG_XML }, vscode.TreeItemCollapsibleState.None);
  node.contextValue = contextValue;
  return node;
}

suite('UniversalPanelViewProvider — команда «Получить версию из хранилища…» (issue #61)', () => {
  test('узел подключён к хранилищу — updateToVersion сразу после repository.update', () => {
    const commands = createProvider().getNodeActions(catalogNode('Catalog-hasXml-repoConnected-repoUnlocked')).map((action) => action.command);

    const updateIndex = commands.indexOf('v8vscedit.repository.update');
    assert.ok(updateIndex >= 0, commands.join(', '));
    assert.strictEqual(commands[updateIndex + 1], 'v8vscedit.repository.updateToVersion');
  });

  test('узел без подключения к хранилищу — ни получения, ни получения версии', () => {
    const commands = createProvider().getNodeActions(catalogNode('Catalog-hasXml')).map((action) => action.command);

    assert.ok(!commands.includes('v8vscedit.repository.update'), commands.join(', '));
    assert.ok(!commands.includes('v8vscedit.repository.updateToVersion'), commands.join(', '));
  });
});
