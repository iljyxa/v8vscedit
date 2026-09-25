/**
 * Issue #10 — интеграция общего `ConfigurationOperationGuard` с реальной
 * регистрацией команд `ExtensionCommands`/`RepositoryCommands`.
 *
 * Тестовый хост запускается БЕЗ workspace-папки (см. `src/test/runTests.ts` —
 * `launchArgs` не содержит открываемой папки), поэтому `extension.ts.activate()`
 * возвращает `undefined` до вызова `Container.bootstrap`, и ни один
 * `v8vscedit.*` command не зарегистрирован реальным расширением — проверено:
 * ни один существующий тест не строит workspaceFolders и не полагается на
 * реальную регистрацию `v8vscedit.*` (`rg "workspaceFolders" src/test/suite`
 * пусто). Поэтому регистрация тех же id вручную через
 * `registerExtensionCommands`/`registerRepositoryCommands`/`registerDbCommands`
 * с фейковым `context = { subscriptions: [] }` не конфликтует с уже
 * существующими командами. Команды регистрируются один раз на весь suite
 * (`suiteSetup`) с прокси на подменяемый `CommandServices`/`ExtensionCommandsDeps`,
 * чтобы каждый тест мог задать свой набор стабов, не пересоздавая регистрацию
 * (VS Code не позволяет повторно зарегистрировать тот же id без dispose
 * предыдущей регистрации).
 *
 * `RepositoryService`, `standaloneServerService`, `repositoryCommitViewProvider`
 * и остальные внешние по отношению к guard'у сервисы — записывающие стабы;
 * реальный смысл проверки — что при занятом guard соответствующие runner'ы
 * НЕ вызываются, а не бизнес-логика самих runner'ов (она уже покрыта другими
 * suite). Пути узлов — реальные фикстуры `example/2.21/src/cf` и
 * `example/2.21/src/cfe/EVOLC`.
 *
 * Issue #39 — команды `importConfigurations`/`updateChangedConfigurations`
 * возвращают явный `ConfigurationCommandOutcome` вместо `boolean`. Запуск
 * Конфигуратора (`decompileMainConfiguration`/`updateMainConfiguration`/
 * `updateExtension`/`decompileExtension`) и модальный выбор конфигураций
 * (`pickImportTargets`/`pickChangedConfigurations`) вынесены из тела команды
 * в `ExtensionCommandsDeps` (переименован из `ConnectExtensionDeps` — общая
 * точка внедрения для всех запусков Конфигуратора и модальных диалогов этой
 * команды), поэтому обе ветки успеха/провала/отмены/гонки с guard'ом
 * проверяются без реального процесса 1С и без реального QuickPick UI.
 * `registerDbCommands`/`registerConfigLifecycleTools` (MCP-мост
 * `v8vscedit_execute_command`) добавлены в тот же harness: обе точки идут
 * через `vscode.commands.executeCommand`, поэтому используют ОДНИ и те же
 * зарегистрированные на `servicesBox`/`depsProxy` команды.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ExtensionCommandsDeps, registerExtensionCommands } from '../../ui/commands/ext/ExtensionCommands';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/ExtensionCommandRunner';
import { CONFIGURATION_OPERATION_BUSY_MESSAGE } from '../../ui/commands/ext/configurationOperationBusy';
import { registerRepositoryCommands } from '../../ui/commands/repository/RepositoryCommands';
import { registerDbCommands } from '../../ui/commands/db/DbCommands';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { McpCommandServices, McpRegistrationDeps } from '../../ui/mcp/registration/McpRegistrationDeps';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import type { CommandServices, NodeArg } from '../../ui/commands/_shared';
import type { RepositoryService, RepositoryTarget } from '../../infra/repository/RepositoryService';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_CFE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

// Имена — реальный <Name> из Configuration.xml соответствующей фикстуры
// (readConfigName/parseConfigXml), а не метка узла дерева (та отдельно
// задаётся полем label в CF_NODE/CFE_NODE ниже и используется только
// командами, работающими с уже смонтированным узлом дерева).
const CF_NAME = 'ТорговыйУчет';
const CFE_NAME = 'EVOLC';

const CF_NODE: NodeArg = {
  xmlPath: path.join(EXAMPLE_CF, 'Configuration.xml'),
  nodeKind: 'configuration',
  label: 'Основная конфигурация',
};
const CFE_NODE: NodeArg = {
  xmlPath: path.join(EXAMPLE_CFE_EVOLC, 'Configuration.xml'),
  nodeKind: 'extension',
  label: 'EVOLC',
};

function notCalled(name: string): () => never {
  return () => {
    throw new Error(`"${name}" не должен вызываться в этом сценарии`);
  };
}

/**
 * Минимальный набор `CommandServices`, достаточный для тела обеих регистраций.
 * Поля, не участвующие в проверяемом сценарии, — throw-стабы: случайный вызов
 * должен провалить тест громко, а не тихо превратиться в no-op.
 */
function createServices(overrides: Partial<CommandServices> = {}): CommandServices {
  const base: Partial<CommandServices> = {
    treeProvider: {
      getEntries: notCalled('treeProvider.getEntries'),
      refresh: notCalled('treeProvider.refresh'),
    } as unknown as CommandServices['treeProvider'],
    workspaceFolder: { uri: vscode.Uri.file(EXAMPLE_CF), name: 'fixture', index: 0 },
    outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
    standaloneServerService: {
      refreshHealth: notCalled('standaloneServerService.refreshHealth'),
      stop: notCalled('standaloneServerService.stop'),
      start: notCalled('standaloneServerService.start'),
    } as unknown as CommandServices['standaloneServerService'],
    getChangedConfigurations: notCalled('getChangedConfigurations'),
    markConfigurationsClean: notCalled('markConfigurationsClean'),
    setTreeProcessingState: notCalled('setTreeProcessingState'),
    reloadEntries: notCalled('reloadEntries'),
    refreshActionsView: notCalled('refreshActionsView'),
    repositoryService: {
      resolveTargetByXmlPath: notCalled('repositoryService.resolveTargetByXmlPath'),
      hasBinding: notCalled('repositoryService.hasBinding'),
      isConnected: notCalled('repositoryService.isConnected'),
      resolveFullName: notCalled('repositoryService.resolveFullName'),
      isLocked: notCalled('repositoryService.isLocked'),
    } as unknown as RepositoryService,
    repositoryCommitViewProvider: {
      show: notCalled('repositoryCommitViewProvider.show'),
    } as unknown as CommandServices['repositoryCommitViewProvider'],
    configurationOperationGuard: new ConfigurationOperationGuard(),
  };
  return { ...base, ...overrides } as unknown as CommandServices;
}

/**
 * Регистрация вызывается один раз на suite с объектом-прокси: сами команды
 * не пересоздаются между тестами (VS Code не разрешает повторную регистрацию
 * того же id без dispose), а каждый тест подменяет реальный набор через
 * `currentServices`, на который прокси делегирует чтение свойств.
 */
const servicesBox: { current: CommandServices } = { current: createServices() };

function createServicesProxy(): CommandServices {
  return new Proxy(
    {},
    {
      get(_target, prop: PropertyKey) {
        const value: unknown = Reflect.get(servicesBox.current, prop);
        return value;
      },
    }
  ) as CommandServices;
}

/**
 * Запуск Конфигуратора (декомпиляция/обновление) и модальные диалоги выбора
 * конфигураций — единственная точка внедрения для `importConfigurations`/
 * `updateChangedConfigurations`/`connectExtension`. По умолчанию — throw-стабы:
 * сценарии, не касающиеся соответствующей ветки, не должны до них доходить.
 */
function createDeps(overrides: Partial<ExtensionCommandsDeps> = {}): ExtensionCommandsDeps {
  return {
    listDatabaseExtensions: notCalled('listDatabaseExtensions'),
    decompileExtension: notCalled('decompileExtension'),
    decompileMainConfiguration: notCalled('decompileMainConfiguration'),
    updateMainConfiguration: notCalled('updateMainConfiguration'),
    updateExtension: notCalled('updateExtension'),
    pickImportTargets: notCalled('pickImportTargets'),
    pickChangedConfigurations: notCalled('pickChangedConfigurations'),
    ...overrides,
  };
}

const depsBox: { current: ExtensionCommandsDeps } = { current: createDeps() };

const depsProxy: ExtensionCommandsDeps = {
  listDatabaseExtensions: (...args) => depsBox.current.listDatabaseExtensions(...args),
  decompileExtension: (...args) => depsBox.current.decompileExtension(...args),
  decompileMainConfiguration: (...args) => depsBox.current.decompileMainConfiguration(...args),
  updateMainConfiguration: (...args) => depsBox.current.updateMainConfiguration(...args),
  updateExtension: (...args) => depsBox.current.updateExtension(...args),
  pickImportTargets: (...args) => depsBox.current.pickImportTargets(...args),
  pickChangedConfigurations: (...args) => depsBox.current.pickChangedConfigurations(...args),
};

/**
 * Диалоги `vscode.window.show*Message` подменяются на весь suite (а не только
 * внутри вложенного issue #38), чтобы новые сценарии issue #39 могли
 * детерминированно проверить факт/количество уведомлений и — для no-targets —
 * то, что предупреждение показывается БЕЗ ожидания его закрытия (запрет
 * CLAUDE.md №18). Вложенный suite issue #38 ниже переопределяет те же методы
 * локально и восстанавливает их обратно на эти общие для suite стабы в своём
 * teardown — стек подмен корректен.
 */
type WindowMessageStubs = Pick<typeof vscode.window, 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage'>;
const windowRef = vscode.window as WindowMessageStubs;
let originalWindowMessageStubs: WindowMessageStubs;
let bridgeInformationMessages: string[];
let bridgeWarningMessages: string[];
let bridgeErrorMessages: string[];
/** По умолчанию разрешается сразу; конкретный тест может подменить на «никогда не разрешается». */
let bridgeWarningMessageResolver: () => Thenable<string | undefined>;

suite('ConfigurationOperationGuard — интеграция ExtensionCommands/RepositoryCommands (issue #10)', () => {
  let context: vscode.ExtensionContext;

  suiteSetup(() => {
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerExtensionCommands(context, createServicesProxy(), depsProxy);
    registerRepositoryCommands(context, createServicesProxy());
    registerDbCommands(context, createServicesProxy());

    originalWindowMessageStubs = {
      showInformationMessage: vscode.window.showInformationMessage,
      showWarningMessage: vscode.window.showWarningMessage,
      showErrorMessage: vscode.window.showErrorMessage,
    };
    windowRef.showInformationMessage = (message: string) => {
      bridgeInformationMessages.push(message);
      return Promise.resolve(undefined);
    };
    windowRef.showWarningMessage = (message: string) => {
      bridgeWarningMessages.push(message);
      return bridgeWarningMessageResolver();
    };
    windowRef.showErrorMessage = (message: string) => {
      bridgeErrorMessages.push(message);
      return Promise.resolve(undefined);
    };
  });

  suiteTeardown(async () => {
    (context.subscriptions as vscode.Disposable[]).forEach((subscription) => { subscription.dispose(); });
    await disposeCachedAgentOperationServices();
    windowRef.showInformationMessage = originalWindowMessageStubs.showInformationMessage;
    windowRef.showWarningMessage = originalWindowMessageStubs.showWarningMessage;
    windowRef.showErrorMessage = originalWindowMessageStubs.showErrorMessage;
  });

  setup(() => {
    servicesBox.current = createServices();
    depsBox.current = createDeps();
    bridgeInformationMessages = [];
    bridgeWarningMessages = [];
    bridgeErrorMessages = [];
    bridgeWarningMessageResolver = () => Promise.resolve(undefined);
  });

  test('guard занят «Хранилище: синхронизация» — updateChangedConfigurations сразу возвращает busy с heldBy, getChangedConfigurations/setTreeProcessingState не вызваны, одно уведомление, аренда цела', async () => {
    const guard = new ConfigurationOperationGuard();
    const lease = guard.tryAcquire('Хранилище: синхронизация');
    let getChangedCalls = 0;
    let setTreeCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => { getChangedCalls += 1; return []; },
      setTreeProcessingState: () => { setTreeCalls += 1; },
    });

    const result = await vscode.commands.executeCommand('v8vscedit.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Хранилище: синхронизация' });
    assert.strictEqual(getChangedCalls, 0);
    assert.strictEqual(setTreeCalls, 0);
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
    assert.deepStrictEqual(bridgeInformationMessages, [CONFIGURATION_OPERATION_BUSY_MESSAGE]);
    lease?.release();
  });

  test('guard занят «Хранилище: синхронизация» — importConfigurations сразу возвращает busy с heldBy, treeProvider.getEntries не вызван, одно уведомление', async () => {
    const guard = new ConfigurationOperationGuard();
    const lease = guard.tryAcquire('Хранилище: синхронизация');
    let getEntriesCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: { getEntries: () => { getEntriesCalls += 1; return []; } } as unknown as CommandServices['treeProvider'],
    });

    const result = await vscode.commands.executeCommand('v8vscedit.importConfigurations');

    assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Хранилище: синхронизация' });
    assert.strictEqual(getEntriesCalls, 0);
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
    assert.deepStrictEqual(bridgeInformationMessages, [CONFIGURATION_OPERATION_BUSY_MESSAGE]);
    lease?.release();
  });

  const RUN_EXCLUSIVE_CASES: { command: string; node: NodeArg; label: string }[] = [
    { command: 'v8vscedit.importConfigurationFromDb', node: CF_NODE, label: 'importConfigurationFromDb (cf)' },
    { command: 'v8vscedit.updateConfigurationInDb', node: CF_NODE, label: 'updateConfigurationInDb (cf)' },
    { command: 'v8vscedit.updateConfigurationInDb', node: CFE_NODE, label: 'updateConfigurationInDb (cfe)' },
    { command: 'v8vscedit.decompileExtensionSources', node: CFE_NODE, label: 'decompileExtensionSources (extension)' },
    { command: 'v8vscedit.updateExtensionInDb', node: CFE_NODE, label: 'updateExtensionInDb (extension)' },
    { command: 'v8vscedit.compileAndUpdateExtensionInDb', node: CFE_NODE, label: 'compileAndUpdateExtensionInDb (extension)' },
  ];

  RUN_EXCLUSIVE_CASES.forEach(({ command, node, label }) => {
    test(`guard занят «Хранилище: синхронизация» — ${label} не вызывает standaloneServerService.refreshHealth/setTreeProcessingState`, async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Хранилище: синхронизация');
      let refreshHealthCalls = 0;
      let setTreeCalls = 0;
      servicesBox.current = createServices({
        configurationOperationGuard: guard,
        standaloneServerService: {
          refreshHealth: () => { refreshHealthCalls += 1; return Promise.resolve({ configured: false, state: 'stopped' }); },
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => { setTreeCalls += 1; },
      });

      await vscode.commands.executeCommand(command, node);

      assert.strictEqual(refreshHealthCalls, 0);
      assert.strictEqual(setTreeCalls, 0);
      assert.strictEqual(guard.isBusy, true);
      assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
      lease?.release();
    });
  });

  test('guard свободен: updateChangedConfigurations без изменений → no-changes; события [true,false]; release() до markConfigurationsClean; финальный setTreeProcessingState={active:false}', async () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    guard.onDidChangeBusy((busy) => events.push(busy));
    const setTreeCalls: unknown[] = [];
    const markCleanCalls: string[][] = [];
    let getChangedCalls = 0;
    let observedDuringGetChanged: { isBusy: boolean; heldBy: string | undefined } | undefined;
    let observedDuringMarkClean: { isBusy: boolean } | undefined;

    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => {
        getChangedCalls += 1;
        observedDuringGetChanged = { isBusy: guard.isBusy, heldBy: guard.heldBy };
        return [];
      },
      markConfigurationsClean: (roots: string[]) => {
        markCleanCalls.push(roots);
        observedDuringMarkClean = { isBusy: guard.isBusy };
      },
      setTreeProcessingState: (state) => { setTreeCalls.push(state); },
    });

    const result = await vscode.commands.executeCommand('v8vscedit.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'no-changes' });
    assert.strictEqual(getChangedCalls, 1);
    assert.deepStrictEqual(observedDuringGetChanged, { isBusy: true, heldBy: 'Обновление конфигураций' });
    assert.deepStrictEqual(markCleanCalls, [[]]);
    assert.deepStrictEqual(observedDuringMarkClean, { isBusy: false });
    assert.deepStrictEqual(events, [true, false]);
    assert.deepStrictEqual(setTreeCalls.at(-1), { active: false });
  });

  test('guard свободен: одна изменённая cf, updateMainConfiguration → true — done, picker не вызван, флаг «одна цель»===true, markConfigurationsClean([[cf]])', async () => {
    const guard = new ConfigurationOperationGuard();
    const markCleanCalls: string[][] = [];
    let pickCalls = 0;
    let observedShowSuccessMessage: boolean | undefined;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: (roots: string[]) => { markCleanCalls.push(roots); },
    });
    depsBox.current = createDeps({
      pickChangedConfigurations: () => { pickCalls += 1; return Promise.resolve(undefined); },
      updateMainConfiguration: (_name, _root, _workspaceFolder, _outputChannel, showSuccessMessage) => {
        observedShowSuccessMessage = showSuccessMessage;
        return Promise.resolve(true);
      },
    });

    const result = await vscode.commands.executeCommand('v8vscedit.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME] });
    assert.strictEqual(pickCalls, 0, 'единственная изменённая конфигурация не должна открывать picker');
    assert.strictEqual(observedShowSuccessMessage, true);
    assert.deepStrictEqual(markCleanCalls, [[EXAMPLE_CF]]);
    assert.strictEqual(guard.isBusy, false);
  });

  [undefined, []].forEach((cancelledSelection) => {
    test(`guard свободен: cf+cfe изменены, pickChangedConfigurations вернул ${JSON.stringify(cancelledSelection)} — cancelled, runner'ы не вызваны`, async () => {
      const guard = new ConfigurationOperationGuard();
      servicesBox.current = createServices({
        configurationOperationGuard: guard,
        getChangedConfigurations: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 },
        ],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({
        pickChangedConfigurations: () => Promise.resolve(cancelledSelection),
      });

      const result = await vscode.commands.executeCommand('v8vscedit.updateChangedConfigurations');

      assert.deepStrictEqual(result, { status: 'cancelled' });
      assert.strictEqual(guard.isBusy, false);
    });
  });

  test('guard свободен: cf+cfe выбраны обе, cf→true, cfe→false — failed stoppedAt "EVOLC", completed только cf, порядок cf раньше cfe', async () => {
    const guard = new ConfigurationOperationGuard();
    const callOrder: string[] = [];
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => [
        { kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 },
        { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 },
      ],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: () => undefined,
    });
    depsBox.current = createDeps({
      pickChangedConfigurations: (changed) => Promise.resolve(changed),
      updateMainConfiguration: () => { callOrder.push('cf'); return Promise.resolve(true); },
      updateExtension: () => { callOrder.push('cfe'); return Promise.resolve(false); },
    });

    const result = await vscode.commands.executeCommand('v8vscedit.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'failed', completed: [CF_NAME], stoppedAt: CFE_NAME });
    assert.deepStrictEqual(callOrder, ['cf', 'cfe']);
    assert.strictEqual(guard.isBusy, false);
  });

  test('guard свободен: updateMainConfiguration бросил исключение — failed с error, showErrorMessage показан, guard свободен', async () => {
    const guard = new ConfigurationOperationGuard();
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: () => undefined,
    });
    depsBox.current = createDeps({
      updateMainConfiguration: () => Promise.reject(new Error('Конфигуратор упал')),
    });

    const result = await vscode.commands.executeCommand('v8vscedit.updateChangedConfigurations');

    assert.deepStrictEqual(result, { status: 'failed', completed: [], error: 'Конфигуратор упал' });
    assert.strictEqual(bridgeErrorMessages.length, 1);
    assert.strictEqual(guard.isBusy, false);
  });

  test('временная рабочая область без src/cf: importConfigurations — no-targets без ожидания закрытия предупреждения', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-import-no-targets-'));
    try {
      let getEntriesCalls = 0;
      servicesBox.current = createServices({
        workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'no-targets-fixture', index: 0 },
        treeProvider: { getEntries: () => { getEntriesCalls += 1; return []; } } as unknown as CommandServices['treeProvider'],
      });
      // Заглушка никогда не разрешается: если бы команда ждала закрытия
      // предупреждения (await вместо void), executeCommand здесь зависла бы
      // навсегда, и тест не завершился бы (а не просто дал неверный результат) —
      // детерминированное доказательство отсутствия await.
      bridgeWarningMessageResolver = () => new Promise<string | undefined>(() => undefined);

      const result = await vscode.commands.executeCommand('v8vscedit.importConfigurations');

      assert.deepStrictEqual(result, { status: 'no-targets' });
      assert.strictEqual(getEntriesCalls, 1);
      assert.strictEqual(bridgeWarningMessages.length, 1);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  [undefined, []].forEach((cancelledSelection) => {
    test(`guard свободен: pickImportTargets вернул ${JSON.stringify(cancelledSelection)} — cancelled, событий guard нет`, async () => {
      const guard = new ConfigurationOperationGuard();
      const events: boolean[] = [];
      guard.onDidChangeBusy((busy) => events.push(busy));
      servicesBox.current = createServices({
        configurationOperationGuard: guard,
        treeProvider: { getEntries: () => [{ kind: 'cf', rootPath: EXAMPLE_CF }] } as unknown as CommandServices['treeProvider'],
      });
      depsBox.current = createDeps({
        pickImportTargets: () => Promise.resolve(cancelledSelection),
      });

      const result = await vscode.commands.executeCommand('v8vscedit.importConfigurations');

      assert.deepStrictEqual(result, { status: 'cancelled' });
      assert.deepStrictEqual(events, []);
    });
  });

  test('guard заняли, пока был открыт выбор конфигураций для импорта — busy с чужим heldBy, runner\'ы не вызваны, чужая аренда цела', async () => {
    const guard = new ConfigurationOperationGuard();
    let foreignLease: ReturnType<ConfigurationOperationGuard['tryAcquire']>;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: { getEntries: () => [{ kind: 'cf', rootPath: EXAMPLE_CF }] } as unknown as CommandServices['treeProvider'],
    });
    depsBox.current = createDeps({
      pickImportTargets: (targets) => {
        foreignLease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация');
        return Promise.resolve(targets);
      },
    });

    const result = await vscode.commands.executeCommand('v8vscedit.importConfigurations');

    assert.deepStrictEqual(result, { status: 'busy', heldBy: 'Синхронизация с хранилищем: Основная конфигурация' });
    assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
    foreignLease?.release();
  });

  test('guard свободен: cf+EVOLC выбраны все — done completed [cf, EVOLC], reloadEntries вызван 1 раз, markConfigurationsClean([[cf, cfe]])', async () => {
    const guard = new ConfigurationOperationGuard();
    const markCleanCalls: string[][] = [];
    let reloadCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: {
        getEntries: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
        ],
      } as unknown as CommandServices['treeProvider'],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: (roots: string[]) => { markCleanCalls.push(roots); },
      reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
    });
    depsBox.current = createDeps({
      pickImportTargets: (targets) => Promise.resolve(targets),
      decompileMainConfiguration: () => Promise.resolve(true),
      decompileExtension: () => Promise.resolve(true),
    });

    const result = await vscode.commands.executeCommand('v8vscedit.importConfigurations');

    assert.deepStrictEqual(result, { status: 'done', completed: [CF_NAME, CFE_NAME] });
    assert.strictEqual(reloadCalls, 1);
    assert.deepStrictEqual(markCleanCalls, [[EXAMPLE_CF, EXAMPLE_CFE_EVOLC]]);
  });

  test('guard свободен: cf→true, cfe→false — failed stoppedAt "EVOLC", reloadEntries не вызван', async () => {
    const guard = new ConfigurationOperationGuard();
    let reloadCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: {
        getEntries: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
        ],
      } as unknown as CommandServices['treeProvider'],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: () => undefined,
      reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
    });
    depsBox.current = createDeps({
      pickImportTargets: (targets) => Promise.resolve(targets),
      decompileMainConfiguration: () => Promise.resolve(true),
      decompileExtension: () => Promise.resolve(false),
    });

    const result = await vscode.commands.executeCommand('v8vscedit.importConfigurations');

    assert.deepStrictEqual(result, { status: 'failed', completed: [CF_NAME], stoppedAt: CFE_NAME });
    assert.strictEqual(reloadCalls, 0);
  });

  test('guard свободен: decompileMainConfiguration бросил исключение — failed с error', async () => {
    const guard = new ConfigurationOperationGuard();
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: { getEntries: () => [{ kind: 'cf', rootPath: EXAMPLE_CF }] } as unknown as CommandServices['treeProvider'],
      standaloneServerService: {
        refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
      } as unknown as CommandServices['standaloneServerService'],
      setTreeProcessingState: () => undefined,
      markConfigurationsClean: () => undefined,
    });
    depsBox.current = createDeps({
      pickImportTargets: (targets) => Promise.resolve(targets),
      decompileMainConfiguration: () => Promise.reject(new Error('Конфигуратор упал')),
    });

    const result = await vscode.commands.executeCommand('v8vscedit.importConfigurations');

    assert.deepStrictEqual(result, { status: 'failed', completed: [], error: 'Конфигуратор упал' });
  });

  test('RepositoryCommands: guard занят «Хранилище: синхронизация» — repository.commit не доходит до show/resolveFullName, чужая аренда цела', async () => {
    const guard = new ConfigurationOperationGuard();
    const lease = guard.tryAcquire('Хранилище: синхронизация');
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' };
    let showCalls = 0;
    let resolveFullNameCalls = 0;
    const repositoryService = {
      resolveTargetByXmlPath: () => target,
      hasBinding: () => true,
      isConnected: () => true,
      resolveFullName: () => { resolveFullNameCalls += 1; return null; },
    } as unknown as RepositoryService;

    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      repositoryService,
      getChangedConfigurations: () => [
        { kind: 'cf', rootPath: EXAMPLE_CF, name: 'Основная конфигурация', changedFilesCount: 1 },
      ],
      repositoryCommitViewProvider: {
        show: () => { showCalls += 1; return Promise.resolve(undefined); },
      } as unknown as CommandServices['repositoryCommitViewProvider'],
    });

    await vscode.commands.executeCommand('v8vscedit.repository.commit', CF_NODE);

    assert.strictEqual(showCalls, 0);
    assert.strictEqual(resolveFullNameCalls, 0);
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
    lease?.release();
  });

  /**
   * Issue #1 — `RepositoryCommands.lock/unlock/update` теперь начинают с
   * `ensureRepositoryGuardFree` (план архитектора, критерий приёмки №2):
   * занятость guard'а проверяется ДО `askRecursiveMode`/`pickBoolean`
   * (`vscode.window.showQuickPick`), поэтому при занятом guard'е диалог выбора
   * режима не должен появляться вовсе, а чужая аренда — оставаться нетронутой.
   */
  suite('RepositoryCommands: repository.lock/unlock/update — guard занят до диалогов (issue #1)', () => {
    let originalShowQuickPick: typeof vscode.window.showQuickPick;
    let quickPickCalls: number;

    setup(() => {
      quickPickCalls = 0;
      originalShowQuickPick = vscode.window.showQuickPick;
      (vscode.window as Pick<typeof vscode.window, 'showQuickPick'>).showQuickPick = ((...args: unknown[]) => {
        quickPickCalls += 1;
        return (originalShowQuickPick as (...a: unknown[]) => Thenable<unknown>)(...args);
      }) as typeof vscode.window.showQuickPick;
    });

    teardown(() => {
      (vscode.window as Pick<typeof vscode.window, 'showQuickPick'>).showQuickPick = originalShowQuickPick;
    });

    function repositoryServiceStub(target: RepositoryTarget): RepositoryService {
      return {
        resolveTargetByXmlPath: () => target,
        hasBinding: () => true,
        isConnected: () => true,
        resolveFullName: () => 'Справочник.Тест',
        isLocked: () => false,
      } as unknown as RepositoryService;
    }

    ['v8vscedit.repository.lock', 'v8vscedit.repository.unlock', 'v8vscedit.repository.update'].forEach((command) => {
      test(`${command}: guard занят «Хранилище: синхронизация» — showQuickPick не вызывается, чужая аренда цела`, async () => {
        const guard = new ConfigurationOperationGuard();
        const lease = guard.tryAcquire('Хранилище: синхронизация');
        const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' };

        servicesBox.current = createServices({
          configurationOperationGuard: guard,
          repositoryService: repositoryServiceStub(target),
        });

        await vscode.commands.executeCommand(command, CF_NODE);

        assert.strictEqual(quickPickCalls, 0, `${command}: showQuickPick не должен вызываться при занятом guard'е.`);
        assert.strictEqual(guard.isBusy, true);
        assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
        lease?.release();
      });
    });
  });

  test('RepositoryCommands: guard свободен и изменений для конфигурации нет — repository.commit доходит до show, событий guard нет', async () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    guard.onDidChangeBusy((busy) => events.push(busy));
    const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' };
    let showCalls = 0;
    const repositoryService = {
      resolveTargetByXmlPath: () => target,
      hasBinding: () => true,
      isConnected: () => true,
      resolveFullName: () => null,
      isLocked: () => false,
    } as unknown as RepositoryService;

    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      repositoryService,
      getChangedConfigurations: () => [],
      repositoryCommitViewProvider: {
        show: () => { showCalls += 1; return Promise.resolve(undefined); },
      } as unknown as CommandServices['repositoryCommitViewProvider'],
    });

    await vscode.commands.executeCommand('v8vscedit.repository.commit', CF_NODE);

    assert.strictEqual(showCalls, 1);
    assert.deepStrictEqual(events, []);
  });

  /**
   * Issue #38: каталог `src/cfe/<имя>` создаётся только внутри захваченной
   * операции. Иначе при занятом guard он оставался пустым, и повторное
   * подключение того же расширения становилось невозможным.
   */
  suite('connectExtension — каталог расширения и общий guard (issue #38)', () => {
    type WindowStubs = Pick<typeof vscode.window, 'showQuickPick' | 'showInformationMessage' | 'showErrorMessage'>;
    const windowStubsRef = vscode.window as WindowStubs;
    let originals: WindowStubs;
    let workspaceRoot: string;
    let extensionRoot: string;
    let informationMessages: string[];
    let errorMessages: string[];
    let quickPickCalls: number;
    /** Что делает «пользователь» в QuickPick выбора расширения; по умолчанию выбирает EVOLC. */
    let onQuickPick: () => void;

    function createWorkspaceServices(overrides: Partial<CommandServices>): CommandServices {
      return createServices({
        workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'connect-fixture', index: 0 },
        ...overrides,
      });
    }

    setup(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-connect-extension-'));
      extensionRoot = path.join(workspaceRoot, 'src', 'cfe', 'EVOLC');
      informationMessages = [];
      errorMessages = [];
      quickPickCalls = 0;
      onQuickPick = () => undefined;
      originals = {
        showQuickPick: vscode.window.showQuickPick,
        showInformationMessage: vscode.window.showInformationMessage,
        showErrorMessage: vscode.window.showErrorMessage,
      };
      windowStubsRef.showQuickPick = ((items: readonly string[]) => {
        quickPickCalls += 1;
        onQuickPick();
        return Promise.resolve(items.find((item) => item === 'EVOLC'));
      }) as WindowStubs['showQuickPick'];
      windowStubsRef.showInformationMessage = ((message: string) => {
        informationMessages.push(message);
        return Promise.resolve(undefined);
      });
      windowStubsRef.showErrorMessage = ((message: string) => {
        errorMessages.push(message);
        return Promise.resolve(undefined);
      });
    });

    teardown(() => {
      windowStubsRef.showQuickPick = originals.showQuickPick;
      windowStubsRef.showInformationMessage = originals.showInformationMessage;
      windowStubsRef.showErrorMessage = originals.showErrorMessage;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test('guard занят до команды — список расширений из базы не запрашивается, каталог не создаётся', async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Импорт конфигураций');
      let listCalls = 0;
      servicesBox.current = createWorkspaceServices({ configurationOperationGuard: guard });
      depsBox.current = createDeps({
        listDatabaseExtensions: () => { listCalls += 1; return Promise.resolve(['EVOLC']); },
      });

      await vscode.commands.executeCommand('v8vscedit.connectExtension');

      assert.strictEqual(listCalls, 0);
      assert.strictEqual(quickPickCalls, 0);
      assert.deepStrictEqual(informationMessages, ['Операция с конфигурацией уже выполняется. Дождитесь её завершения.']);
      assert.strictEqual(fs.existsSync(extensionRoot), false);
      assert.strictEqual(guard.heldBy, 'Импорт конфигураций');
      lease?.release();
    });

    test('guard заняли, пока был открыт выбор расширения — каталог не создаётся, повторное подключение не блокируется', async () => {
      const guard = new ConfigurationOperationGuard();
      let foreignLease: ReturnType<ConfigurationOperationGuard['tryAcquire']>;
      servicesBox.current = createWorkspaceServices({ configurationOperationGuard: guard });
      depsBox.current = createDeps({
        listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
      });
      onQuickPick = () => { foreignLease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация'); };

      await vscode.commands.executeCommand('v8vscedit.connectExtension');

      assert.strictEqual(quickPickCalls, 1);
      assert.deepStrictEqual(informationMessages, ['Операция с конфигурацией уже выполняется. Дождитесь её завершения.']);
      assert.strictEqual(fs.existsSync(extensionRoot), false, 'пустой каталог расширения не должен оставаться');
      assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
      foreignLease?.release();

      // Каталог не остался, поэтому EVOLC снова предлагается к подключению,
      // а не отбивается как «уже подключённое».
      onQuickPick = () => undefined;
      depsBox.current = createDeps({
        listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
        decompileExtension: () => Promise.resolve(false),
      });
      servicesBox.current = createWorkspaceServices({
        configurationOperationGuard: guard,
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        reloadEntries: () => Promise.resolve(),
      });

      await vscode.commands.executeCommand('v8vscedit.connectExtension');

      assert.strictEqual(quickPickCalls, 2);
      assert.deepStrictEqual(errorMessages, []);
    });

    test('guard свободен, выгрузка удалась — каталог создан до запуска Конфигуратора и остаётся, конфигурация помечена чистой', async () => {
      const guard = new ConfigurationOperationGuard();
      const markCleanCalls: string[][] = [];
      const updateSourceCalls: string[][] = [];
      let observedDuringDecompile: { dirExists: boolean; heldBy: string | undefined } | undefined;
      servicesBox.current = createWorkspaceServices({
        configurationOperationGuard: guard,
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: (roots: string[]) => { markCleanCalls.push(roots); },
        reloadEntries: () => Promise.resolve(),
        treeProvider: { getEntries: () => [] } as unknown as CommandServices['treeProvider'],
        bslAnalyzerConfigService: {
          updateSource: (roots: string[]) => { updateSourceCalls.push(roots); },
        } as unknown as CommandServices['bslAnalyzerConfigService'],
      });
      depsBox.current = createDeps({
        listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
        decompileExtension: (name, root) => {
          observedDuringDecompile = { dirExists: fs.existsSync(root), heldBy: guard.heldBy };
          // Результат выгрузки Конфигуратора — настоящее расширение EVOLC из example/.
          fs.cpSync(EXAMPLE_CFE_EVOLC, root, { recursive: true });
          assert.strictEqual(name, 'EVOLC');
          return Promise.resolve(true);
        },
      });

      await vscode.commands.executeCommand('v8vscedit.connectExtension');

      assert.deepStrictEqual(observedDuringDecompile, { dirExists: true, heldBy: 'Подключение расширения EVOLC' });
      assert.strictEqual(fs.existsSync(path.join(extensionRoot, 'Configuration.xml')), true);
      assert.deepStrictEqual(markCleanCalls, [[extensionRoot]]);
      assert.deepStrictEqual(updateSourceCalls, [[extensionRoot]]);
      assert.strictEqual(guard.isBusy, false);
    });

    const FAILURE_CASES: { label: string; decompile: ExtensionCommandsDeps['decompileExtension'] }[] = [
      { label: 'выгрузка вернула false', decompile: () => Promise.resolve(false) },
      { label: 'выгрузка бросила исключение', decompile: () => Promise.reject(new Error('Конфигуратор завершился с ошибкой')) },
    ];

    FAILURE_CASES.forEach(({ label, decompile }) => {
      test(`guard свободен, ${label} — созданный каталог удаляется, guard освобождён`, async () => {
        const guard = new ConfigurationOperationGuard();
        let reloadCalls = 0;
        let dirExistedDuringDecompile = false;
        servicesBox.current = createWorkspaceServices({
          configurationOperationGuard: guard,
          standaloneServerService: {
            refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
          } as unknown as CommandServices['standaloneServerService'],
          setTreeProcessingState: () => undefined,
          reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
        });
        depsBox.current = createDeps({
          listDatabaseExtensions: () => Promise.resolve(['EVOLC']),
          decompileExtension: (...args) => {
            dirExistedDuringDecompile = fs.existsSync(args[1]);
            return decompile(...args);
          },
        });

        await vscode.commands.executeCommand('v8vscedit.connectExtension');

        assert.strictEqual(dirExistedDuringDecompile, true);
        assert.strictEqual(fs.existsSync(extensionRoot), false);
        assert.strictEqual(reloadCalls, 1);
        assert.strictEqual(guard.isBusy, false);
      });
    });
  });

  /**
   * Issue #39: `v8vscedit.runThinClient` (DbCommands) должен пропускать запуск
   * тонкого клиента, когда предварительное обновление конфигураций отбилось
   * `busy`. `DbRunCommandRunner` не инжектируется (архитектор не выносил его в
   * deps для этой задачи) — наблюдаемый эффект «была ли реальная попытка
   * запуска» берётся из `outputChannel`: при отсутствующем `env.json`
   * `resolveConnectionFromSettings` синхронно бросает ДО спавна процесса, и
   * `runDbClientFromWorkspace` перехватывает это в `[db-run][error]` —
   * достаточно детерминированное и безопасное (без реального процесса 1С)
   * доказательство факта попытки запуска.
   */
  suite('registerDbCommands — runThinClient через общий guard (issue #39)', () => {
    let originalShowQuickPick: typeof vscode.window.showQuickPick;
    let workspaceRoot: string;
    let outputLines: string[];

    setup(() => {
      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-db-run-'));
      outputLines = [];
      originalShowQuickPick = vscode.window.showQuickPick;
      (vscode.window as Pick<typeof vscode.window, 'showQuickPick'>).showQuickPick =
        (() => Promise.resolve({ id: 'update' })) as unknown as typeof vscode.window.showQuickPick;
    });

    teardown(() => {
      (vscode.window as Pick<typeof vscode.window, 'showQuickPick'>).showQuickPick = originalShowQuickPick;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    function createDbServices(overrides: Partial<CommandServices>): CommandServices {
      return createServices({
        workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'db-run-fixture', index: 0 },
        projectSecretStorage: {} as unknown as CommandServices['projectSecretStorage'],
        outputChannel: { appendLine: (line: string) => { outputLines.push(line); } } as unknown as vscode.OutputChannel,
        ...overrides,
      });
    }

    test('guard занят «Хранилище: синхронизация» — тонкий клиент не запускается', async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Хранилище: синхронизация');
      servicesBox.current = createDbServices({
        configurationOperationGuard: guard,
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 2 }],
      });

      await vscode.commands.executeCommand('v8vscedit.runThinClient');

      assert.strictEqual(
        outputLines.some((line) => line.includes('[db-run]')),
        false,
        'при busy тонкий клиент не должен даже пытаться разрешить подключение'
      );
      assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
      lease?.release();
    });

    test('есть изменённая cf, QuickPick подтвердил обновление, updateMainConfiguration → true (done) — тонкий клиент пытается запуститься', async () => {
      let updateRunnerCalls = 0;
      servicesBox.current = createDbServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({
        updateMainConfiguration: () => { updateRunnerCalls += 1; return Promise.resolve(true); },
      });

      await vscode.commands.executeCommand('v8vscedit.runThinClient');

      assert.strictEqual(updateRunnerCalls, 1, 'исход "done" обязан быть получен через реальный вызов runner\'а обновления');
      assert.strictEqual(
        outputLines.some((line) => line.includes('[db-run][error]') && line.includes('env.json')),
        true,
        'при успешном исходе (done) confirmUpdateBeforeThinClient тонкий клиент обязан попытаться запуститься'
      );
    });

    test('есть изменённая cf, QuickPick подтвердил обновление, updateMainConfiguration → false (failed) — тонкий клиент не запускается', async () => {
      let updateRunnerCalls = 0;
      servicesBox.current = createDbServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({
        updateMainConfiguration: () => { updateRunnerCalls += 1; return Promise.resolve(false); },
      });

      await vscode.commands.executeCommand('v8vscedit.runThinClient');

      assert.strictEqual(updateRunnerCalls, 1, 'исход "failed" обязан быть получен через реальный вызов runner\'а обновления');
      assert.strictEqual(
        outputLines.some((line) => line.includes('[db-run]')),
        false,
        'при неуспешном исходе (failed) тонкий клиент не должен даже пытаться запуститься'
      );
    });
  });

  /**
   * Issue #39: MCP-мост `v8vscedit_execute_command` идёт через
   * `vscode.commands.executeCommand`, поэтому попадает в ТЕ ЖЕ команды,
   * зарегистрированные выше на `servicesBox`/`depsProxy`. `registerConfigLifecycleTools`
   * читает из `McpRegistrationDeps` только `services`/`gate` для этого
   * конкретного tool'а (остальные поля используются другими tools того же
   * домена) — реальный `McpMutationGate` строится без внешних систем
   * (`ok`/`wrap`/`wrapAsync`/`toolError` не обращаются к `services`), а
   * `paths`/`properties`/`mutations`/`xmlEditor`/`services` — структурные
   * заглушки, которых этот tool не касается.
   */
  suite('MCP-мост v8vscedit_execute_command — общий guard и явный исход (issue #39)', () => {
    let executeCommandTool: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

    suiteSetup(() => {
      const tools = new Map<string, { handler: (args: Record<string, unknown>) => unknown }>();
      const mockServer = {
        registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => unknown) => {
          tools.set(name, { handler });
        },
      };
      const deps: McpRegistrationDeps = {
        services: {} as unknown as McpCommandServices,
        xmlEditor: {} as unknown as McpRegistrationDeps['xmlEditor'],
        paths: {} as unknown as McpRegistrationDeps['paths'],
        properties: {} as unknown as McpRegistrationDeps['properties'],
        mutations: {} as unknown as McpRegistrationDeps['mutations'],
        gate: new McpMutationGate({} as unknown as McpCommandServices),
      };
      registerConfigLifecycleTools(mockServer as unknown as McpServer, deps);
      const tool = tools.get('v8vscedit_execute_command');
      assert.ok(tool, 'v8vscedit_execute_command должен быть зарегистрирован');
      executeCommandTool = tool.handler as typeof executeCommandTool;
    });

    function extractResponse(result: unknown): Record<string, unknown> {
      const content = (result as { content: { type: string; text: string }[] }).content;
      return JSON.parse(content[0].text) as Record<string, unknown>;
    }
    function isErrorResult(result: unknown): boolean {
      return (result as { isError?: boolean }).isError === true;
    }

    ['v8vscedit.importConfigurations', 'v8vscedit.updateChangedConfigurations'].forEach((command) => {
      test(`busy: "${command}" — {command, outcome:'busy', heldBy, result:false}, аренда цела`, async () => {
        const guard = new ConfigurationOperationGuard();
        const lease = guard.tryAcquire('Синхронизация с хранилищем: Основная конфигурация');
        servicesBox.current = createServices({ configurationOperationGuard: guard });

        const result = await executeCommandTool({ command });

        assert.strictEqual(isErrorResult(result), false);
        assert.deepStrictEqual(extractResponse(result), {
          command,
          outcome: 'busy',
          heldBy: 'Синхронизация с хранилищем: Основная конфигурация',
          result: false,
        });
        assert.strictEqual(guard.heldBy, 'Синхронизация с хранилищем: Основная конфигурация');
        lease?.release();
      });
    });

    test('update: нет изменений — {outcome:"no-changes", result:true}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });

      const result = await executeCommandTool({ command: 'v8vscedit.updateChangedConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'v8vscedit.updateChangedConfigurations',
        outcome: 'no-changes',
        result: true,
      });
    });

    test('update: одна изменённая cf, успешный runner — {outcome:"done", completed:[cf], result:true}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [{ kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 }],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({ updateMainConfiguration: () => Promise.resolve(true) });

      const result = await executeCommandTool({ command: 'v8vscedit.updateChangedConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'v8vscedit.updateChangedConfigurations',
        outcome: 'done',
        completed: [CF_NAME],
        result: true,
      });
    });

    test('update: cf успешно, cfe провалилось — {outcome:"failed", completed:[cf], stoppedAt:cfe, result:false}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 },
        ],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({
        pickChangedConfigurations: (changed) => Promise.resolve(changed),
        updateMainConfiguration: () => Promise.resolve(true),
        updateExtension: () => Promise.resolve(false),
      });

      const result = await executeCommandTool({ command: 'v8vscedit.updateChangedConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'v8vscedit.updateChangedConfigurations',
        outcome: 'failed',
        completed: [CF_NAME],
        stoppedAt: CFE_NAME,
        result: false,
      });
    });

    test('update: отмена выбора — {outcome:"cancelled", result:false}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        getChangedConfigurations: () => [
          { kind: 'cf', rootPath: EXAMPLE_CF, name: CF_NAME, changedFilesCount: 1 },
          { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC, name: CFE_NAME, changedFilesCount: 1 },
        ],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
      });
      depsBox.current = createDeps({ pickChangedConfigurations: () => Promise.resolve(undefined) });

      const result = await executeCommandTool({ command: 'v8vscedit.updateChangedConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'v8vscedit.updateChangedConfigurations',
        outcome: 'cancelled',
        result: false,
      });
    });

    test('import: нет каталога src/cf — {outcome:"no-targets", result:false}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        treeProvider: { getEntries: () => [] } as unknown as CommandServices['treeProvider'],
      });

      const result = await executeCommandTool({ command: 'v8vscedit.importConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'v8vscedit.importConfigurations',
        outcome: 'no-targets',
        result: false,
      });
    });

    test('import: отмена выбора — {outcome:"cancelled", result:false}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        treeProvider: { getEntries: () => [{ kind: 'cf', rootPath: EXAMPLE_CF }] } as unknown as CommandServices['treeProvider'],
      });
      depsBox.current = createDeps({ pickImportTargets: () => Promise.resolve(undefined) });

      const result = await executeCommandTool({ command: 'v8vscedit.importConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'v8vscedit.importConfigurations',
        outcome: 'cancelled',
        result: false,
      });
    });

    test('import: cf+EVOLC выбраны все, оба успешны — {outcome:"done", completed:[cf, EVOLC], result:true}', async () => {
      servicesBox.current = createServices({
        configurationOperationGuard: new ConfigurationOperationGuard(),
        treeProvider: {
          getEntries: () => [
            { kind: 'cf', rootPath: EXAMPLE_CF },
            { kind: 'cfe', rootPath: EXAMPLE_CFE_EVOLC },
          ],
        } as unknown as CommandServices['treeProvider'],
        standaloneServerService: {
          refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped' }),
        } as unknown as CommandServices['standaloneServerService'],
        setTreeProcessingState: () => undefined,
        markConfigurationsClean: () => undefined,
        reloadEntries: () => Promise.resolve(),
      });
      depsBox.current = createDeps({
        pickImportTargets: (targets) => Promise.resolve(targets),
        decompileMainConfiguration: () => Promise.resolve(true),
        decompileExtension: () => Promise.resolve(true),
      });

      const result = await executeCommandTool({ command: 'v8vscedit.importConfigurations' });

      assert.deepStrictEqual(extractResponse(result), {
        command: 'v8vscedit.importConfigurations',
        outcome: 'done',
        completed: [CF_NAME, CFE_NAME],
        result: true,
      });
    });

    suite('refresh — фейковая регистрация команды на время теста', () => {
      let disposable: vscode.Disposable | undefined;

      teardown(() => {
        disposable?.dispose();
        disposable = undefined;
      });

      test('успешный refresh — {outcome:"done", completed:[], result:true}, команда вызвана 1 раз', async () => {
        let calls = 0;
        disposable = vscode.commands.registerCommand('v8vscedit.refresh', () => { calls += 1; });

        const result = await executeCommandTool({ command: 'v8vscedit.refresh' });

        assert.deepStrictEqual(extractResponse(result), {
          command: 'v8vscedit.refresh',
          outcome: 'done',
          completed: [],
          result: true,
        });
        assert.strictEqual(calls, 1);
      });

      test('refresh бросил исключение — isError:true, текст ошибки', async () => {
        disposable = vscode.commands.registerCommand('v8vscedit.refresh', () => {
          throw new Error('x');
        });

        const result = await executeCommandTool({ command: 'v8vscedit.refresh' });

        assert.strictEqual(isErrorResult(result), true);
        assert.strictEqual(result.content[0].text, 'x');
      });
    });
  });
});
