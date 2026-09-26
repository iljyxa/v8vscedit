import * as assert from 'assert';
import * as vscode from 'vscode';
import { chooseConflictResolutionModal, confirmRollbackModal, showNotification } from '../../ui/commands/repository/RepositoryFileSyncDialogs';

/**
 * `RepositoryFileSyncDialogs.listFiles` — единственная функция файла вне
 * защитной зоны "c8 ignore" (модальные диалоги vscode не автоматизируются в
 * тестовом хосте, см. комментарий в самом файле, CLAUDE.md п.4), но сама она
 * НЕ обращается к vscode — чистое форматирование списка путей. Проверяется
 * через реально экспортированные `chooseConflictResolutionModal`/
 * `confirmRollbackModal` с подменённым `vscode.window.showWarningMessage`
 * (тот же приём, что `editorReadonlyController.test.ts`/`bslReadonlyGuard.test.ts`
 * применяют к `vscode.commands.executeCommand`) — реальный модальный диалог не
 * показывается, но `listFiles` действительно выполняется и формирует `detail`.
 */
suite('RepositoryFileSyncDialogs — listFiles (через chooseConflictResolutionModal/confirmRollbackModal)', () => {
  function stubShowWarningMessage(capture: (detail: string) => void, resolveWith: string): () => void {
    const original = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = (
      _message: string,
      options: { detail?: string }
    ) => {
      capture(options.detail ?? '');
      return Promise.resolve(resolveWith);
    };
    return () => {
      (vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = original;
    };
  }

  test('список из ≤10 файлов выводится целиком, без сообщения об остатке', async () => {
    let detail = '';
    const restore = stubShowWarningMessage((value) => { detail = value; }, 'Заменить');
    try {
      const files = Array.from({ length: 3 }, (_v, i) => `Catalogs/Объект${String(i + 1)}.xml`);
      const choice = await chooseConflictResolutionModal({ operationLabel: 'Захват', objectLabel: 'Тест', conflictCount: files.length, files });

      assert.strictEqual(choice, 'replace');
      files.forEach((file) => assert.ok(detail.includes(file), `detail должен содержать "${file}"`));
      assert.ok(!detail.includes('и ещё'), 'При ≤10 файлах сообщения об остатке быть не должно.');
    } finally {
      restore();
    }
  });

  test('список из >10 файлов обрезается до 10 с сообщением "… и ещё N"', async () => {
    let detail = '';
    const restore = stubShowWarningMessage((value) => { detail = value; }, 'Оставить изменения');
    try {
      const files = Array.from({ length: 13 }, (_v, i) => `Catalogs/Объект${String(i + 1)}.xml`);
      const choice = await confirmRollbackModal({ objectLabel: 'Тест', objectCount: 1, changedCount: 13, missingCount: 0, extraCount: 0, files });

      assert.strictEqual(choice, false);
      files.slice(0, 10).forEach((file) => assert.ok(detail.includes(file), `detail должен содержать "${file}"`));
      assert.ok(!detail.includes(files[10]), 'Файлы сверх лимита не должны попадать в список целиком.');
      assert.ok(detail.includes('… и ещё 3'), `detail должен упоминать остаток: "${detail}"`);
    } finally {
      restore();
    }
  });
});

/**
 * N4 (issue #1, раздел 10, попутная находка reviewer): `showNotification`
 * принимает функцию показа ЧЕРЕЗ ПАРАМЕТР — vscode.window не используется напрямую,
 * поэтому она тестируется юнит-тестом с внедрённым `show`, а не через vscode-стаб
 * (см. решение оркестратора — функция должна покинуть c8-ignore-блок файла).
 */
suite('RepositoryFileSyncDialogs — showNotification (внедрённый show, issue #1, N4)', () => {
  test('без actions — show вызывается с одним сообщением, без пунктов меню', async () => {
    const calls: unknown[][] = [];
    const show = (...args: unknown[]): Thenable<string | undefined> => {
      calls.push(args);
      return Promise.resolve(undefined);
    };

    showNotification(show, 'Сообщение без действий');
    await Promise.resolve();

    assert.deepStrictEqual(calls, [['Сообщение без действий']]);
  });

  test('с actions — show вызывается с метками кнопок; закрытие без выбора (undefined) не запускает ни один callback', async () => {
    let ranA = false;
    let ranB = false;
    const show = (_message: string, ...items: string[]): Thenable<string | undefined> => {
      assert.deepStrictEqual(items, ['A', 'B']);
      return Promise.resolve(undefined);
    };

    showNotification(show, 'Сообщение с действиями', [
      { label: 'A', run: () => { ranA = true; } },
      { label: 'B', run: () => { ranB = true; } },
    ]);
    await Promise.resolve();

    assert.strictEqual(ranA, false);
    assert.strictEqual(ranB, false);
  });

  test('выбор конкретного действия запускает ИМЕННО его callback, остальные не трогает', async () => {
    let ranA = false;
    let ranB = false;
    const show = (): Thenable<string | undefined> => Promise.resolve('B');

    showNotification(show, 'Сообщение', [
      { label: 'A', run: () => { ranA = true; } },
      { label: 'B', run: () => { ranB = true; } },
    ]);
    await Promise.resolve();

    assert.strictEqual(ranA, false);
    assert.strictEqual(ranB, true);
  });
});
