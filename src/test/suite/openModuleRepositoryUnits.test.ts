import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerOpenModuleCommands } from '../../ui/commands/open/OpenModuleCommand';
import type { CommandServices, NodeArg } from '../../ui/commands/_shared';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import { MetadataNode } from '../../ui/tree/TreeNode';

/**
 * Issue #53: команды открытия BSL-модулей проверяют хранилище по единице узла
 * (`resolveRepositoryEditProbePath`), а не по XML владельца. Форма объекта —
 * самостоятельная единица хранилища (#45/#46): модуль захваченной формы
 * редактируем, даже если владелец не захвачен, и наоборот.
 *
 * Команды регистрируются вручную с фейковым `context` — тестовый хост запущен
 * без workspace, реальное расширение `v8vscedit.*` не регистрирует (см.
 * configurationOperationGuardCommands.test.ts). Признак readonly — вызов
 * `workbench.action.files.setActiveEditorReadonlyInSession` из `setEditorReadonly`.
 * Фикстура — временная копия `example/2.21/src/cf`.
 */

const EXAMPLE_CF_21 = path.resolve(__dirname, '../../../example/2.21/src/cf');
const READONLY_COMMAND = 'workbench.action.files.setActiveEditorReadonlyInSession';
const OWNER = 'Справочник.Контрагенты';
const FORMA_ELEMENTA = 'Справочник.Контрагенты.Форма.ФормаЭлемента';

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

interface Harness {
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  dispose(): void;
}

async function createHarness(): Promise<Harness> {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-open-module-units-')));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(path.dirname(configRoot), { recursive: true });
  fs.cpSync(EXAMPLE_CF_21, configRoot, { recursive: true });
  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };
  await repositoryService.saveBinding(target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
  repositoryService.setConnected(target, true);
  return {
    configRoot,
    target,
    repositoryService,
    dispose: () => fs.rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

/** Нерекурсивный захват одной единицы: запись с режимом, подчинённые им не покрываются. */
function lockObjectOnly(harness: Harness, fullName: string): void {
  harness.repositoryService.lockState.applyLock(harness.target, { anchor: fullName, members: [fullName], mode: 'object' });
}

function ownerXmlPath(harness: Harness): string {
  return path.join(harness.configRoot, 'Catalogs', 'Контрагенты.xml');
}

/** Узел Form с production-раскладкой: xmlPath — XML владельца (см. propertyEditLockRepositoryUnits.test.ts). */
function formNode(harness: Harness): MetadataNode {
  const owner = ownerXmlPath(harness);
  return new MetadataNode(
    { label: 'ФормаЭлемента', nodeKind: 'Form', xmlPath: owner, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: owner } },
    vscode.TreeItemCollapsibleState.None
  );
}

function catalogNode(harness: Harness): MetadataNode {
  return new MetadataNode(
    { label: 'Контрагенты', nodeKind: 'Catalog', xmlPath: ownerXmlPath(harness) },
    vscode.TreeItemCollapsibleState.None
  );
}

function formModulePath(harness: Harness): string {
  return path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl');
}

let currentServices: Partial<CommandServices> = {};
const servicesProxy = new Proxy({} as CommandServices, {
  get: (_target, key: string | symbol) => (currentServices as Record<string | symbol, unknown>)[key],
});

interface CommandsRef { executeCommand: typeof vscode.commands.executeCommand }
interface WindowRef { showWarningMessage: typeof vscode.window.showWarningMessage }

suite('Открытие BSL-модулей — хранилище по единице узла (issue #53)', () => {
  const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
  const commandsRef = vscode.commands as unknown as CommandsRef;
  const windowRef = vscode.window as unknown as WindowRef;
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  let readonlyCalls = 0;
  let warnings: string[] = [];
  let harness: Harness | undefined;

  suiteSetup(() => {
    registerOpenModuleCommands(context, servicesProxy);
  });

  suiteTeardown(() => {
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  setup(async () => {
    readonlyCalls = 0;
    warnings = [];
    commandsRef.executeCommand = (<T>(command: string, ...rest: unknown[]): Thenable<T> => {
      if (command === READONLY_COMMAND) {
        readonlyCalls++;
        return Promise.resolve(undefined as T);
      }
      return originalExecuteCommand<T>(command, ...rest);
    });
    windowRef.showWarningMessage = ((message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    });
    harness = await createHarness();
    currentServices = { repositoryService: harness.repositoryService };
  });

  teardown(async () => {
    commandsRef.executeCommand = originalExecuteCommand;
    windowRef.showWarningMessage = originalShowWarningMessage;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    harness?.dispose();
    harness = undefined;
  });

  function requireHarness(): Harness {
    if (!harness) {
      throw new Error('harness не создан в setup');
    }
    return harness;
  }

  async function open(command: string, node: NodeArg): Promise<void> {
    await vscode.commands.executeCommand(command, node);
  }

  test('захвачена только форма: модуль формы редактируем, модуль объекта — только чтение', async function () {
    this.timeout(20_000);
    const h = requireHarness();
    lockObjectOnly(h, FORMA_ELEMENTA);

    await open('v8vscedit.openFormModule', formNode(h));
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, formModulePath(h));
    assert.strictEqual(readonlyCalls, 0, 'модуль захваченной формы не должен открываться только для чтения');

    await open('v8vscedit.openObjectModule', catalogNode(h));
    assert.strictEqual(readonlyCalls, 1, 'модуль незахваченного владельца — только чтение');
  });

  test('владелец захвачен нерекурсивно: модуль формы — только чтение, модуль объекта редактируем', async function () {
    this.timeout(20_000);
    const h = requireHarness();
    lockObjectOnly(h, OWNER);

    await open('v8vscedit.openFormModule', formNode(h));
    assert.strictEqual(readonlyCalls, 1, 'модуль незахваченной формы — только чтение');

    await open('v8vscedit.openObjectModule', catalogNode(h));
    assert.strictEqual(readonlyCalls, 1, 'модуль захваченного владельца не должен открываться только для чтения');
  });

  test('отсутствующий модуль захваченной формы создаётся, даже если владелец не захвачен', async function () {
    this.timeout(20_000);
    const h = requireHarness();
    fs.rmSync(formModulePath(h));
    lockObjectOnly(h, FORMA_ELEMENTA);

    await open('v8vscedit.openFormModule', formNode(h));

    assert.deepStrictEqual(warnings, []);
    assert.ok(fs.existsSync(formModulePath(h)), 'модуль формы должен быть создан');
    assert.strictEqual(readonlyCalls, 0);
  });

  test('отсутствующий модуль незахваченной формы не создаётся при захвате владельца', async function () {
    this.timeout(20_000);
    const h = requireHarness();
    fs.rmSync(formModulePath(h));
    lockObjectOnly(h, OWNER);

    await open('v8vscedit.openFormModule', formNode(h));

    assert.deepStrictEqual(warnings, ['Нельзя создать файл модуля формы: объект заблокирован для редактирования.']);
    assert.ok(!fs.existsSync(formModulePath(h)), 'модуль формы не должен создаваться');
  });

  test('поддержка по-прежнему решает по XML владельца: модуль объекта на поддержке не создаётся', async function () {
    this.timeout(20_000);
    const h = requireHarness();
    const supportService = new SupportInfoService({ appendLine: () => undefined });
    supportService.loadConfig(h.configRoot);
    const xmlPath = path.join(h.configRoot, 'Catalogs', 'АвансовыйОтчетПрисоединенныеФайлы.xml');
    assert.ok(supportService.isLocked(xmlPath), 'фикстура: объект на поддержке с запретом редактирования');
    lockObjectOnly(h, 'Справочник.АвансовыйОтчетПрисоединенныеФайлы');
    currentServices = { repositoryService: h.repositoryService, supportService };

    await open('v8vscedit.openObjectModule', { xmlPath, nodeKind: 'Catalog', label: 'АвансовыйОтчетПрисоединенныеФайлы' });

    assert.deepStrictEqual(warnings, ['Нельзя создать файл модуля объекта: объект заблокирован для редактирования.']);
    assert.ok(!fs.existsSync(path.join(h.configRoot, 'Catalogs', 'АвансовыйОтчетПрисоединенныеФайлы', 'Ext', 'ObjectModule.bsl')));
  });

  test('узел без xmlPath: блокировка не проверяется, путь модуля не определяется', async function () {
    this.timeout(20_000);

    await open('v8vscedit.openObjectModule', { nodeKind: 'Catalog', label: 'Контрагенты' });

    assert.deepStrictEqual(warnings, ['Не удалось определить путь модуля объекта.']);
    assert.strictEqual(readonlyCalls, 0);
  });

  interface SlotCase {
    readonly command: string;
    readonly node: (h: Harness) => NodeArg;
    readonly modulePath: (h: Harness) => string;
    /** Узел, по которому считается единица захвата, если она не совпадает с узлом команды. */
    readonly lockNode?: (h: Harness) => NodeArg;
  }

  const cf = (h: Harness, ...parts: string[]): string => path.join(h.configRoot, ...parts);

  // Каждая команда открытия ведёт в модуль своего слота; объекты — реальные из фикстуры.
  // Модулей записи и менеджера значения в выгрузке нет — команда создаёт их в копии.
  const SLOT_CASES: readonly SlotCase[] = [
    {
      command: 'v8vscedit.openCommonModuleCode',
      node: (h) => ({ xmlPath: cf(h, 'CommonModules', 'GoogleПереводчик.xml'), nodeKind: 'CommonModule', label: 'GoogleПереводчик' }),
      modulePath: (h) => cf(h, 'CommonModules', 'GoogleПереводчик', 'Ext', 'Module.bsl'),
    },
    {
      command: 'v8vscedit.openManagerModule',
      node: (h) => catalogNode(h),
      modulePath: (h) => cf(h, 'Catalogs', 'Контрагенты', 'Ext', 'ManagerModule.bsl'),
    },
    {
      command: 'v8vscedit.openRecordSetModule',
      node: (h) => ({ xmlPath: cf(h, 'InformationRegisters', 'КурсыВалют.xml'), nodeKind: 'InformationRegister', label: 'КурсыВалют' }),
      modulePath: (h) => cf(h, 'InformationRegisters', 'КурсыВалют', 'Ext', 'RecordSetModule.bsl'),
    },
    {
      command: 'v8vscedit.openConstantModule',
      node: (h) => ({ xmlPath: cf(h, 'Constants', 'ИспользоватьВозвраты.xml'), nodeKind: 'Constant', label: 'ИспользоватьВозвраты' }),
      modulePath: (h) => cf(h, 'Constants', 'ИспользоватьВозвраты', 'Ext', 'ValueManagerModule.bsl'),
    },
    {
      command: 'v8vscedit.openServiceModule',
      node: (h) => ({ xmlPath: cf(h, 'HTTPServices', 'Chatbot.xml'), nodeKind: 'HTTPService', label: 'Chatbot' }),
      modulePath: (h) => cf(h, 'HTTPServices', 'Chatbot', 'Ext', 'Module.bsl'),
    },
    {
      command: 'v8vscedit.openFormModule',
      node: (h) => ({ xmlPath: cf(h, 'CommonForms', 'АЛКОВводРеквизитовОП.xml'), nodeKind: 'CommonForm', label: 'АЛКОВводРеквизитовОП' }),
      modulePath: (h) => cf(h, 'CommonForms', 'АЛКОВводРеквизитовОП', 'Ext', 'Form', 'Module.bsl'),
    },
    {
      command: 'v8vscedit.openCommandModule',
      node: (h) => ({ xmlPath: cf(h, 'CommonCommands', 'ОткрытьПомощь.xml'), nodeKind: 'CommonCommand', label: 'ОткрытьПомощь' }),
      modulePath: (h) => cf(h, 'CommonCommands', 'ОткрытьПомощь', 'Ext', 'CommandModule.bsl'),
    },
    {
      command: 'v8vscedit.openCommandModule',
      node: (h) => ({ xmlPath: ownerXmlPath(h), nodeKind: 'Command', label: 'Покупатели' }),
      modulePath: (h) => cf(h, 'Catalogs', 'Контрагенты', 'Commands', 'Покупатели', 'Ext', 'CommandModule.bsl'),
      lockNode: (h) => catalogNode(h),
    },
  ];

  for (const slotCase of SLOT_CASES) {
    test(`${slotCase.command}: открывает модуль слота, readonly — по захвату объекта`, async function () {
      this.timeout(20_000);
      const h = requireHarness();
      const node = slotCase.node(h);
      const lockNode = slotCase.lockNode?.(h) ?? node;
      const fullName = h.repositoryService.resolveFullName({ xmlPath: lockNode.xmlPath, nodeKind: lockNode.nodeKind });
      assert.ok(fullName, 'фикстура: полное имя единицы хранилища');

      lockObjectOnly(h, fullName);
      await open(slotCase.command, node);
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, slotCase.modulePath(h));
      assert.strictEqual(readonlyCalls, 0, 'захваченный объект открывается редактируемым');

      h.repositoryService.lockState.resetScope(h.target, true);
      await open(slotCase.command, node);
      assert.strictEqual(readonlyCalls, 1, 'незахваченный объект открывается только для чтения');
    });
  }
});
