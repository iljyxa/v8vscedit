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
  type RepositoryCliCommandServices,
} from '../../ui/commands/repository/RepositoryCommandRunner';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/**
 * Issue #1 — переписано под новый контракт: `maybeRestoreLockSnapshot*` удалены
 * (заменены `RepositoryLockSync`/`RepositoryUnlockSync` поверх
 * `RepositoryLockSnapshotStore`, см. `repositoryLockSync.test.ts`/
 * `repositoryUnlockSync.test.ts`), `runRepositoryCliCommand` остаётся обёрткой
 * с UI-реакцией для bind/create/unbind/dump/report/users/label (с issue #40 —
 * тоже под guard'ом, см. suite «аренда guard'а» ниже), а `executeRepositoryCli` —
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
  let services: RepositoryCliCommandServices;
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
      configurationOperationGuard: new ConfigurationOperationGuard(),
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
  [
    { label: 'cf', configKind: 'cf' as const, extensionName: undefined },
    { label: 'cfe EVOLC', configKind: 'cfe' as const, extensionName: 'EVOLC' },
  ].forEach(({ label, configKind, extensionName }) => {
    test(`подготовка успешна (${label}) → запуск получает DESIGNER, базу, хранилище, аргументы команды и -Extension только для cfe`, async () => {
      // Исполняемый файл с именем платформы: resolveV8ExecutablePath проверяет имя,
      // запуск подменён — настоящий Конфигуратор не нужен.
      const fakeV8 = path.join(workspaceRoot, 'bin', '1cv8');
      fs.mkdirSync(path.dirname(fakeV8), { recursive: true });
      fs.writeFileSync(fakeV8, '', 'utf-8');
      const defaults: Record<string, unknown> = { '--ibconnection': '/F/tmp/база', '--path': fakeV8 };
      if (extensionName) {
        defaults.extension = { [extensionName]: { 'repo-path': '/tmp/хранилище', 'repo-user': 'Admin' } };
      } else {
        defaults['--repo-path'] = '/tmp/хранилище';
        defaults['--repo-user'] = 'Admin';
      }
      fs.writeFileSync(path.join(workspaceRoot, 'env.json'), JSON.stringify({ default: defaults }), 'utf-8');
      const launched: { title: string; v8Path: string; designerArgs: string[] }[] = [];

      const result = await executeRepositoryCli(
        {
          command: 'repository-lock',
          target: { configRoot: target.configRoot, configKind, extensionName, displayName: 'Тест' },
          extraArgs: buildLockExtraArgs('/tmp/objects.xml'),
          progressTitle: 'Захват «Тест»',
        },
        services,
        (_request, title, v8Path, designerArgs) => {
          launched.push({ title, v8Path, designerArgs });
          return Promise.resolve({ status: 'done' });
        }
      );

      assert.deepStrictEqual(result, { status: 'done' });
      assert.strictEqual(launched.length, 1);
      const [call] = launched;
      assert.strictEqual(call.title, 'Захват «Тест»');
      assert.strictEqual(call.v8Path, fakeV8);
      assert.strictEqual(call.designerArgs[0], 'DESIGNER');
      const args = call.designerArgs.join(' ');
      assert.ok(args.includes('/ConfigurationRepositoryF /tmp/хранилище'), args);
      assert.ok(args.includes('/ConfigurationRepositoryN Admin'), args);
      assert.ok(args.includes('/ConfigurationRepositoryLock'), args);
      assert.ok(call.designerArgs.includes('-revised'), args);
      assert.strictEqual(call.designerArgs.includes('-Extension'), Boolean(extensionName), args);
      if (extensionName) {
        assert.deepStrictEqual(call.designerArgs.slice(-2), ['-Extension', extensionName]);
      }
      assert.deepStrictEqual(errorMessageCalls, []);
    });
  });
});

suite('RepositoryCommandRunner — runRepositoryCliCommand: обёртка с UI-реакцией', () => {
  let workspaceRoot: string;
  let repositoryService: RepositoryService;
  let target: RepositoryTarget;
  let services: RepositoryCliCommandServices;
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
      configurationOperationGuard: new ConfigurationOperationGuard(),
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
   * `runRepositoryCliCommand` — единственная точка входа для команд
   * bind/create/unbind/dump/report/users/label. Ветки `status:"interrupted"` и
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

/**
 * Раздел 10.6 «Ранее непокрытые ветки»: `runRepositoryCliCommand(options,
 * services, execute = executeRepositoryCli)` — внедрение `execute` вместо
 * c8-ignore на реальном процессе Конфигуратора. Позволяет детерминированно
 * проверить ветки `done`/`showSuccessMessage:false`/`afterSuccess` бросает/
 * `interrupted`/`failed`, для которых раньше требовался реальный процесс 1С
 * (см. предыдущий suite, ограничение задокументировано выше).
 * Решение test-writer по сигнатуре (план 10.3 указывает только сам факт
 * внедрения, не точную позицию параметра): третий необязательный параметр
 * `execute` со значением по умолчанию `executeRepositoryCli` — обратная
 * совместимость с уже написанными выше вызовами `runRepositoryCliCommand(options, services)`.
 */
suite('RepositoryCommandRunner — runRepositoryCliCommand: внедрение execute (issue #1, раздел 10.6)', () => {
  let workspaceRoot: string;
  let repositoryService: RepositoryService;
  let target: RepositoryTarget;
  let services: RepositoryCliCommandServices;
  let infoMessageCalls: unknown[][];
  let errorMessageCalls: unknown[][];
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
  let originalShowErrorMessage: typeof vscode.window.showErrorMessage;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-runclicmd-inject-'));
    repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
    target = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    services = {
      workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
      outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
      repositoryService,
      projectSecretStorage: new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot),
      configurationOperationGuard: new ConfigurationOperationGuard(),
    };
    infoMessageCalls = [];
    errorMessageCalls = [];
    originalShowInformationMessage = vscode.window.showInformationMessage;
    originalShowErrorMessage = vscode.window.showErrorMessage;
    (vscode.window as { showInformationMessage: (...args: unknown[]) => Thenable<undefined> }).showInformationMessage = (...args: unknown[]) => {
      infoMessageCalls.push(args);
      return Promise.resolve(undefined);
    };
    (vscode.window as { showErrorMessage: (...args: unknown[]) => Thenable<undefined> }).showErrorMessage = (...args: unknown[]) => {
      errorMessageCalls.push(args);
      return Promise.resolve(undefined);
    };
  });

  teardown(() => {
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = originalShowInformationMessage;
    (vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage = originalShowErrorMessage;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function baseOptions(): Parameters<typeof runRepositoryCliCommand>[0] {
    return {
      command: 'repository-bind',
      target,
      extraArgs: [],
      progressTitle: 'Привязка',
      progressStartMessage: 'Привязка...',
      successMessage: 'Готово',
      errorTitle: 'Ошибка привязки',
    };
  }

  test('extraArgs не передан — в execute уходит пустой список аргументов команды', async () => {
    const options = { ...baseOptions(), extraArgs: undefined };
    const requests: unknown[][] = [];

    const ok = await runRepositoryCliCommand(options, services, (request) => {
      requests.push([...request.extraArgs]);
      return Promise.resolve({ status: 'done' });
    });

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(requests, [[]]);
  });

  test('execute → {status:"done"}, showSuccessMessage не указан (по умолчанию true) — successMessage показан, afterSuccess вызван, результат true', async () => {
    let afterSuccessCalls = 0;
    const result = await runRepositoryCliCommand(
      { ...baseOptions(), afterSuccess: () => { afterSuccessCalls += 1; } },
      services,
      () => Promise.resolve({ status: 'done' })
    );
    assert.strictEqual(result, true);
    assert.strictEqual(afterSuccessCalls, 1);
    assert.strictEqual(infoMessageCalls.length, 1);
    assert.strictEqual(infoMessageCalls[0][0], 'Готово');
  });

  test('execute → {status:"done"}, showSuccessMessage:false — успех, но successMessage НЕ показывается', async () => {
    const result = await runRepositoryCliCommand(
      { ...baseOptions(), showSuccessMessage: false },
      services,
      () => Promise.resolve({ status: 'done' })
    );
    assert.strictEqual(result, true);
    assert.strictEqual(infoMessageCalls.length, 0);
  });

  test('execute → {status:"done"}, afterSuccess бросает исключение — showErrorMessage с errorTitle, результат false, successMessage не показан', async () => {
    const result = await runRepositoryCliCommand(
      { ...baseOptions(), afterSuccess: () => { throw new Error('сбой после успешной команды'); } },
      services,
      () => Promise.resolve({ status: 'done' })
    );
    assert.strictEqual(result, false);
    assert.strictEqual(infoMessageCalls.length, 0);
    assert.strictEqual(errorMessageCalls.length, 1);
    assert.ok(String(errorMessageCalls[0][0]).includes('сбой после успешной команды'));
  });

  test('execute → {status:"done"}, afterSuccess бросает НЕ-Error значение — сообщение через String(error) (ветка else тернарника)', async () => {
    const result = await runRepositoryCliCommand(
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- намеренно НЕ-Error для проверки ветки String(error).
      { ...baseOptions(), afterSuccess: () => { throw 'сбой-строкой'; } },
      services,
      () => Promise.resolve({ status: 'done' })
    );
    assert.strictEqual(result, false);
    assert.strictEqual(errorMessageCalls.length, 1);
    assert.ok(String(errorMessageCalls[0][0]).includes('сбой-строкой'));
  });

  test('execute → {status:"interrupted"} — showInformationMessage с сообщением прерывания, результат false (не showErrorMessage)', async () => {
    const result = await runRepositoryCliCommand(
      baseOptions(),
      services,
      () => Promise.resolve({ status: 'interrupted', message: 'отменено пользователем' })
    );
    assert.strictEqual(result, false);
    assert.strictEqual(errorMessageCalls.length, 0);
    assert.strictEqual(infoMessageCalls.length, 1);
    assert.ok(String(infoMessageCalls[0][0]).includes('отменено пользователем'));
  });

  test('execute → {status:"failed"} — showErrorMessage с errorTitle и сообщением, результат false', async () => {
    const result = await runRepositoryCliCommand(
      baseOptions(),
      services,
      () => Promise.resolve({ status: 'failed', message: 'сбой сети' })
    );
    assert.strictEqual(result, false);
    assert.strictEqual(errorMessageCalls.length, 1);
    assert.ok(String(errorMessageCalls[0][0]).includes('сбой сети'));
  });

  test('execute не передан — по умолчанию используется executeRepositoryCli (совпадает с прежним поведением: нет env.json → failed)', async () => {
    const result = await runRepositoryCliCommand(baseOptions(), services);
    assert.strictEqual(result, false);
    assert.strictEqual(errorMessageCalls.length, 1);
  });
});

/**
 * Issue #40: bind/create/unbind/dump/report/users/label запускают Конфигуратор на
 * той же базе, что импорт и обновление, поэтому процесс идёт только внутри аренды
 * общего guard'а. Guard настоящий, внедрены лишь процесс 1С и уведомление.
 */
suite('RepositoryCommandRunner — runRepositoryCliCommand: аренда guard\'а (issue #40)', () => {
  let workspaceRoot: string;
  let guard: ConfigurationOperationGuard;
  let services: RepositoryCliCommandServices;
  let target: RepositoryTarget;
  let logLines: string[];
  let infoMessageCalls: unknown[][];
  let errorMessageCalls: unknown[][];
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
  let originalShowErrorMessage: typeof vscode.window.showErrorMessage;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-runclicmd-guard-'));
    guard = new ConfigurationOperationGuard();
    logLines = [];
    target = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    services = {
      workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
      outputChannel: { appendLine: (line: string) => { logLines.push(line); } } as unknown as vscode.OutputChannel,
      repositoryService: new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot)),
      projectSecretStorage: new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot),
      configurationOperationGuard: guard,
    };
    infoMessageCalls = [];
    errorMessageCalls = [];
    originalShowInformationMessage = vscode.window.showInformationMessage;
    originalShowErrorMessage = vscode.window.showErrorMessage;
    (vscode.window as { showInformationMessage: (...args: unknown[]) => Thenable<undefined> }).showInformationMessage = (...args: unknown[]) => {
      infoMessageCalls.push(args);
      return Promise.resolve(undefined);
    };
    (vscode.window as { showErrorMessage: (...args: unknown[]) => Thenable<undefined> }).showErrorMessage = (...args: unknown[]) => {
      // Модальная ошибка до release() держала бы guard до закрытия окна (запрет №18).
      errorMessageCalls.push([...args, guard.isBusy]);
      return Promise.resolve(undefined);
    };
  });

  teardown(() => {
    (vscode.window as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = originalShowInformationMessage;
    (vscode.window as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage = originalShowErrorMessage;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function options(): Parameters<typeof runRepositoryCliCommand>[0] {
    return {
      command: 'repository-report',
      target,
      extraArgs: ['-File', '/tmp/report.txt'],
      progressTitle: 'Отчёт по хранилищу: Тест',
      progressStartMessage: 'Строю отчёт...',
      successMessage: 'Отчёт сформирован',
      errorTitle: 'Ошибка отчёта',
    };
  }

  test('guard занят импортом — Конфигуратор не запускается, уведомление о занятости с держателем, false, чужая аренда цела', async () => {
    const lease = guard.tryAcquire('Импорт конфигураций');
    const busyMessages: string[] = [];
    let afterSuccessCalls = 0;

    const ok = await runRepositoryCliCommand(
      { ...options(), afterSuccess: () => { afterSuccessCalls += 1; } },
      services,
      () => { throw new Error('Конфигуратор не должен запускаться при занятом guard\'е'); },
      (message) => { busyMessages.push(message); }
    );

    assert.strictEqual(ok, false);
    assert.strictEqual(afterSuccessCalls, 0);
    assert.deepStrictEqual(busyMessages, [
      'Отчёт по хранилищу: Тест: уже выполняется операция "Импорт конфигураций". Дождитесь её завершения.',
    ]);
    assert.ok(logLines.some((line) => line.startsWith('[repository][busy]') && line.includes('Импорт конфигураций')), logLines.join('\n'));
    assert.strictEqual(infoMessageCalls.length, 0);
    assert.strictEqual(errorMessageCalls.length, 0);
    assert.strictEqual(guard.heldBy, 'Импорт конфигураций');
    lease?.release();
  });

  test('guard свободен — Конфигуратор работает под арендой с заголовком операции, после завершения guard свободен', async () => {
    const heldDuringCli: (string | undefined)[] = [];
    const heldDuringAfterSuccess: boolean[] = [];

    const ok = await runRepositoryCliCommand(
      { ...options(), afterSuccess: () => { heldDuringAfterSuccess.push(guard.isBusy); } },
      services,
      () => {
        heldDuringCli.push(guard.heldBy);
        return Promise.resolve({ status: 'done' });
      },
      () => { throw new Error('уведомление о занятости не ожидается'); }
    );

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(heldDuringCli, ['Отчёт по хранилищу: Тест']);
    assert.deepStrictEqual(heldDuringAfterSuccess, [false]);
    assert.strictEqual(guard.isBusy, false);
    assert.strictEqual(infoMessageCalls.length, 1);
  });

  test('Конфигуратор вернул ошибку — модальная ошибка показывается уже после освобождения guard\'а', async () => {
    const ok = await runRepositoryCliCommand(
      options(),
      services,
      () => Promise.resolve({ status: 'failed', message: 'хранилище недоступно' }),
      () => { throw new Error('уведомление о занятости не ожидается'); }
    );

    assert.strictEqual(ok, false);
    assert.strictEqual(errorMessageCalls.length, 1);
    assert.ok(String(errorMessageCalls[0][0]).includes('хранилище недоступно'));
    assert.strictEqual(errorMessageCalls[0].at(-1), false);
    assert.strictEqual(guard.isBusy, false);
  });

  test('запуск Конфигуратора бросил исключение — guard освобождается, исключение уходит вызывающему', async () => {
    await assert.rejects(
      runRepositoryCliCommand(
        options(),
        services,
        () => Promise.reject(new Error('сбой запуска')),
        () => { throw new Error('уведомление о занятости не ожидается'); }
      ),
      /сбой запуска/
    );
    assert.strictEqual(guard.isBusy, false);
  });

  test('уведомление о занятости по умолчанию — информационное сообщение без ожидания закрытия', async () => {
    const lease = guard.tryAcquire('Обновление конфигураций');
    let resolveInfo: (() => void) | undefined;
    (vscode.window as { showInformationMessage: (...args: unknown[]) => Thenable<undefined> }).showInformationMessage = (...args: unknown[]) => {
      infoMessageCalls.push(args);
      // Нотификация «не закрывается»: команда не должна её ждать.
      return new Promise<undefined>((resolve) => { resolveInfo = () => { resolve(undefined); }; });
    };

    const ok = await runRepositoryCliCommand(options(), services, () => Promise.resolve({ status: 'done' }));

    assert.strictEqual(ok, false);
    assert.strictEqual(infoMessageCalls.length, 1);
    assert.ok(String(infoMessageCalls[0][0]).includes('"Обновление конфигураций"'));
    resolveInfo?.();
    lease?.release();
  });
});
