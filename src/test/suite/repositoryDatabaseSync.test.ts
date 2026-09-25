/**
 * Issue #10 — `src/ui/commands/repository/RepositoryDatabaseSync.ts` (новый файл).
 *
 * `runPostRepositorySync`/`ensureTargetUpdatedBeforeCommit` дёргают реальные
 * runner'ы Конфигуратора (`ExtensionCommandRunner.run*`) — внешний процесс 1С,
 * недоступный в тестовом окружении CI. Поэтому они подменяются через
 * инжектируемые `deps` (не мок бизнес-логики модуля — сам модуль тестируется
 * целиком, подменяется только внешняя точка спавна). Пути конфигураций и
 * расширения — реальные фикстуры `example/2.21/src/cf` и
 * `example/2.21/src/cfe/EVOLC`, чтобы имена/пути были неотличимы от боевых.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import {
  runPostRepositorySync,
  ensureTargetUpdatedBeforeCommit,
  refreshRepositoryUi,
  type RepositoryDatabaseSyncDeps,
  type RepositoryDatabaseSyncServices,
} from '../../ui/commands/repository/RepositoryDatabaseSync';
import { CONFIGURATION_OPERATION_BUSY_MESSAGE } from '../../ui/commands/ext/configurationOperationBusy';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { ChangedConfiguration } from '../../infra/fs/ConfigurationChangeDetector';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_CFE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../example/2.21');

function notCalled(name: string): () => never {
  return () => {
    throw new Error(`"${name}" не должен вызываться в этом сценарии`);
  };
}

interface Harness {
  services: RepositoryDatabaseSyncServices;
  guard: ConfigurationOperationGuard;
  events: boolean[];
  outputLines: string[];
  treeRefreshCalls: number;
  actionsViewCalls: number;
  markCleanCalls: string[][];
  reloadCalls: number;
}

function createHarness(overrides: Partial<RepositoryDatabaseSyncServices> = {}): Harness {
  const guard = new ConfigurationOperationGuard();
  const events: boolean[] = [];
  guard.onDidChangeBusy((busy) => events.push(busy));
  const outputLines: string[] = [];
  let treeRefreshCalls = 0;
  let actionsViewCalls = 0;
  const markCleanCalls: string[][] = [];
  let reloadCalls = 0;

  const services: RepositoryDatabaseSyncServices = {
    configurationOperationGuard: guard,
    workspaceFolder: { uri: vscode.Uri.file(WORKSPACE_ROOT), name: 'fixture', index: 0 },
    outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
    getChangedConfigurations: notCalled('getChangedConfigurations'),
    markConfigurationsClean: (roots: string[]) => markCleanCalls.push(roots),
    reloadEntries: () => {
      reloadCalls += 1;
      return undefined;
    },
    treeProvider: { refresh: () => { treeRefreshCalls += 1; } } as unknown as MetadataTreeProvider,
    refreshActionsView: () => { actionsViewCalls += 1; },
    ...overrides,
  };

  return {
    services,
    guard,
    events,
    outputLines,
    get treeRefreshCalls() { return treeRefreshCalls; },
    get actionsViewCalls() { return actionsViewCalls; },
    markCleanCalls,
    get reloadCalls() { return reloadCalls; },
  };
}

function baseDeps(overrides: Partial<RepositoryDatabaseSyncDeps> = {}): RepositoryDatabaseSyncDeps {
  return {
    applyDatabaseConfiguration: notCalled('applyDatabaseConfiguration'),
    decompileMainConfiguration: notCalled('decompileMainConfiguration'),
    decompileExtension: notCalled('decompileExtension'),
    updateMainConfiguration: notCalled('updateMainConfiguration'),
    updateExtension: notCalled('updateExtension'),
    confirmUpdateBeforeCommit: notCalled('confirmUpdateBeforeCommit'),
    notifyBusy: notCalled('notifyBusy'),
    ...overrides,
  };
}

const TARGETS: { label: string; target: RepositoryTarget }[] = [
  { label: 'cf', target: { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' } },
  {
    label: 'cfe с extensionName',
    // extensionName намеренно отличается от displayName: apply получает имя
    // владельца биндинга (displayName), а decompile/update — имя каталога
    // расширения (extensionName ?? displayName) — это разные call-site'ы
    // production-кода, и различие должно реально проверяться, а не совпадать
    // случайно из-за одинаковых строк во фикстуре.
    target: { configRoot: EXAMPLE_CFE_EVOLC, configKind: 'cfe', extensionName: 'EVOLC', displayName: 'Расширение EVOLC' },
  },
  {
    label: 'cfe без extensionName',
    target: { configRoot: EXAMPLE_CFE_EVOLC, configKind: 'cfe', displayName: 'EVOLC' },
  },
];

suite('RepositoryDatabaseSync — runPostRepositorySync', () => {
  TARGETS.forEach(({ label, target }) => {
    test(`успех (${label}): apply → decompile → markClean → reload(await) → refresh/actions, guard занят на всё время`, async () => {
      const harness = createHarness();
      const calls: string[] = [];
      // apply получает имя владельца биндинга хранилища (displayName), тогда
      // как decompile — имя каталога расширения (extensionName ?? displayName);
      // это два разных аргумента реального production-кода, поэтому ожидания
      // намеренно раздельные (см. RepositoryDatabaseSync.ts:runSyncChain).
      const expectedApplyName = target.displayName;
      const expectedDecompileName = target.extensionName ?? target.displayName;

      const deps = baseDeps({
        applyDatabaseConfiguration: (applyTarget, wsFolder, outputChannel, showSuccessMessage) => {
          calls.push('apply');
          assert.strictEqual(harness.guard.isBusy, true);
          assert.deepStrictEqual(applyTarget, {
            kind: target.configKind,
            name: expectedApplyName,
            rootPath: target.configRoot,
            extensionName: target.extensionName,
          });
          assert.strictEqual(wsFolder, harness.services.workspaceFolder);
          assert.strictEqual(outputChannel, harness.services.outputChannel);
          assert.strictEqual(showSuccessMessage, false);
          return Promise.resolve(true);
        },
        decompileMainConfiguration: target.configKind === 'cf'
          ? (name, root, wsFolder, outputChannel) => {
              calls.push('decompile');
              assert.strictEqual(harness.guard.isBusy, true);
              assert.strictEqual(name, expectedDecompileName);
              assert.strictEqual(root, target.configRoot);
              assert.strictEqual(wsFolder, harness.services.workspaceFolder);
              assert.strictEqual(outputChannel, harness.services.outputChannel);
              return Promise.resolve(true);
            }
          : notCalled('decompileMainConfiguration'),
        decompileExtension: target.configKind === 'cfe'
          ? (name, root, wsFolder, outputChannel) => {
              calls.push('decompile');
              assert.strictEqual(harness.guard.isBusy, true);
              assert.strictEqual(name, expectedDecompileName);
              assert.strictEqual(root, target.configRoot);
              assert.strictEqual(wsFolder, harness.services.workspaceFolder);
              assert.strictEqual(outputChannel, harness.services.outputChannel);
              return Promise.resolve(true);
            }
          : notCalled('decompileExtension'),
      });

      const harnessServices: RepositoryDatabaseSyncServices = {
        ...harness.services,
        markConfigurationsClean: (roots: string[]) => {
          calls.push('markClean');
          harness.markCleanCalls.push(roots);
          assert.deepStrictEqual(roots, [target.configRoot]);
        },
        reloadEntries: async () => {
          calls.push('reload-start');
          await new Promise((resolve) => setTimeout(resolve, 5));
          calls.push('reload-end');
        },
        treeProvider: { refresh: () => calls.push('tree-refresh') } as unknown as MetadataTreeProvider,
        refreshActionsView: () => calls.push('actions-refresh'),
      };

      const outcome = await runPostRepositorySync(target, harnessServices, deps);

      assert.strictEqual(outcome, 'done');
      assert.deepStrictEqual(calls, ['apply', 'decompile', 'markClean', 'reload-start', 'reload-end', 'tree-refresh', 'actions-refresh']);
      assert.strictEqual(harness.guard.isBusy, false);
      assert.deepStrictEqual(harness.events, [true, false]);
    });
  });

  test('apply вернул false → "apply-failed", decompile/markClean/reload не вызываются', async () => {
    const harness = createHarness();
    const target = TARGETS[0].target;
    const deps = baseDeps({
      applyDatabaseConfiguration: () => Promise.resolve(false),
    });

    const outcome = await runPostRepositorySync(target, harness.services, deps);

    assert.strictEqual(outcome, 'apply-failed');
    assert.strictEqual(harness.markCleanCalls.length, 0);
    assert.strictEqual(harness.reloadCalls, 0);
    assert.strictEqual(harness.guard.isBusy, false);
    assert.deepStrictEqual(harness.events, [true, false]);
  });

  test('decompile вернул false → "import-failed", markClean/reload не вызываются', async () => {
    const harness = createHarness();
    const target = TARGETS[0].target;
    const deps = baseDeps({
      applyDatabaseConfiguration: () => Promise.resolve(true),
      decompileMainConfiguration: () => Promise.resolve(false),
    });

    const outcome = await runPostRepositorySync(target, harness.services, deps);

    assert.strictEqual(outcome, 'import-failed');
    assert.strictEqual(harness.markCleanCalls.length, 0);
    assert.strictEqual(harness.reloadCalls, 0);
    assert.strictEqual(harness.guard.isBusy, false);
  });

  test('apply бросил Error("x") → "error", лог "[repository][post-sync][error] x"', async () => {
    const harness = createHarness();
    const target = TARGETS[0].target;
    const deps = baseDeps({
      applyDatabaseConfiguration: () => Promise.reject(new Error('x')),
    });

    const outcome = await runPostRepositorySync(target, harness.services, deps);

    assert.strictEqual(outcome, 'error');
    assert.deepStrictEqual(harness.outputLines, ['[repository][post-sync][error] x']);
    assert.strictEqual(harness.guard.isBusy, false);
  });

  test('apply бросил не-Error значение → "error", лог со String(error)', async () => {
    const harness = createHarness();
    const target = TARGETS[0].target;
    const deps = baseDeps({
      applyDatabaseConfiguration: async () => {
        await Promise.resolve();
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- намеренно: проверяем ветку String(error) для не-Error значений
        throw 'boom';
      },
    });

    const outcome = await runPostRepositorySync(target, harness.services, deps);

    assert.strictEqual(outcome, 'error');
    assert.deepStrictEqual(harness.outputLines, ['[repository][post-sync][error] boom']);
  });

  test('reloadEntries — reject → "error", guard освобождается', async () => {
    const harness = createHarness();
    const target = TARGETS[0].target;
    const deps = baseDeps({
      applyDatabaseConfiguration: () => Promise.resolve(true),
      decompileMainConfiguration: () => Promise.resolve(true),
    });
    const harnessServices: RepositoryDatabaseSyncServices = {
      ...harness.services,
      reloadEntries: () => Promise.reject(new Error('reload-fail')),
    };

    const outcome = await runPostRepositorySync(target, harnessServices, deps);

    assert.strictEqual(outcome, 'error');
    assert.deepStrictEqual(harness.outputLines, ['[repository][post-sync][error] reload-fail']);
    assert.strictEqual(harness.guard.isBusy, false);
  });

  test('guard занят другой операцией — "busy", ни один runner не вызывается, лог с именем держателя, аренда держателя цела', async () => {
    const harness = createHarness();
    const target = TARGETS[0].target;
    const holderLease = harness.guard.tryAcquire('Импорт конфигураций');
    assert.ok(holderLease);
    harness.events.length = 0;

    let notifyBusyCalls = 0;
    let notifyBusyMessage: string | undefined;
    const deps = baseDeps({
      notifyBusy: (message: string) => {
        notifyBusyCalls += 1;
        notifyBusyMessage = message;
      },
    });

    const outcome = await runPostRepositorySync(target, harness.services, deps);

    assert.strictEqual(outcome, 'busy');
    assert.strictEqual(notifyBusyCalls, 1);
    assert.ok(notifyBusyMessage?.includes(target.displayName));
    assert.ok(notifyBusyMessage?.includes('Импорт конфигураций'));
    assert.deepStrictEqual(harness.outputLines, [
      `[repository][post-sync][busy] "${target.displayName}": пропущено, выполняется "Импорт конфигураций"`,
    ]);
    assert.strictEqual(harness.guard.isBusy, true);
    assert.strictEqual(harness.guard.heldBy, 'Импорт конфигураций');
    assert.deepStrictEqual(harness.events, [], 'занятость чужой арендой не должна порождать новых переходов');
  });

  test('guard занят + вызов без deps (default-параметр) — "busy", реальный notifyConfigurationOperationBusy не бросает', async () => {
    const harness = createHarness();
    const target = TARGETS[0].target;
    const holderLease = harness.guard.tryAcquire('Обновление конфигураций');
    assert.ok(holderLease);

    // Подменяем реальный vscode-диалог только чтобы не показывать нотификацию
    // в тестовом хосте (внешний UI vscode, не бизнес-логика модуля) и убедиться,
    // что дефолтный notifyBusy действительно был вызван.
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    let shownMessage: string | undefined;
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = (message: string) => {
      shownMessage = message;
      return Promise.resolve(undefined);
    };

    try {
      const outcome = await runPostRepositorySync(target, harness.services);
      assert.strictEqual(outcome, 'busy');
      assert.ok(shownMessage?.includes(target.displayName));
    } finally {
      (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = originalShowInformationMessage;
    }
  });
});

suite('RepositoryDatabaseSync — ensureTargetUpdatedBeforeCommit', () => {
  const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'Основная конфигурация' };

  function changedFor(rootPath: string, name = 'Основная конфигурация'): ChangedConfiguration {
    return { kind: 'cf', rootPath, name, changedFilesCount: 3 };
  }

  test('изменений для целевого корня нет (есть для другого) — true, confirm не вызван, событий guard нет', async () => {
    const harness = createHarness({
      getChangedConfigurations: () => [changedFor(path.join(EXAMPLE_CF, '..', 'other'))],
    });
    const deps = baseDeps();

    const result = await ensureTargetUpdatedBeforeCommit(target, harness.services, deps);

    assert.strictEqual(result, true);
    assert.deepStrictEqual(harness.events, []);
  });

  [
    { label: 'каноничная форма', rootPath: EXAMPLE_CF },
    { label: 'другой регистр', rootPath: EXAMPLE_CF.toUpperCase() },
    // Конкатенация вручную (не через path.join/path.resolve), чтобы сегмент
    // "./" реально остался в строке до сравнения внутри production-кода —
    // path.join уже нормализовал бы его и тест ничем не отличался бы от
    // «каноничной формы» выше.
    { label: 'с ./ сегментом', rootPath: `${EXAMPLE_CF}${path.sep}.${path.sep}` },
  ].forEach(({ label, rootPath }) => {
    test(`сопоставление корня: ${label} — считается совпадением, confirm вызывается`, async () => {
      const harness = createHarness({
        getChangedConfigurations: () => [changedFor(rootPath)],
      });
      let confirmCalls = 0;
      const deps = baseDeps({
        confirmUpdateBeforeCommit: () => {
          confirmCalls += 1;
          return Promise.resolve(false);
        },
      });

      const result = await ensureTargetUpdatedBeforeCommit(target, harness.services, deps);

      assert.strictEqual(confirmCalls, 1);
      assert.strictEqual(result, false);
    });
  });

  test('изменения есть + guard занят — false, confirm НЕ вызван, notifyBusy(CONFIGURATION_OPERATION_BUSY_MESSAGE), update не вызван', async () => {
    const harness = createHarness({
      getChangedConfigurations: () => [changedFor(EXAMPLE_CF)],
    });
    const holderLease = harness.guard.tryAcquire('Хранилище: синхронизация');
    assert.ok(holderLease);
    harness.events.length = 0;

    const notifyBusyMessages: string[] = [];
    const deps = baseDeps({
      notifyBusy: (message: string) => { notifyBusyMessages.push(message); },
    });

    const result = await ensureTargetUpdatedBeforeCommit(target, harness.services, deps);

    assert.strictEqual(result, false);
    assert.deepStrictEqual(notifyBusyMessages, [CONFIGURATION_OPERATION_BUSY_MESSAGE]);
    assert.deepStrictEqual(harness.events, []);
    assert.strictEqual(harness.guard.heldBy, 'Хранилище: синхронизация');
  });

  test('confirm вернул false — false, update не вызывается, событий guard нет', async () => {
    const harness = createHarness({
      getChangedConfigurations: () => [changedFor(EXAMPLE_CF)],
    });
    const deps = baseDeps({
      confirmUpdateBeforeCommit: () => Promise.resolve(false),
    });

    const result = await ensureTargetUpdatedBeforeCommit(target, harness.services, deps);

    assert.strictEqual(result, false);
    assert.deepStrictEqual(harness.events, []);
  });

  TARGETS.forEach(({ label, target: parametrizedTarget }) => {
    test(`confirm true + update true (${label}) — true, аргументы update верны, guard занят во время update, markClean+refresh`, async () => {
      const harness = createHarness({
        getChangedConfigurations: () => [changedFor(parametrizedTarget.configRoot)],
      });
      const expectedName = parametrizedTarget.extensionName ?? parametrizedTarget.displayName;
      let updateCalls = 0;
      const deps = baseDeps({
        confirmUpdateBeforeCommit: () => Promise.resolve(true),
        updateMainConfiguration: parametrizedTarget.configKind === 'cf'
          ? (name, root, wsFolder, outputChannel, showSuccessMessage) => {
              updateCalls += 1;
              assert.strictEqual(harness.guard.isBusy, true);
              assert.strictEqual(name, expectedName);
              assert.strictEqual(root, parametrizedTarget.configRoot);
              assert.strictEqual(wsFolder, harness.services.workspaceFolder);
              assert.strictEqual(outputChannel, harness.services.outputChannel);
              assert.strictEqual(showSuccessMessage, false);
              return Promise.resolve(true);
            }
          : notCalled('updateMainConfiguration'),
        updateExtension: parametrizedTarget.configKind === 'cfe'
          ? (name, root, wsFolder, outputChannel, showSuccessMessage) => {
              updateCalls += 1;
              assert.strictEqual(harness.guard.isBusy, true);
              assert.strictEqual(name, expectedName);
              assert.strictEqual(root, parametrizedTarget.configRoot);
              assert.strictEqual(wsFolder, harness.services.workspaceFolder);
              assert.strictEqual(outputChannel, harness.services.outputChannel);
              assert.strictEqual(showSuccessMessage, false);
              return Promise.resolve(true);
            }
          : notCalled('updateExtension'),
      });

      const result = await ensureTargetUpdatedBeforeCommit(parametrizedTarget, harness.services, deps);

      assert.strictEqual(result, true);
      assert.strictEqual(updateCalls, 1);
      assert.deepStrictEqual(harness.markCleanCalls, [[parametrizedTarget.configRoot]]);
      assert.strictEqual(harness.treeRefreshCalls, 1);
      assert.strictEqual(harness.actionsViewCalls, 1);
      assert.strictEqual(harness.guard.isBusy, false);
      assert.deepStrictEqual(harness.events, [true, false]);
    });
  });

  test('update вернул false — false, markClean не вызывается, guard свободен', async () => {
    const harness = createHarness({
      getChangedConfigurations: () => [changedFor(EXAMPLE_CF)],
    });
    const deps = baseDeps({
      confirmUpdateBeforeCommit: () => Promise.resolve(true),
      updateMainConfiguration: () => Promise.resolve(false),
    });

    const result = await ensureTargetUpdatedBeforeCommit(target, harness.services, deps);

    assert.strictEqual(result, false);
    assert.strictEqual(harness.markCleanCalls.length, 0);
    assert.strictEqual(harness.guard.isBusy, false);
  });

  test('update бросил исключение — reject тем же объектом, guard свободен', async () => {
    const harness = createHarness({
      getChangedConfigurations: () => [changedFor(EXAMPLE_CF)],
    });
    const thrown = new Error('update-fail');
    const deps = baseDeps({
      confirmUpdateBeforeCommit: () => Promise.resolve(true),
      updateMainConfiguration: () => Promise.reject(thrown),
    });

    await assert.rejects(
      ensureTargetUpdatedBeforeCommit(target, harness.services, deps),
      (error: unknown) => {
        assert.strictEqual(error, thrown);
        return true;
      }
    );
    assert.strictEqual(harness.guard.isBusy, false);
  });

  test('TOCTOU: confirm занимает guard чужой арендой и возвращает true — false, notifyBusy вызван, update не вызван, чужая аренда цела', async () => {
    const harness = createHarness({
      getChangedConfigurations: () => [changedFor(EXAMPLE_CF)],
    });
    let foreignLease: ReturnType<ConfigurationOperationGuard['tryAcquire']> | undefined;
    const notifyBusyMessages: string[] = [];
    const deps = baseDeps({
      confirmUpdateBeforeCommit: () => {
        foreignLease = harness.guard.tryAcquire('Хранилище: синхронизация');
        return Promise.resolve(true);
      },
      notifyBusy: (message: string) => { notifyBusyMessages.push(message); },
    });

    const result = await ensureTargetUpdatedBeforeCommit(target, harness.services, deps);

    assert.strictEqual(result, false);
    assert.deepStrictEqual(notifyBusyMessages, [CONFIGURATION_OPERATION_BUSY_MESSAGE]);
    assert.strictEqual(harness.guard.isBusy, true);
    assert.strictEqual(harness.guard.heldBy, 'Хранилище: синхронизация');
    assert.ok(foreignLease, 'confirm обязан был успешно занять guard для воспроизведения гонки');
  });

  test('вызов без deps при отсутствии изменений — true (default-параметр не задействует QuickPick)', async () => {
    const harness = createHarness({
      getChangedConfigurations: () => [],
    });

    const result = await ensureTargetUpdatedBeforeCommit(target, harness.services);

    assert.strictEqual(result, true);
  });
});

suite('RepositoryDatabaseSync — refreshRepositoryUi', () => {
  test('обновляет дерево и панель действий', () => {
    let treeRefreshCalls = 0;
    let actionsViewCalls = 0;
    refreshRepositoryUi({
      treeProvider: { refresh: () => { treeRefreshCalls += 1; } } as unknown as MetadataTreeProvider,
      refreshActionsView: () => { actionsViewCalls += 1; },
    });

    assert.strictEqual(treeRefreshCalls, 1);
    assert.strictEqual(actionsViewCalls, 1);
  });
});
