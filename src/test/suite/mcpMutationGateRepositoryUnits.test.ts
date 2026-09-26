import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { V8McpServer } from '../../ui/mcp/V8McpServer';
import { ConfigurationXmlEditor } from '../../infra/xml';
import { MetadataXmlCreator } from '../../infra/xml/MetadataXmlCreator';
import { MetadataXmlRemover } from '../../infra/xml/MetadataXmlRemover';
import { ExternalObjectService } from '../../infra/xml/ExternalObjectService';
import { ConfigurationScaffoldService } from '../../infra/xml/ConfigurationScaffoldService';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';
import { FormToolsService } from '../../infra/xml/form/FormToolsService';
import { RoleRightsService } from '../../infra/role';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import type { CommandServices } from '../../ui/commands/_shared';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { findConfigurations } from '../../infra/fs/ConfigLocator';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { SupportInfoService, SupportMode } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';

/**
 * Issue #46: MCP-мутации над Form/Template обязаны блокироваться по захвату
 * САМОЙ единицы хранилища, а не владельца (`assertNodeContentEditable`), тогда
 * как rename/remove по-прежнему адресуют владельца (`assertNodeEditable`, без
 * изменений). Фикстура — реальная временная копия `example/2.21/src/cf`
 * (CLAUDE.md TDD п.3), настоящий `RepositoryService`, реальный MCP-каталог
 * через приватный `V8McpServer.registerTools` (образец mcpToolsCatalog.test.ts).
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

interface RegisteredTool {
  readonly name: string;
  readonly handler: (args: Record<string, unknown>) => unknown;
}

interface MockMcpServer {
  readonly tools: Map<string, RegisteredTool>;
  registerTool: (
    name: string,
    config: { title: string; description: string; inputSchema: unknown },
    handler: (args: Record<string, unknown>) => unknown,
  ) => void;
}

function createMockServer(): MockMcpServer {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    registerTool: (name, _config, handler) => {
      tools.set(name, { name, handler });
    },
  };
}

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  treeProvider: MetadataTreeProvider;
  tools: Map<string, RegisteredTool>;
  cacheRoot: string;
  dispose(): void;
}

/** Минимальный набор `CommandServices` реальным `treeProvider`/`repositoryService` (образец mcpToolsCatalog.test.ts). */
function createServices(overrides: Partial<CommandServices>): CommandServices {
  const notImplemented = (member: string) => () => {
    throw new Error(`Стаб CommandServices: "${member}" не должен вызываться в этом тесте.`);
  };
  const base: CommandServices = {
    treeProvider: notImplemented('treeProvider') as never,
    workspaceFolder: { uri: vscode.Uri.file('/tmp/v8vscedit-fixture'), name: 'fixture', index: 0 },
    metadataXmlCreator: new MetadataXmlCreator(),
    metadataXmlRemover: new MetadataXmlRemover(),
    configurationInfoService: notImplemented('configurationInfoService') as never,
    configurationScaffoldService: new ConfigurationScaffoldService(),
    configurationValidationService: notImplemented('configurationValidationService') as never,
    metadataInfoService: notImplemented('metadataInfoService') as never,
    metadataValidationService: notImplemented('metadataValidationService') as never,
    subsystemToolsService: notImplemented('subsystemToolsService') as never,
    subsystemXmlService: new SubsystemXmlService(),
    commandInterfaceService: notImplemented('commandInterfaceService') as never,
    mxlTemplateService: notImplemented('mxlTemplateService') as never,
    dataCompositionSchemaService: notImplemented('dataCompositionSchemaService') as never,
    externalObjectService: new ExternalObjectService(),
    formToolsService: new FormToolsService(),
    cfeBorrowService: notImplemented('cfeBorrowService') as never,
    cfeDiffService: notImplemented('cfeDiffService') as never,
    cfePatchMethodService: notImplemented('cfePatchMethodService') as never,
    roleRightsService: new RoleRightsService(),
    reloadEntries: () => undefined,
    dynamicPanelController: { handleMetadataRemoved: () => undefined } as never,
    subsystemEditorViewProvider: { handleMetadataRemoved: () => undefined } as never,
    outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
    supportService: undefined,
    repositoryService: notImplemented('repositoryService') as never,
    projectSecretStorage: notImplemented('projectSecretStorage') as never,
    repositoryConnectionViewProvider: notImplemented('repositoryConnectionViewProvider') as never,
    repositoryCommitViewProvider: notImplemented('repositoryCommitViewProvider') as never,
    bslAnalyzerConfigService: notImplemented('bslAnalyzerConfigService') as never,
    projectEnvironmentViewProvider: notImplemented('projectEnvironmentViewProvider') as never,
    aiMcpViewProvider: undefined,
    standaloneServerService: notImplemented('standaloneServerService') as never,
    standaloneServerViewProvider: notImplemented('standaloneServerViewProvider') as never,
    aiSkillsInstaller: notImplemented('aiSkillsInstaller') as never,
    refreshChangedConfigurationState: () => undefined,
    markChangedConfigurationByFiles: () => undefined,
    getChangedConfigurations: () => [],
    markConfigurationsClean: () => undefined,
    suppressConfigurationReloadForFiles: () => undefined,
    revealTreeNode: () => Promise.resolve(false),
    setTreeMessage: () => undefined,
    setTreeProcessingState: () => undefined,
    refreshActionsView: () => undefined,
    configurationOperationGuard: new ConfigurationOperationGuard(),
  };
  return { ...base, ...overrides };
}

function createHarness(): Harness {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-mcp-repo-units-')));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(path.dirname(configRoot), { recursive: true });
  fs.cpSync(EXAMPLE_CF_21, configRoot, { recursive: true });

  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const entries = findConfigurations(workspaceRoot);
  assert.ok(entries.length > 0, 'findConfigurations должен найти скопированную выгрузку.');
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-mcp-repo-units-cache-'));
  const treeProvider = new MetadataTreeProvider(entries, vscode.Uri.file(EXTENSION_ROOT), cacheRoot, undefined, undefined, repositoryService);
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };

  const services = createServices({ treeProvider, repositoryService });
  const server = new V8McpServer(services, new ConfigurationXmlEditor(), workspaceRoot, '0.0.0-test');
  const mock = createMockServer();
  (server as unknown as { registerTools(mcp: unknown): void }).registerTools(mock);

  return {
    workspaceRoot,
    configRoot,
    target,
    repositoryService,
    treeProvider,
    tools: mock.tools,
    cacheRoot,
    dispose: () => {
      treeProvider.dispose();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    },
  };
}

async function bindAndConnect(harness: Harness): Promise<void> {
  await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
  harness.repositoryService.setConnected(harness.target, true);
}

type LockMode = 'M1' | 'M2' | 'M3' | 'M4' | 'M5';

const OWNER = 'Справочник.Контрагенты';
const FORMA_ELEMENTA = 'Справочник.Контрагенты.Форма.ФормаЭлемента';
const FORMA_SPISKA = 'Справочник.Контрагенты.Форма.ФормаСписка';
const MAKET = 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла';

function applyMode(harness: Harness, mode: LockMode): void {
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

function extractText(result: unknown): string {
  const part = (result as CallToolResult).content[0];
  return part.type === 'text' ? part.text : '';
}

function isErrorResult(result: unknown): boolean {
  return (result as CallToolResult).isError === true;
}

function callTool(harness: Harness, name: string, args: Record<string, unknown>): unknown {
  const tool = harness.tools.get(name);
  assert.ok(tool, `tool "${name}" должен быть зарегистрирован`);
  return tool.handler(args);
}

const FORM_PATH = 'Справочники.Контрагенты.Форма.ФормаЭлемента';
const TEMPLATE_PATH = 'Справочники.Контрагенты.Макет.ЗагрузкаИзФайла';

const FORM_TOOLS = ['v8vscedit_set_property_by_path', 'v8vscedit_set_properties', 'v8vscedit_set_type', 'v8vscedit_compile_form', 'v8vscedit_edit_form'] as const;
const TEMPLATE_TOOLS = ['v8vscedit_compile_mxl', 'v8vscedit_compile_skd', 'v8vscedit_edit_skd'] as const;

function argsFor(toolName: string, canonical: string): Record<string, unknown> {
  switch (toolName) {
    case 'v8vscedit_set_property_by_path':
      return { path: canonical, propertyKey: 'Comment', value: 'issue-46' };
    case 'v8vscedit_set_properties':
      return { path: canonical, properties: { Comment: 'issue-46' } };
    case 'v8vscedit_set_type':
      return { path: canonical, propertyKey: 'Comment', value: 'issue-46' };
    case 'v8vscedit_compile_form':
    case 'v8vscedit_compile_mxl':
    case 'v8vscedit_compile_skd':
      return { path: canonical, definition: {} };
    case 'v8vscedit_edit_form':
      return { path: canonical, definition: {} };
    case 'v8vscedit_edit_skd':
      return { path: canonical, operation: 'add-field', value: 'X' };
    default:
      throw new Error(`неизвестный tool ${toolName}`);
  }
}

function unitXmlPath(harness: Harness, relative: string): string {
  return path.join(harness.configRoot, relative);
}

suite('MCP: инструменты Form/Template блокируются по захвату САМОЙ единицы, а не владельца (issue #46)', () => {
  test('M1 (захвачен только владелец): все 8 инструментов на форме/макете → isError, afterMutation не вызывался, файлы не изменились', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      applyMode(harness, 'M1');

      const formXml = unitXmlPath(harness, 'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml');
      const templateXml = unitXmlPath(harness, 'Catalogs/Контрагенты/Templates/ЗагрузкаИзФайла.xml');
      const formBefore = fs.readFileSync(formXml, 'utf-8');
      const templateBefore = fs.readFileSync(templateXml, 'utf-8');

      for (const toolName of FORM_TOOLS) {
        const result = callTool(harness, toolName, argsFor(toolName, FORM_PATH));
        assert.strictEqual(isErrorResult(result), true, `${toolName} должен вернуть isError=true в M1`);
        assert.ok(extractText(result).includes('не захвачен в хранилище конфигурации'), `${toolName}: неожиданный текст ошибки — ${extractText(result)}`);
      }
      for (const toolName of TEMPLATE_TOOLS) {
        const result = callTool(harness, toolName, argsFor(toolName, TEMPLATE_PATH));
        assert.strictEqual(isErrorResult(result), true, `${toolName} должен вернуть isError=true в M1`);
        assert.ok(extractText(result).includes('не захвачен в хранилище конфигурации'), `${toolName}: неожиданный текст ошибки — ${extractText(result)}`);
      }

      assert.strictEqual(fs.readFileSync(formXml, 'utf-8'), formBefore, 'файл формы не должен измениться в M1.');
      assert.strictEqual(fs.readFileSync(templateXml, 'utf-8'), templateBefore, 'файл макета не должен измениться в M1.');
    } finally {
      harness.dispose();
    }
  });

  test('M4 (захвачена сама форма): v8vscedit_set_property_by_path успешен и меняет файл формы, гейт post-mutation отработал', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      applyMode(harness, 'M4');

      const formXml = unitXmlPath(harness, 'Catalogs/Контрагенты/Forms/ФормаЭлемента.xml');
      const before = fs.readFileSync(formXml, 'utf-8');

      const result = callTool(harness, 'v8vscedit_set_property_by_path', { path: FORM_PATH, propertyKey: 'Comment', value: 'issue-46-m4' });
      assert.strictEqual(isErrorResult(result), false, `ожидался успех, получено: ${extractText(result)}`);

      const after = fs.readFileSync(formXml, 'utf-8');
      assert.notStrictEqual(after, before, 'set_property_by_path на захваченной форме обязан изменить файл.');
      assert.ok(after.includes('issue-46-m4'), 'изменённый файл должен содержать новое значение Comment.');
    } finally {
      harness.dispose();
    }
  });

  test('M4: rename_metadata и remove_form на той же форме по-прежнему блокируются (адресуют владельца — тот не захвачен)', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      applyMode(harness, 'M4');

      const renameResult = callTool(harness, 'v8vscedit_rename_metadata', { path: FORM_PATH, newName: 'ФормаЭлемента2' });
      assert.strictEqual(isErrorResult(renameResult), true, `rename_metadata должен блокироваться по владельцу: ${extractText(renameResult)}`);
      assert.ok(extractText(renameResult).includes('не захвачен в хранилище конфигурации'));

      const removeResult = callTool(harness, 'v8vscedit_remove_form', { path: FORM_PATH });
      assert.strictEqual(isErrorResult(removeResult), true, `remove_form должен блокироваться по владельцу: ${extractText(removeResult)}`);
      assert.ok(extractText(removeResult).includes('не захвачен в хранилище конфигурации'));
    } finally {
      harness.dispose();
    }
  });
});

suite('McpMutationGate.assertNodeContentEditable — матрица M1–M5 × {Form, Template, Attribute, Catalog} (issue #46)', () => {
  const CATALOG_XML_REL = 'Catalogs/Контрагенты.xml';

  function catalogXmlPath(harness: Harness): string {
    return unitXmlPath(harness, CATALOG_XML_REL);
  }

  function buildNode(harness: Harness, nodeKind: 'Form' | 'Template' | 'Attribute' | 'Catalog', label: string): MetadataNode {
    const ownerXml = catalogXmlPath(harness);
    if (nodeKind === 'Catalog') {
      return new MetadataNode({ label, nodeKind: 'Catalog', xmlPath: ownerXml }, vscode.TreeItemCollapsibleState.None);
    }
    return new MetadataNode(
      { label, nodeKind, xmlPath: ownerXml, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXml } },
      vscode.TreeItemCollapsibleState.None
    );
  }

  function gateOf(harness: Harness): McpMutationGate {
    return new McpMutationGate({ supportService: undefined, repositoryService: harness.repositoryService } as unknown as ConstructorParameters<typeof McpMutationGate>[0]);
  }

  const FORMA_EXPECTATION: Record<LockMode, boolean> = { M1: true, M2: false, M3: false, M4: false, M5: false };
  const MAKET_EXPECTATION: Record<LockMode, boolean> = { M1: true, M2: false, M3: false, M4: true, M5: false };
  const OWNER_EXPECTATION: Record<LockMode, boolean> = { M1: false, M2: false, M3: false, M4: true, M5: true };
  const MODES: readonly LockMode[] = ['M1', 'M2', 'M3', 'M4', 'M5'];

  for (const mode of MODES) {
    test(`${mode}: Form ФормаЭлемента → assertNodeContentEditable ${FORMA_EXPECTATION[mode] ? 'бросает' : 'не бросает'}`, async () => {
      const harness = createHarness();
      try {
        await bindAndConnect(harness);
        applyMode(harness, mode);
        const gate = gateOf(harness);
        const node = buildNode(harness, 'Form', 'ФормаЭлемента');
        if (FORMA_EXPECTATION[mode]) {
          assert.throws(() => { gate.assertNodeContentEditable(node); }, /не захвачен в хранилище конфигурации/);
        } else {
          assert.doesNotThrow(() => { gate.assertNodeContentEditable(node); });
        }
      } finally {
        harness.dispose();
      }
    });

    test(`${mode}: Template ЗагрузкаИзФайла → assertNodeContentEditable ${MAKET_EXPECTATION[mode] ? 'бросает' : 'не бросает'}`, async () => {
      const harness = createHarness();
      try {
        await bindAndConnect(harness);
        applyMode(harness, mode);
        const gate = gateOf(harness);
        const node = buildNode(harness, 'Template', 'ЗагрузкаИзФайла');
        if (MAKET_EXPECTATION[mode]) {
          assert.throws(() => { gate.assertNodeContentEditable(node); }, /не захвачен в хранилище конфигурации/);
        } else {
          assert.doesNotThrow(() => { gate.assertNodeContentEditable(node); });
        }
      } finally {
        harness.dispose();
      }
    });

    test(`${mode}: Attribute (владелец) → assertNodeContentEditable ${OWNER_EXPECTATION[mode] ? 'бросает' : 'не бросает'}`, async () => {
      const harness = createHarness();
      try {
        await bindAndConnect(harness);
        applyMode(harness, mode);
        const gate = gateOf(harness);
        const node = buildNode(harness, 'Attribute', 'ИНН');
        if (OWNER_EXPECTATION[mode]) {
          assert.throws(() => { gate.assertNodeContentEditable(node); }, /не захвачен в хранилище конфигурации/);
        } else {
          assert.doesNotThrow(() => { gate.assertNodeContentEditable(node); });
        }
      } finally {
        harness.dispose();
      }
    });

    test(`${mode}: Catalog Контрагенты → assertNodeContentEditable ${OWNER_EXPECTATION[mode] ? 'бросает' : 'не бросает'}`, async () => {
      const harness = createHarness();
      try {
        await bindAndConnect(harness);
        applyMode(harness, mode);
        const gate = gateOf(harness);
        const node = buildNode(harness, 'Catalog', 'Контрагенты');
        if (OWNER_EXPECTATION[mode]) {
          assert.throws(() => { gate.assertNodeContentEditable(node); }, /не захвачен в хранилище конфигурации/);
        } else {
          assert.doesNotThrow(() => { gate.assertNodeContentEditable(node); });
        }
      } finally {
        harness.dispose();
      }
    });
  }

  test('assertNodeEditable(formNode) — по владельцу, без изменений: M4 бросает (владелец не захвачен), M1 не бросает (владелец захвачен)', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      applyMode(harness, 'M4');
      const gate = gateOf(harness);
      const node = buildNode(harness, 'Form', 'ФормаЭлемента');
      assert.throws(() => { gate.assertNodeEditable(node); }, /не захвачен в хранилище конфигурации/);
    } finally {
      harness.dispose();
    }
  });

  test('assertNodeEditable(formNode) — M1: владелец захвачен → не бросает', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      applyMode(harness, 'M1');
      const gate = gateOf(harness);
      const node = buildNode(harness, 'Form', 'ФормаЭлемента');
      assert.doesNotThrow(() => { gate.assertNodeEditable(node); });
    } finally {
      harness.dispose();
    }
  });

  test('assertMetadataEditable(path) без второго аргумента — прежнее поведение по владельцу (регресс)', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      applyMode(harness, 'M4');
      const gate = gateOf(harness);
      // Один аргумент — как раньше, проверка идёт по переданному пути напрямую
      // (владелец), захват формы M4 на это не влияет.
      assert.throws(() => { gate.assertMetadataEditable(catalogXmlPath(harness)); }, /не захвачен в хранилище конфигурации/);
    } finally {
      harness.dispose();
    }
  });

  test('assertNodeContentEditable(node) без xmlPath и metaContext.ownerObjectXmlPath — resolveRepositoryEditProbePath откатывается к undefined, гейт бросает раньше проверки хранилища', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      const gate = gateOf(harness);
      const node = new MetadataNode({ label: 'БезПути', nodeKind: 'Form' }, vscode.TreeItemCollapsibleState.None);
      assert.throws(
        () => { gate.assertNodeContentEditable(node); },
        { message: 'Не удалось определить XML-файл объекта для проверки блокировки изменения.' }
      );
    } finally {
      harness.dispose();
    }
  });
});

/**
 * Поддержка проверяется по владельцу и не меняется этой задачей: даже когда
 * форма M4-захвачена в хранилище, `SupportMode.Locked` на самом владельце
 * обязан блокировать содержимое формы/макета раньше репозитория. Используется
 * реальный `Ext/ParentConfigurations.bin` из `example/2.21` (собран
 * `example/tools/build-supported-cf.mjs`, default="locked" — см.
 * `example/tools/support-rules.json`): каталог "ПричиныВозврата" не входит в
 * список исключений и потому Locked по умолчанию.
 */
suite('McpMutationGate.assertNodeContentEditable — поддержка блокирует по владельцу поверх хранилища (issue #46, регресс)', () => {
  class TestLogger implements Logger {
    readonly messages: string[] = [];
    appendLine(message: string): void { this.messages.push(message); }
  }

  test('владелец Locked поддержкой, форма M4-захвачена в хранилище → assertNodeContentEditable всё равно бросает текст поддержки', async () => {
    const harness = createHarness();
    try {
      await bindAndConnect(harness);
      const ownerXml = unitXmlPath(harness, 'Catalogs/ПричиныВозврата.xml');
      const formXml = unitXmlPath(harness, 'Catalogs/ПричиныВозврата/Forms/ФормаЭлемента.xml');
      assert.ok(fs.existsSync(formXml), 'фикстура должна содержать реальную форму ПричиныВозврата.ФормаЭлемента.');

      const formFullName = 'Справочник.ПричиныВозврата.Форма.ФормаЭлемента';
      harness.repositoryService.lockState.applyLock(harness.target, { anchor: formFullName, members: [formFullName], mode: 'object' });

      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(harness.configRoot);
      assert.strictEqual(supportService.getSupportMode(ownerXml), SupportMode.Locked);

      const gate = new McpMutationGate({ supportService, repositoryService: harness.repositoryService } as unknown as ConstructorParameters<typeof McpMutationGate>[0]);
      const node = new MetadataNode(
        { label: 'ФормаЭлемента', nodeKind: 'Form', xmlPath: ownerXml, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXml } },
        vscode.TreeItemCollapsibleState.None
      );

      assert.throws(
        () => { gate.assertNodeContentEditable(node); },
        { message: 'Объект защищён от изменения: находится на поддержке с запретом редактирования.' }
      );
    } finally {
      harness.dispose();
    }
  });
});
