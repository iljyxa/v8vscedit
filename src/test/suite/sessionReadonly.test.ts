import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { selectReadonlyApplyRoute } from '../../ui/readonly/readonlyTabSelection';
import { collectOpenTabs, describeActivationOutcome, runWithResourceActive } from '../../ui/readonly/sessionReadonly';
import { revertDirtyAndCloseAll } from './support/editorTabsHarness';

/**
 * Issue #63 — адаптер `sessionReadonly` на реальных вкладках Extension Host:
 * сбор вкладок с ролями сторон сравнения и защитные ветки активации ресурса
 * (readonly-команда не должна выполниться для чужого активного редактора).
 */
suite('sessionReadonly — collectOpenTabs/runWithResourceActive (issue #63)', () => {
  let dir: string;
  let fileA: string;
  let fileB: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-session-readonly-'));
    fileA = path.join(dir, 'А.bsl');
    fileB = path.join(dir, 'Б.bsl');
    fs.writeFileSync(fileA, 'А', 'utf-8');
    fs.writeFileSync(fileB, 'Б', 'utf-8');
  });

  teardown(async () => {
    await revertDirtyAndCloseAll();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('collectOpenTabs: сравнение файлов даёт обе стороны с общей видимостью и колонкой, обычная вкладка — роль text', async function () {
    this.timeout(10_000);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileB), { preview: false });
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(fileA), vscode.Uri.file(fileB), 'А ↔ Б', { preview: false });

    const tabs = collectOpenTabs().map((tab) => ({ path: tab.path, role: tab.role, visible: tab.visible, viewColumn: tab.viewColumn, label: tab.diff?.label }));

    assert.deepStrictEqual(tabs, [
      { path: fileB, role: 'text', visible: false, viewColumn: 1, label: undefined },
      { path: fileB, role: 'diff-modified', visible: true, viewColumn: 1, label: 'А ↔ Б' },
      { path: fileA, role: 'diff-original', visible: true, viewColumn: 1, label: 'А ↔ Б' },
    ]);
  });

  test('collectOpenTabs: левая сторона не из файловой системы в список не попадает', async function () {
    this.timeout(10_000);
    const untitled = await vscode.workspace.openTextDocument({ content: 'без файла' });
    await vscode.commands.executeCommand('vscode.diff', untitled.uri, vscode.Uri.file(fileB), 'untitled ↔ Б', { preview: false });

    const tabs = collectOpenTabs().filter((tab) => tab.diff);

    assert.deepStrictEqual(tabs.map((tab) => tab.role), ['diff-modified']);
  });

  test('маршрута нет → skipped, действие не выполняется', async () => {
    let applied = 0;
    const outcome = await runWithResourceActive(undefined, vscode.Uri.file(fileA), () => { applied += 1; return Promise.resolve(); });
    assert.strictEqual(outcome, 'skipped');
    assert.strictEqual(applied, 0);
  });

  test('defer (скрытая вкладка) → skipped, вкладка не активируется', async function () {
    this.timeout(10_000);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileA), { preview: false });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileB), { preview: false });
    const route = selectReadonlyApplyRoute(collectOpenTabs(), fileA);
    assert.strictEqual(route?.kind, 'defer');
    let applied = 0;

    const outcome = await runWithResourceActive(route, vscode.Uri.file(fileA), () => { applied += 1; return Promise.resolve(); });

    assert.strictEqual(outcome, 'skipped');
    assert.strictEqual(applied, 0);
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, fileB);
  });

  test('после активации активен не целевой ресурс → skipped, действие не выполняется', async function () {
    this.timeout(10_000);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileA), { preview: false });
    const route = selectReadonlyApplyRoute(collectOpenTabs(), fileA);
    let applied = 0;

    // Маршрут ведёт к вкладке А, а целевой ресурс — Б: после активации активен А.
    const outcome = await runWithResourceActive(route, vscode.Uri.file(fileB), () => { applied += 1; return Promise.resolve(); });

    assert.strictEqual(outcome, 'skipped');
    assert.strictEqual(applied, 0);
  });

  test('describeActivationOutcome: обычное применение без записи, остальные исходы — строка журнала', () => {
    const uri = vscode.Uri.file(fileA);
    assert.strictEqual(describeActivationOutcome('applied', uri), undefined);
    assert.strictEqual(describeActivationOutcome('skipped', uri), '[readonly][skip] активен не А.bsl');
    assert.strictEqual(describeActivationOutcome('applied-kept-temporary', uri), '[readonly] временная вкладка оставлена (несохранённые изменения): А.bsl');
  });
});
