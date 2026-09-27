import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RepositoryLockStatusSyncResult } from '../../infra/repository/RepositoryLockStatusService';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { CommandServices } from '../../ui/commands/_shared';
import {
  describeLockStatusResult,
  refreshRepositoryLockStatuses,
  registerRepositoryLockStatusCommands,
  syncRepositoryLockStatusesOnStartup,
  type RepositoryLockStatusNotifier,
  type RepositoryLockStatusServices,
} from '../../ui/commands/repository/RepositoryLockStatusCommands';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import {
  createLockWorkspace,
  lockFixturePath,
  readRun,
  readTcpExchange,
  requestVersion,
  startTcpReplayServer,
  tcpRequestBody,
  type LockWorkspace,
  type LoopbackServer,
} from './support/repositoryLockFixtures';

/**
 * Команда «Обновить статусы захватов» и автообновление при старте (issue #6): реальный
 * RepositoryService над копией example/2.21; дерево и панель действий — счётчики вызовов,
 * уведомления — шпион notifier (обёртка над vscode.window в тестах не участвует).
 */

const ROOT = path.resolve(__dirname, '../../..');
const TARGET: RepositoryTarget = { configRoot: '/x', configKind: 'cf', displayName: 'ТорговыйУчет' };

interface Spy extends RepositoryLockStatusNotifier {
  readonly messages: { level: string; message: string }[];
}

function spyNotifier(): Spy {
  const messages: { level: string; message: string }[] = [];
  return {
    messages,
    info: (message) => messages.push({ level: 'info', message }),
    warning: (message) => messages.push({ level: 'warning', message }),
    error: (message) => messages.push({ level: 'error', message }),
  };
}

interface Harness {
  ws: LockWorkspace;
  services: RepositoryLockStatusServices;
  log: string[];
  readonly refreshes: number;
}

function harnessFor(ws: LockWorkspace): Harness {
  const log: string[] = [];
  let refreshes = 0;
  const services: RepositoryLockStatusServices = {
    repositoryService: ws.service,
    // Дерево и панель действий — только счётчики обновлений; список целей — настоящий корень копии.
    treeProvider: {
      getEntries: () => [{ rootPath: ws.configRoot, kind: 'cf' }],
      refresh: () => { refreshes += 1; },
    } as unknown as MetadataTreeProvider,
    refreshActionsView: () => undefined,
    outputChannel: { appendLine: (line: string) => log.push(line) } as unknown as vscode.OutputChannel,
  };
  return { ws, services, log, get refreshes() { return refreshes; } };
}

suite('RepositoryLockStatusCommands — описание исхода (issue #6)', () => {
  test('synced: счётчики, вне проекта и неподтверждённые', () => {
    const result: RepositoryLockStatusSyncResult = { status: 'synced', foreign: 5, own: 3, unmatched: 2, changed: ['a'], ownElsewhere: ['Справочник.А'], unconfirmed: ['Справочник.Б'] };
    const described = describeLockStatusResult(TARGET, result);
    assert.strictEqual(described.level, 'info');
    for (const part of ['ТорговыйУчет', 'чужих — 5', 'своих — 3', 'не найдено в выгрузке — 2', 'вне проекта — 1', 'не подтверждено сервером — 1']) {
      assert.ok(described.message.includes(part), `${part} в «${described.message}»`);
    }
    const plain = describeLockStatusResult(TARGET, { ...result, unmatched: 0, ownElsewhere: [], unconfirmed: [] }).message;
    assert.ok(!plain.includes('не найдено') && !plain.includes('вне проекта') && !plain.includes('не подтверждено'), plain);
  });

  test('not-connected и stale — предупреждения', () => {
    assert.deepStrictEqual(describeLockStatusResult(TARGET, { status: 'not-connected' }).level, 'warning');
    const stale = describeLockStatusResult(TARGET, { status: 'stale' });
    assert.strictEqual(stale.level, 'warning');
    assert.match(stale.message, /повторите/);
  });

  const codes: Extract<RepositoryLockStatusSyncResult, { status: 'failed' }>['code'][] = [
    'not-found', 'unavailable', 'unsupported-format', 'corrupted', 'invalid-address', 'timeout', 'tls', 'protocol',
    'too-large', 'auth-failed', 'server-error', 'version-mismatch', 'no-dump-info', 'unknown',
  ];
  for (const code of codes) {
    test(`failed/${code} — ошибка с причиной`, () => {
      const described = describeLockStatusResult(TARGET, { status: 'failed', code, reason: `причина ${code}` });
      assert.strictEqual(described.level, 'error');
      assert.ok(described.message.includes('ТорговыйУчет') && described.message.includes(`причина ${code}`), described.message);
    });
  }
});

suite('RepositoryLockStatusCommands — обновление и автообновление (issue #6)', () => {
  const disposables: { dispose(): unknown }[] = [];
  const servers: LoopbackServer[] = [];
  const run = readRun('8.5.1');

  teardown(async () => {
    disposables.splice(0).forEach((item) => item.dispose());
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function fileHarness(repoUser = 'Admin'): Promise<Harness> {
    const ws = await createLockWorkspace({ repoPath: lockFixturePath('8.5.1'), repoUser, repoPassword: '' });
    disposables.push(ws);
    return harnessFor(ws);
  }

  async function networkHarness(repoPassword: string): Promise<Harness> {
    const ok = readTcpExchange('8.5.1', 'statistic-petrov').server;
    const server = await startTcpReplayServer(ok, (client) =>
      (requestVersion(tcpRequestBody(client)) !== run.platform ? readTcpExchange('8.5.1', 'version-mismatch').server
        : repoPassword === '123' ? ok : readTcpExchange('8.5.1', 'auth-failed').server));
    servers.push(server);
    const ws = await createLockWorkspace({ repoPath: `tcp://127.0.0.1:${String(server.port)}/${run.alias}`, repoUser: 'Petrov', repoPassword });
    disposables.push(ws);
    return harnessFor(ws);
  }

  const rootNode = (harness: Harness): { nodeKind: string; label: string; xmlPath: string } =>
    ({ nodeKind: 'configuration', label: 'ТорговыйУчет', xmlPath: path.join(harness.ws.configRoot, 'Configuration.xml') });

  test('файловая цель по узлу: info, дерево обновлено один раз; повтор без изменений — без обновления', async () => {
    const harness = await fileHarness();
    const notifier = spyNotifier();
    await refreshRepositoryLockStatuses(rootNode(harness), harness.services, notifier);
    assert.deepStrictEqual(notifier.messages.map((item) => item.level), ['info']);
    assert.strictEqual(harness.refreshes, 1);
    assert.ok(harness.log.some((line) => line.includes('[repository][locks]') && line.includes('вне проекта')));
    await refreshRepositoryLockStatuses(rootNode(harness), harness.services, notifier);
    assert.strictEqual(harness.refreshes, 1);
  });

  test('неподтверждённый локальный захват — предупреждение в логе', async () => {
    const harness = await fileHarness();
    harness.ws.service.lockState.applyLock(harness.ws.target, { anchor: 'Справочник.Номенклатура', members: ['Справочник.Номенклатура'] });
    await refreshRepositoryLockStatuses(rootNode(harness), harness.services, spyNotifier());
    assert.ok(harness.log.some((line) => line.includes('не подтверждены сервером') && line.includes('Справочник.Номенклатура')));
  });

  test('сетевая цель (loopback): info', async () => {
    const harness = await networkHarness('123');
    const notifier = spyNotifier();
    await refreshRepositoryLockStatuses(rootNode(harness), harness.services, notifier);
    assert.deepStrictEqual(notifier.messages.map((item) => item.level), ['info']);
  });

  test('сетевой отказ аутентификации: error с подсказкой про пароль', async () => {
    const harness = await networkHarness('wrong');
    const notifier = spyNotifier();
    await refreshRepositoryLockStatuses(rootNode(harness), harness.services, notifier);
    assert.strictEqual(notifier.messages.length, 1);
    assert.strictEqual(notifier.messages[0].level, 'error');
    assert.match(notifier.messages[0].message, /Подключить к хранилищу/);
  });

  test('узел вне конфигурации — error', async () => {
    const harness = await fileHarness();
    const notifier = spyNotifier();
    await refreshRepositoryLockStatuses({ nodeKind: 'configuration', label: 'x' }, harness.services, notifier);
    assert.deepStrictEqual(notifier.messages.map((item) => item.level), ['error']);
  });

  test('без узла — все подключённые цели; нет подключённых — предупреждение', async () => {
    const harness = await fileHarness();
    const notifier = spyNotifier();
    await refreshRepositoryLockStatuses(undefined, harness.services, notifier);
    assert.deepStrictEqual(notifier.messages.map((item) => item.level), ['info']);
    harness.ws.service.setConnected(harness.ws.target, false);
    await refreshRepositoryLockStatuses(undefined, harness.services, notifier);
    assert.deepStrictEqual(notifier.messages.map((item) => item.level), ['info', 'warning']);
  });

  test('автообновление: только лог, дерево обновлено при изменениях; повтор без изменений — без обновления', async () => {
    const harness = await fileHarness();
    await syncRepositoryLockStatusesOnStartup(harness.services, true);
    assert.strictEqual(harness.refreshes, 1);
    assert.ok(harness.log.some((line) => line.includes('[repository][locks]') && line.includes('ТорговыйУчет')));
    await syncRepositoryLockStatusesOnStartup(harness.services, true);
    assert.strictEqual(harness.refreshes, 1);
  });

  test('автообновление: ошибки только в лог', async () => {
    const harness = await networkHarness('wrong');
    await syncRepositoryLockStatusesOnStartup(harness.services, true);
    assert.ok(harness.log.some((line) => line.includes('[repository][locks]') && line.includes('Подключить к хранилищу')));
    assert.strictEqual(harness.refreshes, 0);
  });

  test('автообновление в недоверенной рабочей области не обращается к хранилищу, причина — в лог', async () => {
    const harness = await networkHarness('123');
    await syncRepositoryLockStatusesOnStartup(harness.services, false);
    assert.strictEqual(servers[0].requests.length, 0);
    assert.ok(harness.log.some((line) => line.includes('недоверенн')));
  });

  test('автообновление не отклоняется при повреждённом env.json', async () => {
    const harness = await fileHarness();
    fs.writeFileSync(harness.ws.service.getEnvJsonPath(), '{ битый', 'utf-8');
    await syncRepositoryLockStatusesOnStartup(harness.services, true);
    assert.ok(harness.log.some((line) => line.includes('[repository][locks]') && line.includes('env.json повреждён')));
  });

  test('регистрация: команда выполняется через vscode.commands и объявлена в package.json', async () => {
    const harness = await fileHarness();
    const notifier = spyNotifier();
    const context = { subscriptions: [] as { dispose(): unknown }[] } as unknown as vscode.ExtensionContext;
    registerRepositoryLockStatusCommands(context, harness.services as unknown as CommandServices, notifier);
    disposables.push(...context.subscriptions);
    assert.ok((await vscode.commands.getCommands(true)).includes('v8vscedit.repository.refreshLocks'));
    await vscode.commands.executeCommand('v8vscedit.repository.refreshLocks', rootNode(harness));
    assert.deepStrictEqual(notifier.messages.map((item) => item.level), ['info']);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { contributes: { commands: { command: string; title: string; icon?: string }[] } };
    assert.deepStrictEqual(
      manifest.contributes.commands.find((item) => item.command === 'v8vscedit.repository.refreshLocks'),
      { command: 'v8vscedit.repository.refreshLocks', title: 'Обновить статусы захватов', icon: '$(refresh)' }
    );
  });
});
