import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildCommandDesignerArgs,
  buildLockExtraArgs,
  executeRepositoryCli,
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
      projectSecretStorage: {} as unknown as ProjectSecretStorage,
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
});
