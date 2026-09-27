import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { CommandServices } from '../../ui/commands/_shared';
import type { RepositoryBindDeps } from '../../ui/commands/repository/RepositoryBindFlow';
import { decodeLogFile, type RepositoryCliRequest, type RepositoryCliResult } from '../../ui/commands/repository/RepositoryCommandRunner';
import { registerRepositoryCommands } from '../../ui/commands/repository/RepositoryCommands';
import { DEFAULT_REPOSITORY_FILE_SYNC_DEPS, type RepositoryFileSyncDeps } from '../../ui/commands/repository/RepositoryFileSyncShared';
import type { RepositoryConnectionFormData } from '../../ui/views/RepositoryConnectionViewProvider';
import {
  BIND_LOCKS_ROOT,
  createLockWorkspace,
  createMapSecretStore,
  scenarioFixturePath,
  type LockWorkspace,
} from './support/repositoryLockFixtures';

/**
 * Команды «Подключить к хранилищу» и «Создать хранилище» через vscode.commands (issue #106):
 * после успешной привязки команда дожидается завершения (пост-синхронизация и определение своих
 * захватов). Реальные RepositoryService над копией example/2.21 и ConfigurationOperationGuard;
 * заглушки — процесс 1С (runRepositoryCli отдаёт реальный вывод привязки из
 * example/repository/2.21-bind), пост-синхронизация, форма подключения и vscode.window.show*Message.
 * Регистрация — один раз на suite (id команд нельзя зарегистрировать повторно без dispose),
 * тесты подменяют содержимое через прокси.
 */

const FORM_ITEM = 'Справочник.Контрагенты.Форма.ФормаЭлемента';
const FORM_LIST = 'Справочник.Контрагенты.Форма.ФормаСписка';

function readFixture(file: string): string {
  return decodeLogFile(fs.readFileSync(scenarioFixturePath(BIND_LOCKS_ROOT, '8.5.1', file)));
}

interface Box {
  services: CommandServices;
  deps: RepositoryFileSyncDeps;
  bindDeps: RepositoryBindDeps;
}

function proxyOf<T extends object>(read: () => T): T {
  return new Proxy({}, { get: (_target, prop: PropertyKey): unknown => Reflect.get(read(), prop) }) as T;
}

type WindowMessages = Pick<typeof vscode.window, 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage'>;

suite('RepositoryCommands — подключение и создание хранилища определяют свои захваты (issue #106)', () => {
  const windowRef = vscode.window as WindowMessages;
  let original: WindowMessages;
  let context: vscode.ExtensionContext;
  let box: Box;
  let ws: LockWorkspace;
  let errors: string[];
  let cliRequests: { request: RepositoryCliRequest; heldBy: string | undefined }[];
  let postSyncCalls: RepositoryTarget[];
  let formData: RepositoryConnectionFormData;
  let cliResult: RepositoryCliResult;

  suiteSetup(() => {
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerRepositoryCommands(context, proxyOf(() => box.services), proxyOf(() => box.deps), proxyOf(() => box.bindDeps));
    original = {
      showInformationMessage: vscode.window.showInformationMessage,
      showWarningMessage: vscode.window.showWarningMessage,
      showErrorMessage: vscode.window.showErrorMessage,
    };
    windowRef.showInformationMessage = () => Promise.resolve(undefined);
    windowRef.showWarningMessage = () => Promise.resolve(undefined);
    windowRef.showErrorMessage = (message: string) => {
      errors.push(message);
      return Promise.resolve(undefined);
    };
  });

  suiteTeardown(() => {
    (context.subscriptions as vscode.Disposable[]).forEach((subscription) => { subscription.dispose(); });
    windowRef.showInformationMessage = original.showInformationMessage;
    windowRef.showWarningMessage = original.showWarningMessage;
    windowRef.showErrorMessage = original.showErrorMessage;
  });

  setup(async () => {
    ws = await createLockWorkspace();
    errors = [];
    cliRequests = [];
    postSyncCalls = [];
    formData = { repoPath: scenarioFixturePath(BIND_LOCKS_ROOT, '8.5.1'), repoUser: 'Petrov', repoPassword: '123' };
    cliResult = { status: 'done', output: readFixture('bind-own-locks.out.txt') };
    const guard = new ConfigurationOperationGuard();
    box = {
      services: {
        repositoryService: ws.service,
        projectSecretStorage: new ProjectSecretStorage(createMapSecretStore(), ws.workspaceRoot),
        configurationOperationGuard: guard,
        workspaceFolder: { uri: vscode.Uri.file(ws.workspaceRoot), name: 'ws', index: 0 },
        outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
        treeProvider: { refresh: () => undefined } as unknown as CommandServices['treeProvider'],
        refreshActionsView: () => undefined,
        repositoryConnectionViewProvider: { show: () => Promise.resolve(formData) } as unknown as CommandServices['repositoryConnectionViewProvider'],
      } as unknown as CommandServices,
      deps: {
        ...DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
        runRepositoryCli: (request) => {
          cliRequests.push({ request, heldBy: guard.heldBy });
          return Promise.resolve(cliResult);
        },
        notifyBusy: () => { throw new Error('guard не должен быть занят'); },
      },
      bindDeps: {
        runPostSync: (target) => {
          postSyncCalls.push(target);
          return Promise.resolve('done');
        },
        // Недоверенная область: опроса нет, свои захваты — только из вывода привязки.
        isWorkspaceTrusted: () => false,
        notifyWarning: () => undefined,
        now: () => new Date(2026, 8, 27, 13, 0, 0),
      },
    };
  });

  teardown(() => ws.dispose());

  const node = (): { xmlPath: string; nodeKind: string; label: string } =>
    ({ xmlPath: path.join(ws.configRoot, 'Configuration.xml'), nodeKind: 'configuration', label: 'ТорговыйУчет' });

  const lockState = (fullName: string): string => ws.service.lockState.getLockInfo(ws.target, fullName).state;

  test('connect: привязка под арендой, команда ждёт пост-синхронизацию и определение своих захватов', async () => {
    await vscode.commands.executeCommand('v8vscedit.repository.connect', node());
    assert.deepStrictEqual(cliRequests.map((item) => [item.request.command, item.heldBy]),
      [['repository-bind', 'Подключение к хранилищу: ТорговыйУчет']]);
    assert.deepStrictEqual(postSyncCalls, [ws.target]);
    assert.strictEqual(ws.service.hasBinding(ws.target), true);
    assert.strictEqual(lockState(FORM_ITEM), 'own-elsewhere');
    assert.strictEqual(lockState(FORM_LIST), 'own-elsewhere');
    assert.deepStrictEqual(errors, []);
  });

  test('connect: отказ «Конфигурация не пустая!» — подсказка про -ForceReplaceCfg, пост-синхронизации нет', async () => {
    cliResult = { status: 'failed', message: 'Ошибка при подключении к хранилищу: Ошибка подключения', output: readFixture('bind-not-empty.out.txt') };
    await vscode.commands.executeCommand('v8vscedit.repository.connect', node());
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('(-ForceReplaceCfg)'), errors[0]);
    assert.deepStrictEqual(postSyncCalls, []);
    assert.strictEqual(ws.service.hasBinding(ws.target), false);
  });

  for (const noBind of [true, false]) {
    test(`create, noBind=${String(noBind)}: пост-синхронизация и определение захватов ${noBind ? 'не выполняются' : 'получают вывод'}`, async () => {
      formData = { ...formData, noBind };
      await vscode.commands.executeCommand('v8vscedit.repository.create', node());
      assert.deepStrictEqual(cliRequests.map((item) => item.request.command), ['repository-create']);
      assert.strictEqual(postSyncCalls.length, noBind ? 0 : 1);
      assert.strictEqual(lockState(FORM_ITEM), noBind ? 'free' : 'own-elsewhere');
      assert.strictEqual(ws.service.isConnected(ws.target), !noBind);
    });
  }
});
