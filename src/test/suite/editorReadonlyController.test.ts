import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EditorReadonlyController } from '../../ui/readonly/EditorReadonlyController';
import { BslReadonlyGuard } from '../../ui/readonly/BslReadonlyGuard';
import type { RepositoryService } from '../../infra/repository/RepositoryService';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';
import {
  describeTabs,
  diffTabs,
  isActiveDiff,
  RESET_COMMAND,
  revertDirtyAndCloseAll,
  SET_COMMAND,
  spyReadonlyCommands,
  textTabsOf,
  waitUntil as waitFor,
  type ReadonlyCommandSpy,
} from './support/editorTabsHarness';

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
      const outsideDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(outsideFile));
      await vscode.window.showTextDocument(outsideDoc, { preview: false });
      // Контрольная вкладка ВНУТРИ configRoot события: TARGET_WIDE_OWNER-эффект
      // (см. EditorReadonlyController) переводит в очередь ЛЮБОЙ открытый файл того же
      // configRoot независимо от fullNames — по факту её обработки проверяем, что
      // очередь действительно дошла до этого события, вместо угадывания задержки таймером.
      const controlDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePathA));
      await vscode.window.showTextDocument(controlDoc, { preview: false });

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

      const activeUriWhenReadonlyCommandCalled: string[] = [];
      const originalExecuteCommand = vscode.commands.executeCommand;
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
        if (command.includes('ReadonlyInSession')) {
          activeUriWhenReadonlyCommandCalled.push(vscode.window.activeTextEditor?.document.uri.toString() ?? '<none>');
        }
        return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
      }) as typeof vscode.commands.executeCommand;

      try {
        // Единственное событие относится к configRoot=tmpDir: контрольный файл (внутри
        // tmpDir) обязан получить readonly-переход, файл из outsideDir — нет.
        listener?.({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });
        await waitUntil(() => activeUriWhenReadonlyCommandCalled.includes(controlDoc.uri.toString()), 3000);

        assert.ok(
          !activeUriWhenReadonlyCommandCalled.includes(outsideDoc.uri.toString()),
          'Файл вне configRoot события не должен становиться активным редактором для readonly-команды.'
        );
      } finally {
        disposable.dispose();
        (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('вкладка сравнения (diff): переход выполняется через vscode.diff, reset — только для writable', async function () {
    this.timeout(10_000);
    // Левая сторона — вне configRoot: иначе (issue #63) она тоже получила бы переход
    // как файл объекта, а тест проверяет только правую сторону.
    const originalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-editor-readonly-original-'));
    const originalPath = path.join(originalDir, 'Original.bsl');
    fs.writeFileSync(originalPath, 'старое', 'utf-8');
    const modifiedUri = vscode.Uri.file(filePathA);
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(originalPath), modifiedUri, 'Сравнение', { preview: false });

    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const disposable = controller.register();

    let diffCalls = 0;
    let resetCalls = 0;
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
      if (command === 'vscode.diff') {
        diffCalls += 1;
      }
      if (command === 'workbench.action.files.resetActiveEditorReadonlyInSession') {
        resetCalls += 1;
      }
      return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
    }) as typeof vscode.commands.executeCommand;

    try {
      assert.ok(listener);
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });
      await waitUntil(() => resetCalls >= 1, 3000);
      assert.ok(diffCalls >= 1, 'вкладка сравнения обязана переоткрываться через vscode.diff, а не showTextDocument.');
      assert.strictEqual(resetCalls, 1);
    } finally {
      disposable.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
      fs.rmSync(originalDir, { recursive: true, force: true });
    }
  });

  test('«широкое» событие корня (fullNames содержит сентинел корня) — файлы объектов внутри configRoot тоже обрабатываются', async function () {
    this.timeout(10_000);
    const uri = vscode.Uri.file(filePathA);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
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
      assert.ok(listener);
      // Рекурсивный тумблер корня не перечисляет затронутые объекты явно — только сентинел.
      listener({ target: { configRoot: tmpDir }, fullNames: ['__configuration_root__'], allObjects: ['__configuration_root__'] });
      await waitUntil(() => resetCalls >= 1, 3000);
      assert.strictEqual(resetCalls, 1, 'файл внутри configRoot должен обрабатываться и при «широком» событии корня.');
    } finally {
      disposable.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }
  });

  test('восстановление исходного активного редактора: обработка видимого файла в другой колонке не должна оставлять его активным', async function () {
    this.timeout(10_000);
    const filePathB = path.join(tmpDir, 'ВКолонке2.bsl');
    fs.writeFileSync(filePathB, 'Процедура Z() КонецПроцедуры', 'utf-8');
    const uriA = vscode.Uri.file(filePathA);
    const uriB = vscode.Uri.file(filePathB);
    const docA = await vscode.workspace.openTextDocument(uriA);
    await vscode.window.showTextDocument(docA, { viewColumn: vscode.ViewColumn.One, preview: false });
    const docB = await vscode.workspace.openTextDocument(uriB);
    // Открывается РЯДОМ (вторая колонка) — обе вкладки остаются одновременно видимыми.
    await vscode.window.showTextDocument(docB, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    // Возвращаем фокус на A — активным редактором должен снова стать именно он.
    await vscode.window.showTextDocument(docA, { viewColumn: vscode.ViewColumn.One, preview: false });
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), uriA.toString(), 'предпосылка: A обязан быть активным редактором перед событием.');

    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
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
      assert.ok(listener);
      // Затрагивается ТОЛЬКО файл во второй колонке (B) — он видим, хотя активна колонка с A.
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.Б'], allObjects: ['Справочник.Б'] });
      await waitUntil(() => resetCalls >= 1, 3000);

      // Обработка B временно делала его активным — контроллер обязан вернуть фокус на A.
      await waitUntil(() => vscode.window.activeTextEditor?.document.uri.toString() === uriA.toString(), 3000);
      assert.strictEqual(vscode.window.activeTextEditor.document.uri.toString(), uriA.toString());
    } finally {
      disposable.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }
  });

  test('исключение внутри обработчика события (isEditRestricted бросает) — перехватывается в очереди, логируется, следующее событие обрабатывается', async function () {
    this.timeout(10_000);
    const uri = vscode.Uri.file(filePathA);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    let listener: ChangeLocksListener | undefined;
    let throwOnRestrictedCheck = true;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => {
        if (throwOnRestrictedCheck) {
          throw new Error('сбой чтения состояния захвата');
        }
        return false;
      },
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const logLines: string[] = [];
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: (line: string) => logLines.push(line) } as unknown as vscode.OutputChannel);
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
      assert.ok(listener);
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });
      await waitUntil(() => logLines.some((line) => line.includes('[readonly][error]') && line.includes('сбой чтения состояния захвата')), 3000);

      // Очередь не должна «застрять» — следующее событие обязано обработаться штатно.
      throwOnRestrictedCheck = false;
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });
      await waitUntil(() => resetCalls >= 1, 3000);
      assert.strictEqual(resetCalls, 1);
    } finally {
      disposable.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }
  });

  test('исключение внутри обработчика — НЕ-Error значение логируется через String(error) (ветка else тернарника)', async function () {
    this.timeout(10_000);
    const uri = vscode.Uri.file(filePathA);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });

    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      // Тест намеренно бросает НЕ-Error значение — проверяет ветку String(error) в logError().
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      isEditRestricted: () => { throw { code: 'сбой-не-error' }; },
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const logLines: string[] = [];
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: (line: string) => logLines.push(line) } as unknown as vscode.OutputChannel);
    const disposable = controller.register();

    try {
      assert.ok(listener);
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });
      await waitUntil(() => logLines.some((line) => line.includes('[readonly][error]')), 3000);
      assert.ok(
        logLines.some((line) => line.includes('[readonly][error]') && line.includes('[object Object]')),
        'НЕ-Error причина должна логироваться через String(error), а не через .message.'
      );
    } finally {
      disposable.dispose();
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

/**
 * Раздел 10, Р9/10.3: `EditorReadonlyController` получает публичные
 * `onActiveEditorChanged(editor)`/`onDocumentClosed(document)` — раньше это были
 * приватные замыкания внутри `register()`. Прямой вызов делает переход
 * скрытой вкладки в writable/readonly детерминированным без ожидания реального
 * события `vscode.window.onDidChangeActiveTextEditor` (10.6: «ожидание по
 * эффекту, не по таймеру») — обработчик идемпотентен (после первого успешного
 * применения запись в `pending` удаляется), поэтому безопасен даже если
 * `register()` тоже подписан на то же самое реальное событие.
 */
suite('EditorReadonlyController — публичные onActiveEditorChanged/onDocumentClosed (issue #1, раздел 10, 10.6)', () => {
  let tmpDir: string;
  let filePathA: string;
  let filePathB: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-editor-readonly-public-'));
    filePathA = path.join(tmpDir, 'А.bsl');
    filePathB = path.join(tmpDir, 'Б.bsl');
    fs.writeFileSync(filePathA, 'Процедура А() КонецПроцедуры\n', 'utf-8');
    fs.writeFileSync(filePathB, 'Процедура Б() КонецПроцедуры\n', 'utf-8');
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('скрытая вкладка: pending выставлен событием → прямой onActiveEditorChanged() применяет readonly-команду сразу, без ожидания реального события', async function () {
    this.timeout(10_000);
    const uriA = vscode.Uri.file(filePathA);
    const uriB = vscode.Uri.file(filePathB);
    const docA = await vscode.workspace.openTextDocument(uriA);
    const docB = await vscode.workspace.openTextDocument(uriB);
    // Обе вкладки в ОДНОЙ группе: активна станет последняя открытая (Б); А остаётся
    // существующей, но НЕ активной ("скрытой") вкладкой той же группы.
    await vscode.window.showTextDocument(docA, { preview: false });
    await vscode.window.showTextDocument(docB, { preview: false });

    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const disposable = controller.register();

    let resetCallsForA = 0;
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
      if (command === 'workbench.action.files.resetActiveEditorReadonlyInSession' && vscode.window.activeTextEditor?.document.uri.toString() === uriA.toString()) {
        resetCallsForA += 1;
      }
      return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
    }) as typeof vscode.commands.executeCommand;

    try {
      assert.ok(listener);
      // А сейчас СКРЫТА (не активна) — событие должно уйти в defer/pending, а не applyNow.
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });

      // Активируем А по-настоящему (нужен реальный TextEditor — команда readonly работает
      // с текущим активным редактором) и СРАЗУ вызываем публичный метод напрямую —
      // без опроса/ожидания: идемпотентность гарантирует корректный результат независимо
      // от того, успел ли к этому моменту сработать и реальный обработчик register().
      const editorA = await vscode.window.showTextDocument(docA, { preview: false });
      controller.onActiveEditorChanged(editorA);

      assert.strictEqual(resetCallsForA, 1, 'Прямой вызов onActiveEditorChanged должен немедленно применить readonly-переход из pending.');
    } finally {
      disposable.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }
  });

  test('onDocumentClosed(document) очищает pending: последующий onActiveEditorChanged для того же файла уже ничего не применяет', async function () {
    this.timeout(10_000);
    const uriA = vscode.Uri.file(filePathA);
    const uriB = vscode.Uri.file(filePathB);
    const docA = await vscode.workspace.openTextDocument(uriA);
    const docB = await vscode.workspace.openTextDocument(uriB);
    await vscode.window.showTextDocument(docA, { preview: false });
    await vscode.window.showTextDocument(docB, { preview: false });

    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const disposable = controller.register();

    let resetCallsForA = 0;
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
      if (command === 'workbench.action.files.resetActiveEditorReadonlyInSession' && vscode.window.activeTextEditor?.document.uri.toString() === uriA.toString()) {
        resetCallsForA += 1;
      }
      return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
    }) as typeof vscode.commands.executeCommand;

    try {
      assert.ok(listener);
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.А'], allObjects: ['Справочник.А'] });

      // Пользователь закрывает вкладку А ДО того, как она стала активной снова.
      controller.onDocumentClosed(docA);

      const editorA = await vscode.window.showTextDocument(docA, { preview: false });
      controller.onActiveEditorChanged(editorA);

      assert.strictEqual(resetCallsForA, 0, 'После onDocumentClosed отложенный переход должен быть забыт — команда readonly не должна вызываться.');
    } finally {
      disposable.dispose();
      (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand;
    }
  });

  test('onActiveEditorChanged(undefined) — защитная ветка, не бросает исключение', () => {
    const repositoryService = fakeRepositoryService({ isEditRestricted: () => false, onDidChangeLocks: () => ({ dispose: () => undefined }) });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    assert.doesNotThrow(() => controller.onActiveEditorChanged(undefined));
  });
});

/**
 * Критерий приёмки 10.1.12: событие с единицей-подчинённым (форма) пересчитывает
 * только вкладки файлов ЭТОЙ формы; событие с владельцем верхнего уровня —
 * вкладки владельца И его подчинённых единиц. Реальная структура путей
 * (`Catalogs/<Owner>/Ext/ObjectModule.bsl`, `Catalogs/<Owner>/Forms/<Form>/Ext/
 * Form/Module.bsl`) — та же, что использует production-резолвер путей
 * (`resolveLockUnitByRelativePath`/`resolveOwnerFullNameByRelativePath`), без
 * заглушек этой логики.
 */
suite('EditorReadonlyController — цепочка единиц (issue #1, раздел 10, критерий 10.1.12)', () => {
  let tmpDir: string;
  let ownerModulePath: string;
  let formModulePath: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-editor-readonly-chain-'));
    ownerModulePath = path.join(tmpDir, 'Catalogs', 'Тест', 'Ext', 'ObjectModule.bsl');
    formModulePath = path.join(tmpDir, 'Catalogs', 'Тест', 'Forms', 'Форма', 'Ext', 'Form', 'Module.bsl');
    fs.mkdirSync(path.dirname(ownerModulePath), { recursive: true });
    fs.mkdirSync(path.dirname(formModulePath), { recursive: true });
    fs.writeFileSync(ownerModulePath, 'Процедура Владелец() КонецПроцедуры\n', 'utf-8');
    fs.writeFileSync(formModulePath, 'Процедура Форма() КонецПроцедуры\n', 'utf-8');
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function openBothVisible(): Promise<{ ownerUri: vscode.Uri; formUri: vscode.Uri }> {
    const ownerUri = vscode.Uri.file(ownerModulePath);
    const formUri = vscode.Uri.file(formModulePath);
    const ownerDoc = await vscode.workspace.openTextDocument(ownerUri);
    const formDoc = await vscode.workspace.openTextDocument(formUri);
    await vscode.window.showTextDocument(ownerDoc, { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.window.showTextDocument(formDoc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    return { ownerUri, formUri };
  }

  function countResetCallsFor(uris: readonly vscode.Uri[]): { counts: Map<string, number>; restore: () => void } {
    const counts = new Map<string, number>(uris.map((u) => [u.toString(), 0]));
    const originalExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = ((command: string, ...rest: unknown[]) => {
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
      if (command === 'workbench.action.files.resetActiveEditorReadonlyInSession' && activeUri && counts.has(activeUri)) {
        counts.set(activeUri, (counts.get(activeUri) ?? 0) + 1);
      }
      return (originalExecuteCommand as (c: string, ...r: unknown[]) => Thenable<unknown>)(command, ...rest);
    }) as typeof vscode.commands.executeCommand;
    return { counts, restore: () => { (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = originalExecuteCommand; } };
  }

  test('событие с единицей-формой (Справочник.Тест.Форма.Форма) — обработана только вкладка формы', async function () {
    this.timeout(10_000);
    const { ownerUri, formUri } = await openBothVisible();
    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const disposable = controller.register();
    const spy = countResetCallsFor([ownerUri, formUri]);
    try {
      assert.ok(listener);
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.Тест.Форма.Форма'], allObjects: ['Справочник.Тест.Форма.Форма'] });
      await waitUntil(() => (spy.counts.get(formUri.toString()) ?? 0) >= 1, 3000);
      assert.strictEqual(spy.counts.get(formUri.toString()), 1);
      assert.strictEqual(spy.counts.get(ownerUri.toString()) ?? 0, 0, 'Файл владельца НЕ должен обрабатываться — событие затронуло только форму.');
    } finally {
      spy.restore();
      disposable.dispose();
    }
  });

  test('событие с владельцем (Справочник.Тест) — обработаны обе вкладки: владелец И подчинённая форма', async function () {
    this.timeout(10_000);
    const { ownerUri, formUri } = await openBothVisible();
    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => false,
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const guard = new BslReadonlyGuard(supportService, repositoryService, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, { appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const disposable = controller.register();
    const spy = countResetCallsFor([ownerUri, formUri]);
    try {
      assert.ok(listener);
      listener({ target: { configRoot: tmpDir }, fullNames: ['Справочник.Тест'], allObjects: ['Справочник.Тест'] });
      await waitUntil(() => (spy.counts.get(ownerUri.toString()) ?? 0) >= 1 && (spy.counts.get(formUri.toString()) ?? 0) >= 1, 3000);
      assert.strictEqual(spy.counts.get(ownerUri.toString()), 1);
      assert.strictEqual(spy.counts.get(formUri.toString()), 1, 'Форма — подчинённая единица владельца, событие владельца должно затронуть и её.');
    } finally {
      spy.restore();
      disposable.dispose();
    }
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

/**
 * Issue #63 — файл проекта открыт только левой стороной сравнения (keep-local:
 * «файл проекта ↔ копия хранилища»). Readonly-команды VS Code действуют лишь на правую
 * сторону активного сравнения, поэтому контроллер временно открывает файл обычной
 * вкладкой, применяет команду и закрывает её, оставляя сравнение. Копия хранилища
 * лежит вне configRoot и переходов не получает.
 */
suite('EditorReadonlyController — файл проекта слева в сравнении (issue #63)', () => {
  let configRoot: string;
  let copyDir: string;
  let projectUri: vscode.Uri;
  let copyUri: vscode.Uri;
  let spy: ReadonlyCommandSpy | undefined;
  let disposable: vscode.Disposable | undefined;
  let settle: (() => Promise<void>) | undefined;

  setup(() => {
    configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-readonly-left-'));
    copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-readonly-left-copy-'));
    const projectPath = path.join(configRoot, 'ObjectModule.bsl');
    const copyPath = path.join(copyDir, 'ObjectModule.bsl');
    fs.writeFileSync(projectPath, 'Процедура Проект()\nКонецПроцедуры\n', 'utf-8');
    fs.writeFileSync(copyPath, 'Процедура Копия()\nКонецПроцедуры\n', 'utf-8');
    projectUri = vscode.Uri.file(projectPath);
    copyUri = vscode.Uri.file(copyPath);
  });

  teardown(async () => {
    // Очередь контроллера дорабатывает и после выполнения условий теста: без ожидания её
    // повторное открытие сравнения попало бы во вкладки следующего теста.
    await settle?.();
    settle = undefined;
    spy?.restore();
    spy = undefined;
    disposable?.dispose();
    disposable = undefined;
    await revertDirtyAndCloseAll();
    fs.rmSync(configRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(copyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  interface Started {
    fire: () => void;
    /** Дождаться окончания всех переходов очереди контроллера. */
    settle: () => Promise<void>;
    forgetCalls: string[];
    logLines: string[];
  }

  function start(restricted: boolean): Started {
    let listener: ChangeLocksListener | undefined;
    const repositoryService = fakeRepositoryService({
      isEditRestricted: () => restricted,
      onDidChangeLocks: (l: ChangeLocksListener) => { listener = l; return { dispose: () => { listener = undefined; } }; },
    });
    const supportService = fakeSupportService(() => false);
    const logLines: string[] = [];
    const log = { appendLine: (line: string) => { logLines.push(line); } } as unknown as vscode.OutputChannel;
    const guard = new BslReadonlyGuard(supportService, repositoryService, log);
    const forgetCalls: string[] = [];
    guard.forget = (uri: vscode.Uri) => { forgetCalls.push(uri.toString()); };
    const controller = new EditorReadonlyController(repositoryService, supportService, guard, log);
    disposable = controller.register();
    // Сигнала завершения у контроллера нет (публичный API не расширяется ради тестов),
    // поэтому ожидается его внутренняя очередь — единственная точка, где переходы
    // гарантированно закончились.
    // Переименование поля не должно тихо превратить ожидание в no-op и сделать тест гоночным.
    settle = () => {
      const queue = (controller as unknown as { queue: unknown }).queue;
      assert.ok(queue instanceof Promise, 'У EditorReadonlyController нет внутренней очереди queue.');
      return queue as Promise<void>;
    };
    spy = spyReadonlyCommands();
    return {
      settle,
      fire: () => { listener?.({ target: { configRoot }, fullNames: ['Справочник.Товары'], allObjects: ['Справочник.Товары'] }); },
      forgetCalls,
      logLines,
    };
  }

  async function openDiff(viewColumn: vscode.ViewColumn = vscode.ViewColumn.One): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', projectUri, copyUri, 'ObjectModule.bsl (мои изменения: файл проекта ↔ хранилище: копия)', { preview: false, viewColumn });
    // Модель вкладок и видимых редакторов хоста расширений обновляется асинхронно.
    await waitFor(() => isActiveDiff(projectUri, copyUri, viewColumn) && isVisible(copyUri));
  }

  function isVisible(uri: vscode.Uri): boolean {
    return vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === uri.toString());
  }

  async function showText(uri: vscode.Uri, viewColumn: vscode.ViewColumn): Promise<void> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false, viewColumn });
    await waitFor(() => {
      const group = vscode.window.tabGroups.activeTabGroup;
      const input = group.activeTab?.input;
      return group.viewColumn === viewColumn && input instanceof vscode.TabInputText && input.uri.toString() === uri.toString() && isVisible(uri);
    });
  }

  function commandsOnProject(command: string): number {
    return (spy?.calls ?? []).filter((call) => call.command === command && call.activeUri === projectUri.toString()).length;
  }

  for (const restricted of [false, true]) {
    test(`видимое сравнение, restricted=${String(restricted)} → ${restricted ? 'set' : 'reset'} при активном файле проекта, временной вкладки нет, сравнение активно`, async function () {
      this.timeout(15_000);
      await openDiff();
      const started = start(restricted);

      started.fire();
      await started.settle();
      await waitFor(() => textTabsOf(projectUri).length === 0 && isActiveDiff(projectUri, copyUri)).catch((error: unknown) => {
        throw new Error(`${String(error)}: ${describeTabs({ calls: spy?.calls, log: started.logLines })}`);
      });

      assert.deepStrictEqual(spy?.calls, [{ command: restricted ? SET_COMMAND : RESET_COMMAND, activeUri: projectUri.toString() }]);
      assert.deepStrictEqual(started.forgetCalls, restricted ? [] : [projectUri.toString()]);
      assert.strictEqual(diffTabs().length, 1);
      assert.ok(!spy.calls.some((call) => call.activeUri === copyUri.toString()), 'копия хранилища не должна быть активной при readonly-команде');
    });
  }

  test('скрытое сравнение → переход применяется сразу, без активации пользователем; активная вкладка группы — прежняя', async function () {
    this.timeout(15_000);
    await openDiff();
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-readonly-left-other-'));
    try {
      const otherUri = vscode.Uri.file(path.join(otherDir, 'Другой.bsl'));
      fs.writeFileSync(otherUri.fsPath, 'другой', 'utf-8');
      await showText(otherUri, vscode.ViewColumn.One);
      const started = start(false);

      started.fire();
      await started.settle();
      await waitFor(() => textTabsOf(projectUri).length === 0);

      assert.strictEqual(commandsOnProject(RESET_COMMAND), 1, describeTabs({ calls: spy?.calls, log: started.logLines, commands: spy?.commands }));
      const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(activeInput instanceof vscode.TabInputText && activeInput.uri.toString() === otherUri.toString());
      assert.strictEqual(diffTabs().length, 1);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('файл проекта в видимой обычной вкладке (колонка 2) и слева в сравнении (колонка 1) → используется обычная, вторая не создаётся', async function () {
    this.timeout(15_000);
    await openDiff(vscode.ViewColumn.One);
    await showText(projectUri, vscode.ViewColumn.Two);
    const started = start(false);

    started.fire();
    await started.settle();

    assert.strictEqual(commandsOnProject(RESET_COMMAND), 1);
    assert.strictEqual(textTabsOf(projectUri).length, 1);
    assert.strictEqual(textTabsOf(projectUri)[0].group.viewColumn, vscode.ViewColumn.Two);
  });

  test('файл проекта в скрытой обычной вкладке той же группы и слева в видимом сравнении → обычная вкладка не закрывается, сравнение снова активно', async function () {
    this.timeout(15_000);
    await showText(projectUri, vscode.ViewColumn.One);
    await openDiff(vscode.ViewColumn.One);
    const started = start(false);

    started.fire();
    await started.settle();
    await waitFor(() => isActiveDiff(projectUri, copyUri));

    assert.strictEqual(commandsOnProject(RESET_COMMAND), 1);
    assert.strictEqual(textTabsOf(projectUri).length, 1, 'существовавшая до перехода обычная вкладка должна остаться');
  });

  test('несохранённые правки слева → команда выполнена, временная вкладка оставлена, запись в журнале', async function () {
    this.timeout(15_000);
    await openDiff();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(projectUri, new vscode.Position(0, 0), '// правка\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const started = start(false);

    started.fire();
    await started.settle();
    await waitFor(() => isActiveDiff(projectUri, copyUri));

    assert.strictEqual(commandsOnProject(RESET_COMMAND), 1);
    assert.strictEqual(textTabsOf(projectUri).length, 1);
    assert.ok(started.logLines.includes('[readonly] временная вкладка оставлена (несохранённые изменения): ObjectModule.bsl'));
  });

  test('восстановление: активно сравнение в колонке 1, событие про файл в колонке 2 → снова активно то же сравнение, обычной вкладки копии нет', async function () {
    this.timeout(15_000);
    const backupUri = vscode.Uri.file(path.join(copyDir, 'Backup.bsl'));
    fs.writeFileSync(backupUri.fsPath, 'резервная копия', 'utf-8');
    await vscode.commands.executeCommand('vscode.diff', backupUri, copyUri, 'копии', { preview: false, viewColumn: vscode.ViewColumn.One });
    await showText(projectUri, vscode.ViewColumn.Two);
    await vscode.commands.executeCommand('vscode.diff', backupUri, copyUri, 'копии', { preview: false, viewColumn: vscode.ViewColumn.One });
    // Предпосылка: активно сравнение в колонке 1 (модель вкладок хоста обновляется асинхронно).
    await waitFor(() => isActiveDiff(backupUri, copyUri, vscode.ViewColumn.One) && isVisible(copyUri) && isVisible(projectUri));
    const started = start(false);

    started.fire();
    await started.settle();
    await waitFor(() => isActiveDiff(backupUri, copyUri, vscode.ViewColumn.One));

    assert.strictEqual(commandsOnProject(RESET_COMMAND), 1);
    assert.strictEqual(textTabsOf(copyUri).length, 0);
  });
});
