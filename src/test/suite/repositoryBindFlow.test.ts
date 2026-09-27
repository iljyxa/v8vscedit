import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import { RepositoryService, type RepositoryBinding, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ConfigurationScaffoldService } from '../../infra/xml';
import {
  completeRepositoryBind,
  formatOwnElsewhereName,
  MAX_LISTED_OWN_ELSEWHERE,
  validateBindingForm,
  type RepositoryBindDeps,
  type RepositoryBindServices,
} from '../../ui/commands/repository/RepositoryBindFlow';
import { decodeLogFile } from '../../ui/commands/repository/RepositoryCommandRunner';
import type { PostRepositorySyncOutcome } from '../../ui/commands/repository/RepositoryDatabaseSync';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import {
  BIND_LOCKS_ROOT,
  createLockWorkspace,
  createMapSecretStore,
  EXAMPLE_CF_221,
  LOCK_FIXTURE_VERSIONS,
  must,
  PARTIAL_ROOT_ROOT,
  readRun,
  readTcpExchange,
  requestVersion,
  scenarioFixturePath,
  startTcpReplayServer,
  tcpRequestBody,
  type LockFixtureVersion,
  type LockWorkspace,
  type LoopbackServer,
} from './support/repositoryLockFixtures';

/**
 * Завершение подключения к хранилищу (issue #106): реальный RepositoryService над копией
 * example/2.21 или пустым проектом из ConfigurationScaffoldService, реальные фикстуры
 * хранилища (1CD и вывод привязки example/repository/2.21-bind, обмены crserver 2.21-locks).
 * Заглушка — только пост-синхронизация (процесс 1С недоступен в тестах): она либо копирует
 * example/2.21/src/cf в корень проекта (как импорт конфигурации хранилища), либо ничего не
 * делает и возвращает исход сбоя. Дерево и панель действий — счётчики, журнал — массив,
 * предупреждение — шпион.
 */

const EXAMPLE_CFE_EVOLC = path.resolve(EXAMPLE_CF_221, '..', 'cfe', 'EVOLC');
const FORM_ITEM = 'Справочник.Контрагенты.Форма.ФормаЭлемента';
const FORM_LIST = 'Справочник.Контрагенты.Форма.ФормаСписка';
const NOW = new Date(2026, 8, 27, 13, 0, 0);
const OBSERVED_AT = '2026-09-27T13:00:00';

function notCalled(name: string): () => never {
  return () => {
    throw new Error(`"${name}" не должен вызываться`);
  };
}

function readBindOutput(version: LockFixtureVersion): string {
  return decodeLogFile(fs.readFileSync(scenarioFixturePath(BIND_LOCKS_ROOT, version, 'bind-own-locks.out.txt')));
}

const sortRu = (names: readonly string[]): string[] => [...names].sort((left, right) => left.localeCompare(right, 'ru'));

interface Harness {
  readonly ws: LockWorkspace;
  readonly services: RepositoryBindServices;
  readonly log: string[];
  readonly warnings: string[];
  readonly postSyncCalls: RepositoryTarget[];
  readonly refreshes: number;
  deps(options: { trusted?: boolean; postSync?: PostRepositorySyncOutcome; importOnPostSync?: boolean; clearOnPostSync?: boolean }): RepositoryBindDeps;
  readScope(): Record<string, unknown>;
}

function harnessFor(ws: LockWorkspace): Harness {
  const log: string[] = [];
  const warnings: string[] = [];
  const postSyncCalls: RepositoryTarget[] = [];
  let refreshes = 0;
  const services = {
    repositoryService: ws.service,
    treeProvider: { refresh: () => { refreshes += 1; } } as unknown as MetadataTreeProvider,
    refreshActionsView: () => undefined,
    outputChannel: { appendLine: (line: string) => log.push(line) } as unknown as vscode.OutputChannel,
    configurationOperationGuard: new ConfigurationOperationGuard(),
    workspaceFolder: { uri: { fsPath: ws.workspaceRoot }, name: 'ws', index: 0 } as unknown as vscode.WorkspaceFolder,
    getChangedConfigurations: notCalled('getChangedConfigurations'),
    markConfigurationsClean: notCalled('markConfigurationsClean'),
    reloadEntries: notCalled('reloadEntries'),
  } as unknown as RepositoryBindServices;
  return {
    ws,
    services,
    log,
    warnings,
    postSyncCalls,
    get refreshes() { return refreshes; },
    deps: ({ trusted = true, postSync = 'done', importOnPostSync = false, clearOnPostSync = false }) => ({
      runPostSync: (target) => {
        postSyncCalls.push(target);
        if (importOnPostSync) {
          // Импорт конфигурации хранилища заменяет выгрузку проекта целиком.
          fs.rmSync(ws.configRoot, { recursive: true, force: true });
          fs.cpSync(EXAMPLE_CF_221, ws.configRoot, { recursive: true });
        }
        if (clearOnPostSync) {
          // Сбой импорта после очистки каталога выгрузки: Configuration.xml больше нет.
          fs.rmSync(ws.configRoot, { recursive: true, force: true });
        }
        return Promise.resolve(postSync);
      },
      isWorkspaceTrusted: () => trusted,
      notifyWarning: (message) => { warnings.push(message); },
      now: () => NOW,
    }),
    readScope: () => {
      const file = path.join(ws.workspaceRoot, '.v8vscedit', 'repository', 'state.json');
      if (!fs.existsSync(file)) {
        return {};
      }
      const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as { scopes: Record<string, Record<string, unknown>> };
      return Object.values(state.scopes)[0] ?? {};
    },
  };
}

/** Пустой проект: реальная заготовка конфигурации «Пустая» и привязка к хранилищу. */
async function createEmptyWorkspace(binding: RepositoryBinding): Promise<LockWorkspace> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-bind-empty-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  new ConfigurationScaffoldService().createConfiguration({ name: 'Пустая', outputDir: configRoot });
  const service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createMapSecretStore(), workspaceRoot));
  const target = must(service.resolveTargetByConfigRoot(configRoot), 'цель пустого проекта');
  await service.saveBinding(target, binding);
  return { workspaceRoot, configRoot, service, target, dispose: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }) };
}

suite('completeRepositoryBind — завершение подключения к хранилищу (issue #106)', () => {
  const disposables: { dispose(): unknown }[] = [];
  const servers: LoopbackServer[] = [];
  const run = readRun('8.5.1');

  teardown(async () => {
    disposables.splice(0).forEach((item) => item.dispose());
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function fileHarness(version: LockFixtureVersion, empty = false): Promise<Harness> {
    const binding = { repoPath: scenarioFixturePath(BIND_LOCKS_ROOT, version), repoUser: 'Petrov', repoPassword: '123' };
    const ws = empty ? await createEmptyWorkspace(binding) : await createLockWorkspace(binding);
    disposables.push(ws);
    return harnessFor(ws);
  }

  /** crserver на loopback с обменом statistic-petrov; `beforeRespond` — вмешательство до ответа. */
  async function networkHarness(beforeRespond: (ws: LockWorkspace) => void = () => undefined): Promise<{ harness: Harness; server: LoopbackServer }> {
    const ok = readTcpExchange('8.5.1', 'statistic-petrov').server;
    const box: { ws?: LockWorkspace } = {};
    const server = await startTcpReplayServer(ok, (client) => {
      beforeRespond(must(box.ws, 'рабочая область'));
      return requestVersion(tcpRequestBody(client)) !== run.platform ? readTcpExchange('8.5.1', 'version-mismatch').server : ok;
    });
    servers.push(server);
    const ws = await createLockWorkspace({ repoPath: `tcp://127.0.0.1:${String(server.port)}/${run.alias}`, repoUser: 'Petrov', repoPassword: '123' });
    box.ws = ws;
    disposables.push(ws);
    return { harness: harnessFor(ws), server };
  }

  for (const version of LOCK_FIXTURE_VERSIONS) {
    test(`файловое хранилище ${version}, копия 2.21: опрос сервера — свои захваты вне проекта, чужой Справочник.Банки, одно предупреждение`, async () => {
      const harness = await fileHarness(version);
      const { target } = harness.ws;
      const completion = await completeRepositoryBind(
        { target, repoUser: 'Petrov', bindOutput: readBindOutput(version) }, harness.services, harness.deps({}));
      assert.strictEqual(completion.postSync, 'done');
      assert.strictEqual(completion.lockStatus.status, 'synced');
      assert.strictEqual(completion.source, 'server');
      const expected = sortRu([getRootLockName(target), FORM_ITEM, FORM_LIST]);
      assert.deepStrictEqual(completion.ownElsewhere, expected);
      assert.deepStrictEqual(harness.postSyncCalls, [target]);
      for (const fullName of expected) {
        assert.strictEqual(harness.ws.service.lockState.getLockInfo(target, fullName).state, 'own-elsewhere');
        assert.strictEqual(harness.ws.service.isLocked(target, fullName), false);
      }
      const bank = harness.ws.service.lockState.getLockInfo(target, 'Справочник.Банки');
      assert.strictEqual(bank.state, 'foreign');
      assert.strictEqual(bank.user, 'Admin');
      assert.strictEqual(harness.warnings.length, 1);
      assert.ok(harness.warnings[0].includes(`: ${expected.map((fullName) => formatOwnElsewhereName(fullName, target)).join(', ')}. `), harness.warnings[0]);
      assert.ok(harness.warnings[0].includes('конфигурация «ТорговыйУчет»'), harness.warnings[0]);
      assert.ok(!harness.warnings[0].includes(getRootLockName(target)), 'служебный ключ корня не показывается пользователю');
      assert.ok(harness.log.some((line) => line.includes('вне проекта') && line.includes(getRootLockName(target))), 'в журнале — fullName как есть');
      assert.ok(harness.warnings[0].includes('«Захватить»'));
      assert.ok(!harness.warnings[0].includes('и ещё'));
      assert.ok(harness.log.some((line) => line.startsWith('[repository][locks] ') && line.includes(FORM_ITEM)));
      assert.strictEqual(harness.refreshes, 1);

      const repeat = await completeRepositoryBind(
        { target, repoUser: 'Petrov', bindOutput: readBindOutput(version) }, harness.services, harness.deps({}));
      assert.strictEqual(repeat.lockStatus.status === 'synced' ? repeat.lockStatus.changed.length : -1, 0);
      assert.strictEqual(harness.refreshes, 1, 'опрос без изменений дерево не обновляет');
      assert.strictEqual(harness.warnings.length, 2, 'предупреждение повторяется при каждом подключении');
    });
  }

  test('пустой проект: пост-синхронизация импортирует конфигурацию — опрос для заново разрешённой цели ТорговыйУчет', async () => {
    const harness = await fileHarness('8.5.1', true);
    assert.strictEqual(harness.ws.target.displayName, 'Пустая');
    const completion = await completeRepositoryBind(
      { target: harness.ws.target, repoUser: 'Petrov', bindOutput: readBindOutput('8.5.1') },
      harness.services, harness.deps({ importOnPostSync: true }));
    const current = must(harness.ws.service.resolveTargetByConfigRoot(harness.ws.configRoot), 'цель после импорта');
    assert.strictEqual(current.displayName, 'ТорговыйУчет');
    assert.strictEqual(completion.lockStatus.status, 'synced');
    assert.strictEqual(completion.source, 'server');
    assert.deepStrictEqual(completion.ownElsewhere, sortRu([getRootLockName(current), FORM_ITEM, FORM_LIST]));
    assert.ok(harness.warnings[0].includes('«ТорговыйУчет»'));
  });

  for (const postSync of ['busy', 'apply-failed', 'import-failed', 'error'] as const) {
    test(`пустой проект, пост-синхронизация ${postSync}: нет ConfigDumpInfo.xml — свои захваты из вывода привязки`, async () => {
      const harness = await fileHarness('8.5.1', true);
      const { target } = harness.ws;
      const completion = await completeRepositoryBind(
        { target, repoUser: 'Petrov', bindOutput: readBindOutput('8.5.1') }, harness.services, harness.deps({ postSync }));
      assert.strictEqual(completion.postSync, postSync);
      assert.strictEqual(completion.lockStatus.status === 'failed' ? completion.lockStatus.code : '', 'no-dump-info');
      assert.strictEqual(completion.source, 'bind-output');
      assert.deepStrictEqual(completion.ownElsewhere, [FORM_LIST, FORM_ITEM]);
      for (const fullName of [FORM_ITEM, FORM_LIST]) {
        assert.deepStrictEqual(harness.ws.service.lockState.getLockInfo(target, fullName), { state: 'own-elsewhere', user: 'Petrov', lockedAt: undefined });
      }
      assert.ok(harness.log.some((line) => line.includes('не удалось сопоставить') && line.includes('ТорговыйУчет')));
      assert.strictEqual(harness.warnings.length, 1);
      assert.ok(harness.warnings[0].includes(FORM_ITEM) && harness.warnings[0].includes(FORM_LIST));
      assert.strictEqual(harness.refreshes, 1);
      assert.deepStrictEqual(harness.readScope().lockSync, { syncedAt: OBSERVED_AT, user: 'Petrov' });
    });
  }

  test('после сбоя пост-синхронизации корень не разрешается — используется исходная цель', async () => {
    const harness = await fileHarness('8.5.1', true);
    const { target } = harness.ws;
    const completion = await completeRepositoryBind(
      { target, repoUser: 'Petrov', bindOutput: readBindOutput('8.5.1') },
      harness.services, harness.deps({ postSync: 'import-failed', clearOnPostSync: true }));
    assert.strictEqual(harness.ws.service.resolveTargetByConfigRoot(harness.ws.configRoot), null);
    assert.strictEqual(completion.lockStatus.status === 'failed' ? completion.lockStatus.code : '', 'no-dump-info');
    assert.strictEqual(completion.source, 'bind-output');
    assert.deepStrictEqual(completion.ownElsewhere, [FORM_LIST, FORM_ITEM]);
    assert.ok(harness.warnings[0].includes('«Пустая»'));
  });

  test('пустой вывод привязки и сбой опроса — источника нет: без предупреждения и обновления', async () => {
    const harness = await fileHarness('8.5.1', true);
    const completion = await completeRepositoryBind(
      { target: harness.ws.target, repoUser: 'Petrov', bindOutput: '' }, harness.services, harness.deps({ postSync: 'error' }));
    assert.strictEqual(completion.lockStatus.status, 'failed');
    assert.strictEqual(completion.source, 'none');
    assert.deepStrictEqual(completion.ownElsewhere, []);
    assert.deepStrictEqual(harness.warnings, []);
    assert.strictEqual(harness.refreshes, 0);
    assert.ok(!harness.log.some((line) => line.includes('не удалось сопоставить')));
  });

  test('недоверенная область: к хранилищу ни одного обращения, свои захваты из вывода привязки', async () => {
    const { harness, server } = await networkHarness();
    const { target } = harness.ws;
    const completion = await completeRepositoryBind(
      { target, repoUser: ' Petrov ', bindOutput: readBindOutput('8.5.1') }, harness.services, harness.deps({ trusted: false }));
    assert.strictEqual(server.requests.length, 0);
    assert.deepStrictEqual(completion.lockStatus, { status: 'skipped-untrusted' });
    assert.strictEqual(completion.source, 'bind-output');
    const expected = sortRu([getRootLockName(target), FORM_ITEM, FORM_LIST]);
    assert.deepStrictEqual(completion.ownElsewhere, expected);
    for (const fullName of expected) {
      assert.deepStrictEqual(harness.ws.service.lockState.getLockInfo(target, fullName), { state: 'own-elsewhere', user: 'Petrov', lockedAt: undefined });
    }
    assert.strictEqual(harness.ws.service.lockState.getServerVersion(target), undefined);
    assert.ok(harness.log.some((line) => line.includes('недоверенн')));
    assert.ok(harness.warnings[0].includes('конфигурация «ТорговыйУчет»') && !harness.warnings[0].includes(getRootLockName(target)), harness.warnings[0]);
    assert.strictEqual(harness.refreshes, 1);
  });

  test('stale: захват во время опроса — запасная запись слита, локальный захват цел', async () => {
    let locked = false;
    const { harness, server } = await networkHarness((ws) => {
      if (!locked) {
        locked = true;
        ws.service.lockState.applyLock(ws.target, { anchor: 'Справочник.Номенклатура', members: ['Справочник.Номенклатура'] });
      }
    });
    const { target } = harness.ws;
    const completion = await completeRepositoryBind(
      { target, repoUser: 'Petrov', bindOutput: readBindOutput('8.5.1') }, harness.services, harness.deps({}));
    assert.ok(server.requests.length > 0);
    assert.deepStrictEqual(completion.lockStatus, { status: 'stale' });
    assert.strictEqual(completion.source, 'bind-output');
    assert.deepStrictEqual(completion.ownElsewhere, sortRu([getRootLockName(target), FORM_ITEM, FORM_LIST]));
    assert.strictEqual(harness.ws.service.isLocked(target, 'Справочник.Номенклатура'), true);
    assert.strictEqual(harness.refreshes, 1);
  });

  for (const trusted of [true, false]) {
    test(`не подключена (${trusted ? 'доверенная' : 'недоверенная'} область): state.json без своих захватов, без предупреждения и обновления`, async () => {
      const harness = await fileHarness('8.5.1');
      harness.ws.service.setConnected(harness.ws.target, false);
      const completion = await completeRepositoryBind(
        { target: harness.ws.target, repoUser: 'Petrov', bindOutput: readBindOutput('8.5.1') }, harness.services, harness.deps({ trusted }));
      assert.strictEqual(completion.lockStatus.status, trusted ? 'not-connected' : 'skipped-untrusted');
      assert.strictEqual(completion.source, 'none');
      assert.strictEqual(harness.readScope().serverOwnLocks, undefined);
      assert.deepStrictEqual(harness.warnings, []);
      assert.strictEqual(harness.refreshes, 0);
    });
  }

  test(`больше ${String(MAX_LISTED_OWN_ELSEWHERE)} своих захватов: в предупреждении первые ${String(MAX_LISTED_OWN_ELSEWHERE)} и «и ещё N», полный список — в журнале`, async () => {
    const ws = await createLockWorkspace({ repoPath: scenarioFixturePath(PARTIAL_ROOT_ROOT, '8.5.1'), repoUser: 'Admin', repoPassword: '' });
    disposables.push(ws);
    const harness = harnessFor(ws);
    const completion = await completeRepositoryBind({ target: ws.target, repoUser: 'Admin', bindOutput: '' }, harness.services, harness.deps({}));
    const all = completion.ownElsewhere;
    assert.ok(all.length > MAX_LISTED_OWN_ELSEWHERE);
    assert.strictEqual(harness.warnings.length, 1);
    const warning = harness.warnings[0];
    const listed = all.slice(0, MAX_LISTED_OWN_ELSEWHERE).map((fullName) => formatOwnElsewhereName(fullName, ws.target));
    assert.ok(!warning.includes(getRootLockName(ws.target)));
    assert.ok(warning.includes(`${listed.join(', ')} и ещё ${String(all.length - MAX_LISTED_OWN_ELSEWHERE)} (см. журнал)`), warning);
    assert.ok(harness.log.some((line) => line.includes('вне проекта') && line.endsWith(all.join(', '))));
  });
});

suite('validateBindingForm — перенос без изменения поведения (issue #106)', () => {
  test('пустой путь — ошибка про путь', () => {
    assert.deepStrictEqual(validateBindingForm({ repoPath: '  ', repoUser: 'Petrov', repoPassword: '' }),
      { ok: false, errorMessage: 'Нужно указать путь к хранилищу или адрес сервера.' });
  });

  test('пустой пользователь — ошибка про пользователя', () => {
    assert.deepStrictEqual(validateBindingForm({ repoPath: '/repo', repoUser: ' ', repoPassword: '' }),
      { ok: false, errorMessage: 'Нужно указать пользователя хранилища.' });
  });

  test('успех: путь и пользователь без пробелов по краям, пароль как есть', () => {
    assert.deepStrictEqual(validateBindingForm({ repoPath: ' /repo ', repoUser: ' Petrov ', repoPassword: ' 123 ' }),
      { ok: true, binding: { repoPath: '/repo', repoUser: 'Petrov', repoPassword: ' 123 ' } });
  });
});

suite('formatOwnElsewhereName — имя единицы в уведомлении (issue #106)', () => {
  test('корень конфигурации и расширения — вид и имя цели; прочие — fullName как есть', () => {
    const service = new RepositoryService(os.tmpdir(), new ProjectSecretStorage(createMapSecretStore(), os.tmpdir()));
    const cf = must(service.resolveTargetByConfigRoot(EXAMPLE_CF_221), 'цель example/2.21/src/cf');
    const cfe = must(service.resolveTargetByConfigRoot(EXAMPLE_CFE_EVOLC), 'цель example/2.21/src/cfe/EVOLC');
    assert.strictEqual(cfe.configKind, 'cfe');
    assert.strictEqual(formatOwnElsewhereName(getRootLockName(cf), cf), 'конфигурация «ТорговыйУчет»');
    assert.strictEqual(formatOwnElsewhereName(getRootLockName(cfe), cfe), `расширение «${cfe.displayName}»`);
    assert.strictEqual(formatOwnElsewhereName(FORM_ITEM, cf), FORM_ITEM);
  });
});
