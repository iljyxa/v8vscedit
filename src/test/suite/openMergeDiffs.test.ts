import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { openMergeDiffs, type MergeDiffPair } from '../../ui/commands/repository/RepositoryFileSyncDialogs';
import {
  diffTabs,
  isActiveDiff,
  RESET_COMMAND,
  revertDirtyAndCloseAll,
  SET_COMMAND,
  spyReadonlyCommands,
  textTabsOf,
  type ReadonlyCommandSpy,
} from './support/editorTabsHarness';

/**
 * Issues #63, #78 — `openMergeDiffs` в реальном Extension Host: слева локальное состояние,
 * справа версия хранилища. Readonly-команды VS Code действуют только на правую сторону
 * активного сравнения, поэтому для файла проекта слева readonly переключается через
 * временную обычную вкладку, после чего сравнение снова активно. Незахваченный файл
 * проекта явно делается readonly, исход, отличный от применения, — в журнал.
 */
suite('RepositoryFileSyncDialogs — openMergeDiffs (issues #63, #78)', () => {
  let projectDir: string;
  let copyDir: string;
  let projectPath: string;
  let copyPath: string;
  let spy: ReadonlyCommandSpy | undefined;
  let logLines: string[];
  const log = (message: string): void => { logLines.push(message); };

  setup(() => {
    logLines = [];
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-diff-project-'));
    copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-diff-copy-'));
    projectPath = path.join(projectDir, 'ObjectModule.bsl');
    copyPath = path.join(copyDir, 'ObjectModule.bsl');
    fs.writeFileSync(projectPath, 'Процедура Проект()\nКонецПроцедуры\n', 'utf-8');
    fs.writeFileSync(copyPath, 'Процедура Копия()\nКонецПроцедуры\n', 'utf-8');
  });

  teardown(async () => {
    spy?.restore();
    spy = undefined;
    await revertDirtyAndCloseAll();
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(copyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('файл проекта слева, writable → reset при активном файле проекта, сравнение активно, лишней вкладки нет', async function () {
    this.timeout(15_000);
    const pair: MergeDiffPair = { title: 'ObjectModule.bsl (слева проект)', local: projectPath, repository: copyPath, projectSide: 'local', writable: true };
    const projectUri = vscode.Uri.file(projectPath);
    spy = spyReadonlyCommands();

    await openMergeDiffs([pair], log);

    assert.deepStrictEqual(spy.calls, [{ command: RESET_COMMAND, activeUri: projectUri.toString() }]);
    assert.ok(isActiveDiff(projectUri, vscode.Uri.file(copyPath)), 'активной должна остаться вкладка сравнения');
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, pair.title);
    assert.strictEqual(textTabsOf(projectUri).length, 0, 'временная обычная вкладка файла проекта должна быть закрыта');
  });

  test('файл проекта справа, writable → reset при активном файле проекта, слева резервная копия', async function () {
    this.timeout(15_000);
    const pair: MergeDiffPair = { title: 'ObjectModule.bsl (справа проект)', local: copyPath, repository: projectPath, projectSide: 'repository', writable: true };
    const projectUri = vscode.Uri.file(projectPath);
    spy = spyReadonlyCommands();

    await openMergeDiffs([pair], log);

    assert.deepStrictEqual(spy.calls, [{ command: RESET_COMMAND, activeUri: projectUri.toString() }]);
    assert.ok(isActiveDiff(vscode.Uri.file(copyPath), projectUri));
    assert.strictEqual(textTabsOf(projectUri).length, 0);
  });

  for (const projectSide of ['local', 'repository'] as const) {
    test(`writable=false, файл проекта ${projectSide === 'local' ? 'слева' : 'справа'} → set readonly при активном файле проекта, сравнение активно`, async function () {
      this.timeout(15_000);
      const local = projectSide === 'local' ? projectPath : copyPath;
      const repository = projectSide === 'local' ? copyPath : projectPath;
      const projectUri = vscode.Uri.file(projectPath);
      spy = spyReadonlyCommands();

      await openMergeDiffs([{ title: 'только чтение', local, repository, projectSide, writable: false }], log);

      assert.deepStrictEqual(spy.calls, [{ command: SET_COMMAND, activeUri: projectUri.toString() }]);
      assert.ok(isActiveDiff(vscode.Uri.file(local), vscode.Uri.file(repository)));
      assert.strictEqual(textTabsOf(projectUri).length, 0, 'временная обычная вкладка файла проекта должна быть закрыта');
      assert.deepStrictEqual(logLines, []);
    });
  }

  test('файл проекта слева с несохранёнными правками → reset, временная вкладка оставлена, исход в журнале', async function () {
    this.timeout(15_000);
    const projectUri = vscode.Uri.file(projectPath);
    // Несохранённый документ без собственной вкладки: закрытие временной вкладки
    // вызвало бы модальный вопрос о сохранении, поэтому она остаётся открытой.
    const document = await vscode.workspace.openTextDocument(projectUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(projectUri, new vscode.Position(0, 0), '// правка\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(document.isDirty);
    assert.strictEqual(textTabsOf(projectUri).length, 0);
    spy = spyReadonlyCommands();

    await openMergeDiffs([{ title: 'проект слева, правки', local: projectPath, repository: copyPath, projectSide: 'local', writable: true }], log);

    assert.deepStrictEqual(spy.calls, [{ command: RESET_COMMAND, activeUri: projectUri.toString() }]);
    assert.deepStrictEqual(logLines, ['[readonly] временная вкладка оставлена (несохранённые изменения): ObjectModule.bsl']);
    assert.strictEqual(textTabsOf(projectUri).length, 1);
    assert.ok(isActiveDiff(projectUri, vscode.Uri.file(copyPath)), 'активной должна остаться вкладка сравнения');
  });

  test('несколько пар → столько же вкладок сравнения', async function () {
    this.timeout(20_000);
    const secondProject = path.join(projectDir, 'ManagerModule.bsl');
    const secondCopy = path.join(copyDir, 'ManagerModule.bsl');
    fs.writeFileSync(secondProject, 'проект 2', 'utf-8');
    fs.writeFileSync(secondCopy, 'копия 2', 'utf-8');
    spy = spyReadonlyCommands();

    await openMergeDiffs([
      { title: 'первая', local: projectPath, repository: copyPath, projectSide: 'local', writable: true },
      { title: 'вторая', local: secondProject, repository: secondCopy, projectSide: 'local', writable: false },
    ], log);

    assert.deepStrictEqual(diffTabs().map((item) => item.tab.label).sort(), ['вторая', 'первая']);
    assert.deepStrictEqual(spy.calls.map((call) => call.command), [RESET_COMMAND, SET_COMMAND]);
  });
});
