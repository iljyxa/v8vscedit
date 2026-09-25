import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EditorReadonlyController } from '../../ui/readonly/EditorReadonlyController';
import { BslReadonlyGuard } from '../../ui/readonly/BslReadonlyGuard';
import type { RepositoryService } from '../../infra/repository/RepositoryService';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';

/**
 * `EditorReadonlyController` — подписчик на `RepositoryService.onDidChangeLocks`
 * (issue #1, критерий приёмки №13, план архитектора «C. Readonly»): переводит уже
 * открытые вкладки BSL/XML захваченного объекта в writable без переоткрытия, и
 * обратно в readonly после отмены захвата. Использует Extension Host (реальные
 * `vscode.window`/`vscode.workspace` API — открытие вкладок нельзя эмулировать
 * юнит-тестом), поэтому стиль harness такой же, как в `bslReadonlyGuard.test.ts`:
 * шпион поверх `vscode.commands.executeCommand`, делегирующий оригиналу.
 *
 * Решение (неоднозначность плана — точная сигнатура конструктора не описана):
 * `new EditorReadonlyController(repositoryService, supportService, bslReadonlyGuard, outputChannel)`
 * — симметрично уже существующему `BslReadonlyGuard(supportService, repositoryService, log)`.
 */

function fakeRepositoryService(overrides: Partial<RepositoryService>): RepositoryService {
  return overrides as unknown as RepositoryService;
}

function fakeSupportService(isLocked: (path: string) => boolean): SupportInfoService {
  return { isLocked } as unknown as SupportInfoService;
}

type ChangeLocksListener = (event: { target: { configRoot: string }; fullNames: readonly string[]; allObjects: readonly string[] }) => void;

suite('EditorReadonlyController — issue #1: readonly-переходы уже открытых вкладок без переоткрытия', () => {
  let tmpDir: string;
  let filePathA: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-editor-readonly-'));
    filePathA = path.join(tmpDir, 'Module.bsl');
    fs.writeFileSync(filePathA, 'Процедура Тест()\nКонецПроцедуры\n', 'utf-8');
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('видимая вкладка захваченного объекта: reset-readonly + BslReadonlyGuard.forget вызваны', async function () {
    this.timeout(10_000);
    const uri = vscode.Uri.file(filePathA);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => {
        listener = l;
        return { dispose: () => { listener = undefined; } };
      },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const forgetCalls: string[] = [];
    const originalForget = guard.forget.bind(guard);
    guard.forget = (forgetUri: vscode.Uri) => {
      forgetCalls.push(forgetUri.toString());
      originalForget(forgetUri);
    };

    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const disposable = controller.register();

    let resetCalls = 0;
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
      if (command === 'workbench.action.files.resetActiveEditorReadonlyInSession') {
        resetCalls += 1;
      }
      return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
    }) as typeof vscode.commands.executeCommand;

    try {
      assert.ok(listener, 'register() должен подписаться на onDidChangeLocks.');
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });
      await waitUntil(() => resetCalls >= 1, 3000);

      assert.strictEqual(resetCalls, 1);
      assert.ok(forgetCalls.includes(uri.toString()), 'При переходе в writable BslReadonlyGuard.forget должен быть вызван для этого файла.');
    } finally {
      disposable.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }
  });

  test('видимая вкладка после отмены захвата: set-readonly вызван, forget НЕ вызывается', async function () {
    this.timeout(10_000);
    const uri = vscode.Uri.file(filePathA);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => true,
      onDidChangeLocks: (l: ChangeLocksListener) => {
        listener = l;
        return { dispose: () => { listener = undefined; } };
      },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    let forgetCalls = 0;
    guard.forget = () => { forgetCalls += 1; };

    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const disposable = controller.register();

    let setCalls = 0;
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
      if (command === 'workbench.action.files.setActiveEditorReadonlyInSession') {
        setCalls += 1;
      }
      return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
    }) as typeof vscode.commands.executeCommand;

    try {
      listener?.({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: [] });
      await waitUntil(() => setCalls >= 1, 3000);

      assert.strictEqual(setCalls, 1);
      assert.strictEqual(forgetCalls, 0, 'При переходе в readonly forget вызываться не должен.');
    } finally {
      disposable.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }
  });

  test('файл вне configRoot события не трогается', async function () {
    this.timeout(10_000);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-editor-readonly-outside-'));
    const outsideFile = path.join(outsideDir, 'Другой.bsl');
    fs.writeFileSync(outsideFile, 'Процедура X() КонецПроцедуры', 'utf-8');
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outsideFile));
      await vscode.window.showTextDocument(doc, { preview: false });

      let listener: ChangeLocksListener | undefined;
      const repositoryService = fakeRepositoryService({
        isEditRestricted: () => false,
        onDidChangeLocks: (l: ChangeLocksListener) => {
          listener = l;
          return { dispose: () => { listener = undefined; } };
        },
      });
      const supportService = fakeSupportService(() => false);
      const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
      const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
      const disposable = controller.register();

      let anyReadonlyCommandCalls = 0;
      const originalExecuteCommand = vscode.commands.executeCommand;
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
        if (command.includes('ReadonlyInSession')) {
          anyReadonlyCommandCalls += 1;
        }
        return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
      }) as typeof vscode.commands.executeCommand;

      try {
        // Событие относится к СОВСЕМ ДРУГОМУ configRoot (tmpDir), файл открыт из outsideDir.
        listener?.({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(anyReadonlyCommandCalls, 0);
      } finally {
        disposable.dispose();
        (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('dispose() прекращает реакцию на дальнейшие события', async function () {
    this.timeout(10_000);
    const uri = vscode.Uri.file(filePathA);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    let listener: ChangeLocksListener | undefined;
    let disposeCalls = 0;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => {
        listener = l;
        return { dispose: () => { disposeCalls += 1; listener = undefined; } };
      },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const disposable = controller.register();

    disposable.dispose();
    assert.strictEqual(disposeCalls, 1, 'controller.register()-Disposable должен освобождать подписку onDidChangeLocks.');
    assert.strictEqual(listener, undefined);
  });
});

suite('BslReadonlyGuard — forget(uri)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-guard-forget-'));
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('после forget(uri) applyReadonly повторно выполняет readonly-команду для того же документа', async function () {
    this.timeout(10_000);
    const filePath = path.join(tmpDir, 'Module.bsl');
    fs.writeFileSync(filePath, 'Процедура Тест() КонецПроцедуры', 'utf-8');
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const supportService = { isLocked: () => true } as unknown as SupportInfoService;
    const repositoryService = { isEditRestricted: () => false } as unknown as RepositoryService;
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const applyReadonly = (guard as unknown as { applyReadonly: (editor: vscode.TextEditor) => Promise<void> }).applyReadonly.bind(guard);

    let executeCommandCalls = 0;
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
      if (command === 'workbench.action.files.setActiveEditorReadonlyInSession') {
        executeCommandCalls += 1;
      }
      return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
    }) as typeof vscode.commands.executeCommand;

    try {
      await applyReadonly(editor);
      await applyReadonly(editor);
      assert.strictEqual(executeCommandCalls, 1, 'До forget повторное применение не должно выполнять команду снова.');

      guard.forget(uri);

      await applyReadonly(editor);
      assert.strictEqual(executeCommandCalls, 2, 'После forget applyReadonly должен снова выполнить readonly-команду.');
    } finally {
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }
  });

  test('forget для незатронутого/незнакомого uri не бросает исключение', () => {
    const supportService = { isLocked: () => false } as unknown as SupportInfoService;
    const repositoryService = { isEditRestricted: () => false } as unknown as RepositoryService;
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    assert.doesNotThrow(() => guard.forget(vscode.Uri.file(path.join(tmpDir, 'НеОткрыт.bsl'))));
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Условие не выполнено за отведённое время ожидания');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
