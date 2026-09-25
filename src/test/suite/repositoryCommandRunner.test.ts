import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildCommandDesignerArgs,
  buildLockExtraArgs,
  buildRepositoryCommitRequest,
  buildRepositoryUnlockRequest,
  buildRepositoryUpdateRequest,
  executeRepositoryCli,
  runRepositoryCliCommand,
  type RepositoryCliServices,
} from '../../ui/commands/repository/RepositoryCommandRunner';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/**
 * Issue #1 — переписано под новый контракт: `maybeRestoreLockSnapshot*` удалены
 * (заменены `RepositoryLockSync`/`RepositoryUnlockSync` поверх
 * `RepositoryLockSnapshotStore`, см. `repositoryLockSync.test.ts`/
 * `repositoryUnlockSync.test.ts`), `runRepositoryCliCommand` остаётся обёрткой
 * для операций мимо guard'а (bind/create/unbind/dump/report/users/label —
 * известное ограничение, план архитектора п.2.1), а `executeRepositoryCli` —
 * новая функция БЕЗ модальных окон, вызываемая ТОЛЬКО внутри
 * `configurationOperationGuard.runExclusive` из `RepositoryLockSync`/
 * `RepositoryUnlockSync`. Критерий приёмки №3: lock всегда получает `-Revised`
 * вне зависимости от настроек (issue #1, дефект №2 — ручная проверка на
 * реальном Конфигураторе, см. план разд. 6, п.1).
 *
 * Решение (неоднозначность плана — точный порядок внутренних проверок
 * `executeRepositoryCli` не описан): команда валидируется (`buildCommandDesignerArgs`)
 * РАНЬШЕ обращения к `env.json`/резолвинга подключения — так «неизвестная
 * команда» детерминированно проверяется без реального окружения, а порядок
 * проверок не совпадает случайно с «нет env.json» по тексту сообщения.
 */

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

suite('RepositoryCommandRunner — buildLockExtraArgs (issue #1, критерий №3 — lock всегда с -Revised)', () => {
  test('всегда включает -Revised вне зависимости от настроек синхронизации', () => {
    assert.deepStrictEqual(buildLockExtraArgs('/tmp/objects.xml'), ['-ObjectsFile', '/tmp/objects.xml', '-Revised']);
  });

  test('buildCommandDesignerArgs("repository-lock", buildLockExtraArgs(...)) даёт designer-флаг -revised (в нижнем регистре)', () => {
    const args = buildCommandDesignerArgs('repository-lock', buildLockExtraArgs('C:\\tmp\\objects.xml'));
    assert.deepStrictEqual(args, ['/ConfigurationRepositoryLock', '-Objects', 'C:\\tmp\\objects.xml', '-revised']);
  });
});

suite('RepositoryCommandRunner — buildCommandDesignerArgs: unlock/update/commit флаги', () => {
  [true, false].forEach((force) => {
    test(`repository-unlock: force=${String(force)}`, () => {
      const args = buildCommandDesignerArgs('repository-unlock', [
        '-ObjectsFile', '/tmp/o.xml',
        ...(force ? ['-Force'] : []),
      ]);
      const expected = ['/ConfigurationRepositoryUnLock', '-Objects', '/tmp/o.xml'];
      if (force) {
        expected.push('-force');
      }
      assert.deepStrictEqual(args, expected);
    });
  });

  [
    { force: false, version: undefined },
    { force: true, version: undefined },
    { force: false, version: '125' },
    { force: true, version: '125' },
  ].forEach(({ force, version }) => {
    test(`repository-update: force=${String(force)}, version=${String(version)}`, () => {
      const extraArgs = [
        '-ObjectsFile', '/tmp/o.xml',
        ...(version ? ['-Version', version] : []),
        ...(force ? ['-Force'] : []),
      ];
      const args = buildCommandDesignerArgs('repository-update', extraArgs);
      const expected = ['/ConfigurationRepositoryUpdateCfg', '-Objects', '/tmp/o.xml'];
      if (version) {
        expected.push('-v', version);
      }
      if (force) {
        expected.push('-force');
      }
      assert.deepStrictEqual(args, expected);
    });
  });

  [
    { comment: '', keepLocked: false, force: false },
    { comment: 'Комментарий', keepLocked: false, force: false },
    { comment: '', keepLocked: true, force: false },
    { comment: '', keepLocked: false, force: true },
    { comment: 'Комментарий', keepLocked: true, force: true },
  ].forEach(({ comment, keepLocked, force }) => {
    test(`repository-commit: comment=${JSON.stringify(comment)}, keepLocked=${String(keepLocked)}, force=${String(force)}`, () => {
      const extraArgs = [
        '-ObjectsFile', '/tmp/o.xml',
        ...(comment ? ['-Comment', comment] : []),
        ...(keepLocked ? ['-KeepLocked'] : []),
        ...(force ? ['-Force'] : []),
      ];
      const args = buildCommandDesignerArgs('repository-commit', extraArgs);
      const expected = ['/ConfigurationRepositoryCommit', '-Objects', '/tmp/o.xml'];
      if (comment) {
        expected.push('-comment', comment);
      }
      if (keepLocked) {
        expected.push('-keepLocked');
      }
      if (force) {
        expected.push('-force');
      }
      assert.deepStrictEqual(args, expected);
    });
  });

  test('неизвестная команда хранилища — бросает исключение с именем команды', () => {
    assert.throws(() => buildCommandDesignerArgs('repository-no-such-command', []), /Неизвестная команда хранилища: repository-no-such-command/);
  });
});

suite('RepositoryCommandRunner — build*Request: обе стороны ternary-веток по force/comment', () => {
  const target: RepositoryTarget = { configRoot: '/tmp/repo', configKind: 'cf', displayName: 'Тест' };

  [false, true].forEach((force) => {
    test(`buildRepositoryUnlockRequest: force=${String(force)}`, () => {
      const request = buildRepositoryUnlockRequest(target, '/tmp/o.xml', 'Товары', force);
      const expected = ['-ObjectsFile', '/tmp/o.xml', ...(force ? ['-Force'] : [])];
      assert.deepStrictEqual(request.extraArgs, expected);
      assert.deepStrictEqual(
        buildCommandDesignerArgs('repository-unlock', request.extraArgs),
        ['/ConfigurationRepositoryUnLock', '-Objects', '/tmp/o.xml', ...(force ? ['-force'] : [])]
      );
    });
  });

  [
    { version: undefined, force: false },
    { version: '125', force: true },
  ].forEach(({ version, force }) => {
    test(`buildRepositoryUpdateRequest: version=${String(version)}, force=${String(force)}`, () => {
      const request = buildRepositoryUpdateRequest(target, '/tmp/o.xml', 'Товары', { version, force });
      const expected = ['-ObjectsFile', '/tmp/o.xml', ...(version ? ['-Version', version] : []), ...(force ? ['-Force'] : [])];
      assert.deepStrictEqual(request.extraArgs, expected);
    });
  });

  [
    { comment: '', force: false },
    { comment: 'Комментарий', force: true },
  ].forEach(({ comment, force }) => {
    test(`buildRepositoryCommitRequest: comment=${JSON.stringify(comment)}, force=${String(force)}`, () => {
      const request = buildRepositoryCommitRequest(target, '/tmp/o.xml', 'Товары', { comment, keepLocked: false, force });
      const expected = [
        '-ObjectsFile', '/tmp/o.xml',
        ...(comment ? ['-Comment', comment] : []),
        ...(force ? ['-Force'] : []),
      ];
      assert.deepStrictEqual(request.extraArgs, expected);
      assert.deepStrictEqual(
        buildCommandDesignerArgs('repository-commit', request.extraArgs),
        ['/ConfigurationRepositoryCommit', '-Objects', '/tmp/o.xml', ...(comment ? ['-comment', comment] : []), ...(force ? ['-force'] : [])]
      );
    });
  });
});

suite('RepositoryCommandRunner — executeRepositoryCli: гарантированно детерминированные failure-ветки (без реального процесса 1С)', () => {
  let workspaceRoot: string;
  let repositoryService: RepositoryService;
  let target: RepositoryTarget;
  let services: RepositoryCliServices;
  let errorMessageCalls: unknown[][];
  let originalShowErrorMessage: typeof vscode.window.showErrorMessage;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-execcli-'));
    repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
    target = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    services = {
      workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
      outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
      repositoryService,
      // Реальный ProjectSecretStorage (не пустая заглушка): часть тестов в этом файле
      // доходит до resolveDbPassword(), которому нужен настоящий метод getDbPassword().
      projectSecretStorage: new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot),
    };
    errorMessageCalls = [];
    originalShowErrorMessage = vscode.window.showErrorMessage;
    (vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage = (...args: unknown[]) => {
      errorMessageCalls.push(args);
      return Promise.resolve(undefined);
    };
  });

  teardown(() => {
    (vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage = originalShowErrorMessage;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('неизвестная команда → {status:"failed"}, без showErrorMessage (модальные окна запрещены внутри аренды)', async () => {
    const result = await executeRepositoryCli({ command: 'repository-no-such-command', target, extraArgs: [] }, services);
    assert.strictEqual(result.status, 'failed');
    assert.ok('message' in result && typeof result.message === 'string' && result.message.length > 0);
    assert.deepStrictEqual(errorMessageCalls, []);
  });

  test('нет env.json (нет привязки/подключения) → {status:"failed"}, без showErrorMessage', async () => {
    // workspaceRoot создан пустым — env.json заведомо отсутствует.
    const result = await executeRepositoryCli(
      { command: 'repository-lock', target, extraArgs: buildLockExtraArgs('/tmp/objects.xml') },
      services
    );
    assert.strictEqual(result.status, 'failed');
    assert.deepStrictEqual(errorMessageCalls, []);
  });

  test('env.json есть (--ibconnection валиден), но нет привязки к хранилищу (нет --repo-path) → {status:"failed"} с сообщением о привязке', async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, 'env.json'),
      JSON.stringify({ default: { '--ibconnection': '/FC:\\Fake\\Base' } }),
      'utf-8'
    );

    const result = await executeRepositoryCli(
      { command: 'repository-lock', target, extraArgs: buildLockExtraArgs('/tmp/objects.xml') },
      services
    );

    assert.strictEqual(result.status, 'failed');
    assert.ok('message' in result && result.message.includes('не настроено подключение к хранилищу в env.json'));
    assert.deepStrictEqual(errorMessageCalls, []);
  });

  [
    { label: 'cf (без -Extension)', configKind: 'cf' as const, extensionName: undefined },
    { label: 'cfe (с -Extension)', configKind: 'cfe' as const, extensionName: 'EVOLC' },
  ].forEach(({ label, configKind, extensionName }) => {
    test(`env.json с привязкой есть, исполняемый файл 1С не найден (${label}) → аргументы Конфигуратора собираются (includeChildObjects/-Extension), сбой только на поиске платформы`, async () => {
      // Явный несуществующий `--path`: без него поиск берёт установленную платформу
      // (/opt/1cv8, Program Files) и запускает настоящий Конфигуратор — исход зависел
      // бы от машины, а не от кода.
      const defaults: Record<string, unknown> = {
        '--ibconnection': '/FC:\\Fake\\Base',
        '--path': path.join(workspaceRoot, 'нет-платформы', '1cv8'),
      };
      if (extensionName) {
        // Привязка расширения хранится в собственной секции env.json (RepositoryBindingStore.saveBinding).
        defaults.extension = { [extensionName]: { 'repo-path': 'http://fake-repo', 'repo-user': 'Administrator' } };
      } else {
        defaults['--repo-path'] = 'http://fake-repo';
        defaults['--repo-user'] = 'Administrator';
      }
      fs.writeFileSync(path.join(workspaceRoot, 'env.json'), JSON.stringify({ default: defaults }), 'utf-8');
      const bindingTarget: RepositoryTarget = { configRoot: target.configRoot, configKind, extensionName, displayName: 'Тест' };

      const result = await executeRepositoryCli(
        { command: 'repository-lock', target: bindingTarget, extraArgs: buildLockExtraArgs('/tmp/objects.xml') },
        services
      );

      // Единственный детерминированный исход дальше сборки аргументов (сам запуск
      // процесса — c8 ignore).
      assert.strictEqual(result.status, 'failed');
      assert.ok('message' in result && result.message.includes('Не найден исполняемый файл 1С'));
    });
  });
});

suite('RepositoryCommandRunner — runRepositoryCliCommand: обёртка с UI-реакцией', () => {
  let workspaceRoot: string;
  let repositoryService: RepositoryService;
  let target: RepositoryTarget;
  let services: RepositoryCliServices;
  let errorMessageCalls: unknown[][];
  let originalShowErrorMessage: typeof vscode.window.showErrorMessage;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-runclicmd-'));
    repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
    target = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    services = {
      workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
      outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
      repositoryService,
      // Реальный ProjectSecretStorage (не пустая заглушка): часть тестов в этом файле
      // доходит до resolveDbPassword(), которому нужен настоящий метод getDbPassword().
      projectSecretStorage: new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot),
    };
    errorMessageCalls = [];
    originalShowErrorMessage = vscode.window.showErrorMessage;
    (vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage = (...args: unknown[]) => {
      errorMessageCalls.push(args);
      return Promise.resolve(undefined);
    };
  });

  teardown(() => {
    (vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage = originalShowErrorMessage;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  /**
   * `runRepositoryCliCommand` — единственная точка входа для команд ВНЕ guard'а
   * (bind/create/unbind/dump/report/users/label). Ветки `status:"interrupted"` и
   * успешный путь (`afterSuccess`/`showSuccessMessage`) зависят от того, что
   * `executeRepositoryCli` вернёт статус "done" либо "interrupted" — а это способен
   * дать только реальный запуск Конфигуратора внутри runRepositoryDesigner
   * (помечена c8-ignore, недоступна в тестовом окружении без платформы 1С).
   * Поэтому здесь детерминированно и без реального процесса проверяется только
   * ветка "failed" — остальные две задокументированы как остаток в итоговом
   * отчёте test-writer.
   */
  test('executeRepositoryCli вернул {status:"failed"} (нет env.json) → showErrorMessage с errorTitle, возвращает false', async () => {
    const result = await runRepositoryCliCommand(
      {
        command: 'repository-lock',
        target,
        extraArgs: buildLockExtraArgs('/tmp/objects.xml'),
        progressTitle: 'Захват',
        progressStartMessage: 'Захват...',
        successMessage: 'Готово',
        errorTitle: 'Ошибка захвата',
      },
      services
    );

    assert.strictEqual(result, false);
    assert.strictEqual(errorMessageCalls.length, 1);
    assert.ok(String(errorMessageCalls[0][0]).startsWith('Ошибка захвата\n'));
  });
});
