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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { type ConnectExtensionDeps, registerExtensionCommands } from '../../ui/commands/ext/ExtensionCommands';
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

/**
 * Запрос списка расширений и декомпиляция — запуск Конфигуратора 1С, которого
 * нет в тестовом окружении, поэтому они подменяются. По умолчанию — throw-стабы:
 * сценарии, не касающиеся `connectExtension`, не должны до них доходить.
 */
function createConnectDeps(overrides: Partial<ConnectExtensionDeps> = {}): ConnectExtensionDeps {
  return {
    listDatabaseExtensions: notCalled('listDatabaseExtensions'),
    decompileExtension: notCalled('decompileExtension'),
    ...overrides,
  };
}

const connectDepsBox: { current: ConnectExtensionDeps } = { current: createConnectDeps() };

const connectDepsProxy: ConnectExtensionDeps = {
  listDatabaseExtensions: (...args) => connectDepsBox.current.listDatabaseExtensions(...args),
  decompileExtension: (...args) => connectDepsBox.current.decompileExtension(...args),
};

suite('ConfigurationOperationGuard — интеграция ExtensionCommands/RepositoryCommands (issue #10)', () => {
  let context: vscode.ExtensionContext;

  suiteSetup(() => {
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerExtensionCommands(context, createServicesProxy(), connectDepsProxy);
    registerRepositoryCommands(context, createServicesProxy());
  });

  suiteTeardown(async () => {
    (context.subscriptions as vscode.Disposable[]).forEach((subscription) => { subscription.dispose(); });
    await disposeCachedAgentOperationServices();
  });

  setup(() => {
    servicesBox.current = createServices();
    connectDepsBox.current = createConnectDeps();
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

  /**
   * Issue #38: каталог `src/cfe/<имя>` создаётся только внутри захваченной
   * операции. Иначе при занятом guard он оставался пустым, и повторное
   * подключение того же расширения становилось невозможным.
   */
  suite('connectExtension — каталог расширения и общий guard (issue #38)', () => {
    type WindowStubs = Pick<typeof vscode.window, 'showQuickPick' | 'showInformationMessage' | 'showErrorMessage'>;
    const windowRef = vscode.window as WindowStubs;
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
      windowRef.showQuickPick = ((items: readonly string[]) => {
        quickPickCalls += 1;
        onQuickPick();
        return Promise.resolve(items.find((item) => item === 'EVOLC'));
      }) as WindowStubs['showQuickPick'];
      windowRef.showInformationMessage = ((message: string) => {
        informationMessages.push(message);
        return Promise.resolve(undefined);
      });
      windowRef.showErrorMessage = ((message: string) => {
        errorMessages.push(message);
        return Promise.resolve(undefined);
      });
    });

    teardown(() => {
      windowRef.showQuickPick = originals.showQuickPick;
      windowRef.showInformationMessage = originals.showInformationMessage;
      windowRef.showErrorMessage = originals.showErrorMessage;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test('guard занят до команды — список расширений из базы не запрашивается, каталог не создаётся', async () => {
      const guard = new ConfigurationOperationGuard();
      const lease = guard.tryAcquire('Импорт конфигураций');
      let listCalls = 0;
      servicesBox.current = createWorkspaceServices({ configurationOperationGuard: guard });
      connectDepsBox.current = createConnectDeps({
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
      connectDepsBox.current = createConnectDeps({
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
      connectDepsBox.current = createConnectDeps({
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
      connectDepsBox.current = createConnectDeps({
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

    const FAILURE_CASES: { label: string; decompile: ConnectExtensionDeps['decompileExtension'] }[] = [
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
        connectDepsBox.current = createConnectDeps({
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
});
