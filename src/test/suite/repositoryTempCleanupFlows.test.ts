import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConfigurationDumpRequest } from '../../infra/agent';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { buildRepositoryScopeKey } from '../../infra/repository/RepositoryLockState';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { getRepositoryMergeRoot, getRepositoryObjectsDir } from '../../infra/repository/RepositoryTempCleanup';
import type { RepositoryCliRequest, RepositoryCliResult } from '../../ui/commands/repository/RepositoryCommandRunner';
import type {
  RepositoryDumpToTempResult,
  RepositoryFileSyncDeps,
  RepositoryFileSyncServices,
  RepositoryFlowOutcome,
} from '../../ui/commands/repository/RepositoryFileSyncShared';
import { runRepositoryLockFlow, runRepositoryUpdateFlow } from '../../ui/commands/repository/RepositoryLockSync';
import { runRepositoryCommitFlow, runRepositoryUnlockFlow } from '../../ui/commands/repository/RepositoryUnlockSync';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { bumpConfigDumpInfoVersion } from './support/configDumpInfoFixture';
import { createPartialDumpFixture, KNOWN_FIXTURE_UNITS } from './support/partialDumpFixture';

/**
 * Issue #64 — временные файлы операций хранилища не накапливаются в `.v8vscedit`:
 * файл `-ObjectsFile` живёт только на время запуска Конфигуратора, хвосты прошлых
 * операций подметаются первым шагом аренды, каталоги выгрузки освобождаются и при
 * исключении, снимки удаляются помещением без сохранения захвата.
 *
 * Рабочая область — реальная копия `example/2.21/src/cf`. Подменяется только
 * Конфигуратор (`runRepositoryCli`, `dumpToTemp`): процесса 1С в тестовом окружении нет.
 * Выгрузки — реальные временные каталоги из файлов той же фикстуры.
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const NOW = new Date('2024-01-01T00:00:00.000Z');

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

function notCalled(name: string): (...args: unknown[]) => never {
  return () => { throw new Error(`"${name}" не должен вызываться в этом сценарии`); };
}

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  guard: ConfigurationOperationGuard;
  services: RepositoryFileSyncServices;
  outputLines: string[];
}

const createdRoots: string[] = [];

function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-temp-flows-'));
  createdRoots.push(workspaceRoot);
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.cpSync(EXAMPLE_CF, configRoot, { recursive: true });
  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };
  const guard = new ConfigurationOperationGuard();
  const outputLines: string[] = [];
  const services: RepositoryFileSyncServices = {
    configurationOperationGuard: guard,
    workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
    outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
    repositoryService,
    projectSecretStorage: {} as unknown as RepositoryFileSyncServices['projectSecretStorage'],
    supportService: undefined,
    suppressConfigurationReloadForFiles: () => undefined,
    markChangedConfigurationByFiles: () => undefined,
    treeProvider: { refresh: () => undefined, refreshCacheForFiles: () => true } as unknown as MetadataTreeProvider,
    refreshActionsView: () => undefined,
    reloadEntries: () => Promise.resolve(),
  };
  return { workspaceRoot, configRoot, target, repositoryService, guard, services, outputLines };
}

function baseDeps(overrides: Partial<RepositoryFileSyncDeps> = {}): RepositoryFileSyncDeps {
  return {
    runRepositoryCli: notCalled('runRepositoryCli'),
    dumpToTemp: notCalled('dumpToTemp'),
    chooseConflictResolution: notCalled('chooseConflictResolution'),
    confirmRollback: notCalled('confirmRollback'),
    openDiffs: notCalled('openDiffs'),
    notifyBusy: () => undefined,
    notifyInfo: () => undefined,
    notifyWarning: () => undefined,
    notifyError: () => undefined,
    isFileSyncEnabled: () => false,
    getDirtyFilePaths: () => [],
    now: () => NOW,
    ...overrides,
  };
}

function catalogNode(harness: Harness, name: string): RepositoryNodeRef {
  return { nodeKind: 'Catalog', label: name, xmlPath: path.join(harness.configRoot, 'Catalogs', `${name}.xml`) };
}

function rootNode(harness: Harness): RepositoryNodeRef {
  return { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(harness.configRoot, 'Configuration.xml') };
}

function objectsXmlFiles(harness: Harness): string[] {
  const dir = getRepositoryObjectsDir(harness.workspaceRoot);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.xml')) : [];
}

function snapshotDir(harness: Harness, fullName: string): string {
  return path.join(
    harness.workspaceRoot, '.v8vscedit', 'repository', 'snapshots', buildRepositoryScopeKey(harness.target),
    crypto.createHash('sha1').update(fullName).digest('hex')
  );
}

function snapshotScopeDir(harness: Harness): string {
  return path.dirname(snapshotDir(harness, getRootLockName(harness.target)));
}

type CliOutcome = 'done' | 'failed' | 'interrupted' | 'throw';

/**
 * Заглушка Конфигуратора: проверяет, что файл `-ObjectsFile` существует ровно во время
 * запуска, и отдаёт заданный исход.
 */
function cliStub(outcome: CliOutcome, seen: string[]): (request: RepositoryCliRequest) => Promise<RepositoryCliResult> {
  return (request) => {
    const index = request.extraArgs.indexOf('-ObjectsFile');
    assert.ok(index >= 0, 'запрос Конфигуратора обязан содержать -ObjectsFile');
    const objectsFile = request.extraArgs[index + 1];
    assert.ok(fs.existsSync(objectsFile), 'файл -ObjectsFile обязан существовать во время запуска Конфигуратора');
    seen.push(objectsFile);
    switch (outcome) {
      case 'done':
        return Promise.resolve({ status: 'done' });
      case 'failed':
        return Promise.resolve({ status: 'failed', message: 'сбой' });
      case 'interrupted':
        return Promise.resolve({ status: 'interrupted', message: 'прервано' });
      case 'throw':
        return Promise.reject(new Error('процесс Конфигуратора не запустился'));
    }
  };
}

interface FlowCase {
  name: string;
  prelock: boolean;
  run: (harness: Harness, deps: RepositoryFileSyncDeps) => Promise<RepositoryFlowOutcome>;
}

const FLOWS: readonly FlowCase[] = [
  { name: 'lock', prelock: false, run: (h, deps) => runRepositoryLockFlow(catalogNode(h, 'Валюты'), false, h.services, deps) },
  {
    name: 'update',
    prelock: false,
    run: (h, deps) => runRepositoryUpdateFlow(catalogNode(h, 'Валюты'), { recursive: false, force: false }, h.services, deps),
  },
  {
    name: 'unlock',
    prelock: true,
    run: (h, deps) => runRepositoryUnlockFlow(catalogNode(h, 'Валюты'), { recursive: false, force: false }, h.services, deps),
  },
  {
    name: 'commit-release',
    prelock: true,
    run: (h, deps) => runRepositoryCommitFlow(
      catalogNode(h, 'Валюты'), { recursive: false, comment: 'c', keepLocked: false, force: false }, h.services, deps
    ),
  },
  {
    name: 'commit-keep',
    prelock: true,
    run: (h, deps) => runRepositoryCommitFlow(
      catalogNode(h, 'Валюты'), { recursive: false, comment: 'c', keepLocked: true, force: false }, h.services, deps
    ),
  },
];

const EXPECTED_OUTCOME: Readonly<Record<CliOutcome, RepositoryFlowOutcome>> = {
  done: 'done',
  failed: 'failed',
  interrupted: 'interrupted',
  throw: 'failed',
};

function removeCreatedRoots(): void {
  createdRoots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
}

suite('Временные файлы хранилища — objects/*.xml живёт только на время Конфигуратора (issue #64)', () => {
  teardown(removeCreatedRoots);

  for (const flow of FLOWS) {
    for (const cli of ['done', 'failed', 'interrupted', 'throw'] as const) {
      test(`${flow.name} × CLI ${cli}: файл был во время запуска, после — objects/ без *.xml`, async () => {
        const harness = createHarness();
        if (flow.prelock) {
          harness.repositoryService.lockState.applyLock(harness.target, { anchor: 'Справочник.Валюты', members: ['Справочник.Валюты'] });
        }
        const seen: string[] = [];

        const outcome = await flow.run(harness, baseDeps({ runRepositoryCli: cliStub(cli, seen) }));

        assert.strictEqual(outcome, EXPECTED_OUTCOME[cli]);
        assert.strictEqual(seen.length, 1);
        assert.ok(!fs.existsSync(seen[0]), 'файл -ObjectsFile обязан быть удалён после запуска');
        assert.deepStrictEqual(objectsXmlFiles(harness), []);
      });
    }
  }
});

suite('Временные файлы хранилища — подметание в начале аренды (issue #64)', () => {
  teardown(removeCreatedRoots);

  function seedTails(harness: Harness): { staleObjects: string; oldBackup: string; freshBackup: string } {
    const staleObjects = path.join(getRepositoryObjectsDir(harness.workspaceRoot), `${'a'.repeat(40)}-1.xml`);
    fs.mkdirSync(path.dirname(staleObjects), { recursive: true });
    fs.writeFileSync(staleObjects, '<Objects/>', 'utf-8');
    const scopeDir = path.join(getRepositoryMergeRoot(harness.workspaceRoot), buildRepositoryScopeKey(harness.target));
    const oldBackup = path.join(scopeDir, '2023-12-24T00-00-00-000Z-lock');
    const freshBackup = path.join(scopeDir, '2023-12-31T23-00-00-000Z-lock');
    for (const dir of [oldBackup, freshBackup]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Configuration.xml'), 'копия', 'utf-8');
    }
    return { staleObjects, oldBackup, freshBackup };
  }

  test('хвосты прошлых операций удаляются, свежий бэкап остаётся, в журнале — число удалённых', async () => {
    const harness = createHarness();
    const { staleObjects, oldBackup, freshBackup } = seedTails(harness);

    const outcome = await runRepositoryLockFlow(
      catalogNode(harness, 'Валюты'), false, harness.services, baseDeps({ runRepositoryCli: cliStub('done', []) })
    );

    assert.strictEqual(outcome, 'done');
    assert.ok(!fs.existsSync(staleObjects));
    assert.ok(!fs.existsSync(oldBackup));
    assert.ok(fs.existsSync(freshBackup));
    assert.ok(harness.outputLines.includes('[repository][file-sync] очистка временных файлов: удалено 2'), harness.outputLines.join('\n'));
  });

  test('guard занят — busy, хвосты не трогаются', async () => {
    const harness = createHarness();
    const { staleObjects, oldBackup } = seedTails(harness);
    const lease = harness.guard.tryAcquire('Импорт конфигураций');

    const outcome = await runRepositoryLockFlow(catalogNode(harness, 'Валюты'), false, harness.services, baseDeps());

    lease?.release();
    assert.strictEqual(outcome, 'busy');
    assert.ok(fs.existsSync(staleObjects));
    assert.ok(fs.existsSync(oldBackup));
  });

  test('сбой очистки merge/ (обычный файл) — операция выполняется, предупреждение в журнале, objects/ очищен', async () => {
    const harness = createHarness();
    const staleObjects = path.join(getRepositoryObjectsDir(harness.workspaceRoot), `${'b'.repeat(40)}-1.xml`);
    fs.mkdirSync(path.dirname(staleObjects), { recursive: true });
    fs.writeFileSync(staleObjects, '<Objects/>', 'utf-8');
    fs.writeFileSync(getRepositoryMergeRoot(harness.workspaceRoot), 'не каталог', 'utf-8');

    const outcome = await runRepositoryLockFlow(
      catalogNode(harness, 'Валюты'), false, harness.services, baseDeps({ runRepositoryCli: cliStub('done', []) })
    );

    assert.strictEqual(outcome, 'done');
    assert.ok(
      harness.outputLines.some((line) => line.startsWith('[repository][file-sync][warn] очистка временных файлов не удалась:')),
      harness.outputLines.join('\n')
    );
    assert.ok(harness.outputLines.includes('[repository][file-sync] очистка временных файлов: удалено 1'));
    assert.deepStrictEqual(objectsXmlFiles(harness), []);
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, 'Справочник.Валюты'), true);
  });

  test('без хвостов строка об очистке не пишется', async () => {
    const harness = createHarness();

    const outcome = await runRepositoryLockFlow(
      catalogNode(harness, 'Валюты'), false, harness.services, baseDeps({ runRepositoryCli: cliStub('done', []) })
    );

    assert.strictEqual(outcome, 'done');
    assert.ok(!harness.outputLines.some((line) => line.includes('очистка временных файлов')), harness.outputLines.join('\n'));
  });
});

suite('Временные файлы хранилища — каталоги выгрузки освобождаются (issue #64)', () => {
  teardown(removeCreatedRoots);

  test('рекурсивный захват корня: сбой частичной выгрузки после update-info — failed, каталог update-info удалён', async () => {
    const harness = createHarness();
    const projectInfo = fs.readFileSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml'), 'utf-8');
    const infoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-temp-flows-info-'));
    createdRoots.push(infoDir);
    fs.writeFileSync(
      path.join(infoDir, 'ConfigDumpInfo.xml'),
      bumpConfigDumpInfoVersion(projectInfo, 'Catalog.Валюты.ObjectModule', '0000000000000000000000000000000000000a'),
      'utf-8'
    );
    const modes: ConfigurationDumpRequest['mode'][] = [];
    const deps = baseDeps({
      runRepositoryCli: cliStub('done', []),
      isFileSyncEnabled: () => true,
      dumpToTemp: (_target, request): Promise<RepositoryDumpToTempResult> => {
        modes.push(request.mode);
        if (request.mode === 'update-info') {
          return Promise.resolve({ ok: true, dir: infoDir, dispose: () => fs.rmSync(infoDir, { recursive: true, force: true }) });
        }
        return Promise.reject(new Error('Конфигуратор упал на частичной выгрузке'));
      },
    });

    const outcome = await runRepositoryLockFlow(rootNode(harness), true, harness.services, deps);

    assert.strictEqual(outcome, 'failed');
    assert.deepStrictEqual(modes, ['update-info', 'partial']);
    assert.ok(!fs.existsSync(infoDir), 'каталог update-info обязан быть удалён при исключении');
    assert.deepStrictEqual(objectsXmlFiles(harness), []);
  });

  test('успешный нерекурсивный захват с синхронизацией: каталог выгрузки удалён, objects/ пуст', async () => {
    const harness = createHarness();
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const dirs: string[] = [];
    const deps = baseDeps({
      runRepositoryCli: cliStub('done', []),
      isFileSyncEnabled: () => true,
      dumpToTemp: async (target, request, services) => {
        const result = await fixture.dumpToTemp(target, request, services);
        if (result.ok) {
          dirs.push(result.dir);
        }
        return result;
      },
    });

    const outcome = await runRepositoryLockFlow(catalogNode(harness, 'Валюты'), false, harness.services, deps);
    fixture.disposeAll();

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(dirs.length, 1);
    assert.ok(!fs.existsSync(dirs[0]));
    assert.deepStrictEqual(objectsXmlFiles(harness), []);
  });

  test('выгрузка не удалась ({ok:false}) — захват выполнен, objects/ пуст', async () => {
    const harness = createHarness();
    const deps = baseDeps({
      runRepositoryCli: cliStub('done', []),
      isFileSyncEnabled: () => true,
      dumpToTemp: () => Promise.resolve({ ok: false, reason: 'rc=1' }),
    });

    const outcome = await runRepositoryLockFlow(catalogNode(harness, 'Валюты'), false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.deepStrictEqual(objectsXmlFiles(harness), []);
  });
});

suite('Временные файлы хранилища — снимки при помещении (issue #64)', () => {
  teardown(removeCreatedRoots);

  function commitForm(recursive: boolean, keepLocked: boolean): { recursive: boolean; comment: string; keepLocked: boolean; force: boolean } {
    return { recursive, comment: 'Помещение', keepLocked, force: false };
  }

  async function lockWithSnapshot(harness: Harness, name: string, recursive: boolean): Promise<void> {
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const outcome = await runRepositoryLockFlow(
      catalogNode(harness, name),
      recursive,
      harness.services,
      baseDeps({ runRepositoryCli: cliStub('done', []), isFileSyncEnabled: () => true, dumpToTemp: (target, request, services) => fixture.dumpToTemp(target, request, services) })
    );
    fixture.disposeAll();
    assert.strictEqual(outcome, 'done', 'предпосылка: захват со снимком');
  }

  test('объект без сохранения захвата — снимок и его каталог удалены', async () => {
    const harness = createHarness();
    await lockWithSnapshot(harness, 'Валюты', false);
    assert.ok(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, 'Справочник.Валюты'), 'предпосылка: снимок есть');

    const outcome = await runRepositoryCommitFlow(
      catalogNode(harness, 'Валюты'), commitForm(false, false), harness.services, baseDeps({ runRepositoryCli: cliStub('done', []) })
    );

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, 'Справочник.Валюты'), undefined);
    assert.ok(!fs.existsSync(snapshotDir(harness, 'Справочник.Валюты')));
  });

  test('рекурсивный корень без сохранения захвата — каталог снимков цели удалён целиком', async () => {
    const harness = createHarness();
    const rootName = getRootLockName(harness.target);
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: rootName, members: [rootName], recursiveRoot: true });
    harness.repositoryService.snapshots.captureRootManifest(harness.target);
    assert.ok(fs.existsSync(path.join(snapshotScopeDir(harness), 'root-manifest.json')), 'предпосылка: манифест корня');

    const outcome = await runRepositoryCommitFlow(
      rootNode(harness), commitForm(true, false), harness.services, baseDeps({ runRepositoryCli: cliStub('done', []) })
    );

    assert.strictEqual(outcome, 'done');
    assert.ok(!fs.existsSync(snapshotScopeDir(harness)));
  });

  test('рекурсивный объект с формами и макетом — снимки всех участников группы удалены', async () => {
    const harness = createHarness();
    await lockWithSnapshot(harness, 'Контрагенты', true);
    const members = [
      KNOWN_FIXTURE_UNITS.kontragenty,
      KNOWN_FIXTURE_UNITS.kontragentyFormaElementa,
      KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska,
      KNOWN_FIXTURE_UNITS.kontragentyMaket,
    ];
    members.forEach((fullName) => assert.ok(
      harness.repositoryService.snapshots.readSnapshotInfo(harness.target, fullName), `предпосылка: снимок ${fullName}`
    ));

    const outcome = await runRepositoryCommitFlow(
      catalogNode(harness, 'Контрагенты'), commitForm(true, false), harness.services, baseDeps({ runRepositoryCli: cliStub('done', []) })
    );

    assert.strictEqual(outcome, 'done');
    members.forEach((fullName) => assert.ok(!fs.existsSync(snapshotDir(harness, fullName)), `снимок ${fullName} обязан быть удалён`));
  });

  test('Конфигуратор вернул failed — снимок остаётся', async () => {
    const harness = createHarness();
    await lockWithSnapshot(harness, 'Валюты', false);

    const outcome = await runRepositoryCommitFlow(
      catalogNode(harness, 'Валюты'), commitForm(false, false), harness.services, baseDeps({ runRepositoryCli: cliStub('failed', []) })
    );

    assert.strictEqual(outcome, 'failed');
    assert.ok(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, 'Справочник.Валюты'));
  });

  test('keepLocked=true — снимок есть', async () => {
    const harness = createHarness();
    await lockWithSnapshot(harness, 'Валюты', false);

    const outcome = await runRepositoryCommitFlow(
      catalogNode(harness, 'Валюты'),
      commitForm(false, true),
      harness.services,
      baseDeps({ runRepositoryCli: cliStub('done', []), isFileSyncEnabled: () => true })
    );

    assert.strictEqual(outcome, 'done');
    assert.ok(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, 'Справочник.Валюты'));
  });
});
