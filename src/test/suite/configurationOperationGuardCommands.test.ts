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
 * `registerExtensionCommands`/`registerRepositoryCommands` с фейковым
 * `context = { subscriptions: [] }` не конфликтует с уже существующими
 * командами. Команды регистрируются один раз на весь suite (`suiteSetup`) с
 * прокси на подменяемый `CommandServices`, чтобы каждый тест мог задать свой
 * набор стабов, не пересоздавая регистрацию (VS Code не позволяет повторно
 * зарегистрировать тот же id без dispose предыдущей регистрации).
 *
 * `RepositoryService`, `standaloneServerService`, `repositoryCommitViewProvider`
 * и остальные внешние по отношению к guard'у сервисы — записывающие стабы;
 * реальный смысл проверки — что при занятом guard соответствующие runner'ы
 * НЕ вызываются, а не бизнес-логика самих runner'ов (она уже покрыта другими
 * suite). Пути узлов — реальные фикстуры `example/2.21/src/cf` и
 * `example/2.21/src/cfe/EVOLC`.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerExtensionCommands } from '../../ui/commands/ext/ExtensionCommands';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/ExtensionCommandRunner';
import { registerRepositoryCommands } from '../../ui/commands/repository/RepositoryCommands';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import type { CommandServices, NodeArg } from '../../ui/commands/_shared';
import type { RepositoryService, RepositoryTarget } from '../../infra/repository/RepositoryService';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_CFE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

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

suite('ConfigurationOperationGuard — интеграция ExtensionCommands/RepositoryCommands (issue #10)', () => {
  let context: vscode.ExtensionContext;

  suiteSetup(() => {
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerExtensionCommands(context, createServicesProxy());
    registerRepositoryCommands(context, createServicesProxy());
  });

  suiteTeardown(async () => {
    (context.subscriptions as vscode.Disposable[]).forEach((subscription) => { subscription.dispose(); });
    await disposeCachedAgentOperationServices();
  });

  setup(() => {
    servicesBox.current = createServices();
  });

  test('guard занят «Хранилище: синхронизация» — updateChangedConfigurations быстро разрешается в false, getChangedConfigurations/setTreeProcessingState не вызваны, аренда цела', async () => {
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

    assert.strictEqual(result, false);
    assert.strictEqual(getChangedCalls, 0);
    assert.strictEqual(setTreeCalls, 0);
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
    lease?.release();
  });

  test('guard занят «Хранилище: синхронизация» — importConfigurations разрешается, treeProvider.getEntries не вызван', async () => {
    const guard = new ConfigurationOperationGuard();
    const lease = guard.tryAcquire('Хранилище: синхронизация');
    let getEntriesCalls = 0;
    servicesBox.current = createServices({
      configurationOperationGuard: guard,
      treeProvider: { getEntries: () => { getEntriesCalls += 1; return []; } } as unknown as CommandServices['treeProvider'],
    });

    await vscode.commands.executeCommand('v8vscedit.importConfigurations');

    assert.strictEqual(getEntriesCalls, 0);
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Хранилище: синхронизация');
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

  test('guard свободен: updateChangedConfigurations без изменений → true; события [true,false]; release() до markConfigurationsClean; финальный setTreeProcessingState={active:false}', async () => {
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

    assert.strictEqual(result, true);
    assert.strictEqual(getChangedCalls, 1);
    assert.deepStrictEqual(observedDuringGetChanged, { isBusy: true, heldBy: 'Обновление конфигураций' });
    assert.deepStrictEqual(markCleanCalls, [[]]);
    assert.deepStrictEqual(observedDuringMarkClean, { isBusy: false });
    assert.deepStrictEqual(events, [true, false]);
    assert.deepStrictEqual(setTreeCalls.at(-1), { active: false });
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
});
