import * as vscode from 'vscode';

/**
 * Общая обвязка интеграционных тестов readonly-переходов: шпион readonly-команд
 * сессии (фиксирует активный документ в момент вызова — именно к нему VS Code
 * применяет команду) и выборки по реальным вкладкам `tabGroups`.
 */

export const SET_COMMAND = 'workbench.action.files.setActiveEditorReadonlyInSession';
export const RESET_COMMAND = 'workbench.action.files.resetActiveEditorReadonlyInSession';

export interface ReadonlyCommandCall {
  command: string;
  activeUri: string;
}

export interface ReadonlyCommandSpy {
  calls: ReadonlyCommandCall[];
  commands: string[];
  restore(): void;
}

type ExecuteCommand = (command: string, ...rest: unknown[]) => Thenable<unknown>;

/** Делегирует оригиналу: вкладки открываются по-настоящему, шпион только наблюдает. */
export function spyReadonlyCommands(): ReadonlyCommandSpy {
  const calls: ReadonlyCommandCall[] = [];
  const commands: string[] = [];
  const original = vscode.commands.executeCommand;
  (vscode.commands as { executeCommand: ExecuteCommand }).executeCommand = (command: string, ...rest: unknown[]) => {
    commands.push(command);
    if (command.endsWith('ReadonlyInSession')) {
      calls.push({ command, activeUri: vscode.window.activeTextEditor?.document.uri.toString() ?? '<none>' });
    }
    return (original as ExecuteCommand)(command, ...rest);
  };
  return {
    calls,
    commands,
    restore: () => { (vscode.commands as { executeCommand: typeof original }).executeCommand = original; },
  };
}

export function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => [...group.tabs]);
}

export function textTabsOf(uri: vscode.Uri): vscode.Tab[] {
  return allTabs().filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
}

export function diffTabs(): { tab: vscode.Tab; input: vscode.TabInputTextDiff }[] {
  return allTabs().flatMap((tab) => (tab.input instanceof vscode.TabInputTextDiff ? [{ tab, input: tab.input }] : []));
}

/** Активная вкладка активной группы — сравнение с указанными сторонами. */
export function isActiveDiff(original: vscode.Uri, modified: vscode.Uri, viewColumn?: vscode.ViewColumn): boolean {
  const group = vscode.window.tabGroups.activeTabGroup;
  const input = group.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff
    && input.original.toString() === original.toString()
    && input.modified.toString() === modified.toString()
    && (viewColumn === undefined || group.viewColumn === viewColumn);
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Условие не выполнено за отведённое время ожидания');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Несохранённые правки откатываются до закрытия вкладок, иначе закрытие спросит о сохранении. */
export async function revertDirtyAndCloseAll(): Promise<void> {
  for (const document of vscode.workspace.textDocuments.filter((doc) => doc.isDirty)) {
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Снимок вкладок для сообщений об ошибках: без него падение по ожиданию не объяснить. */
export function describeTabs(extra: Record<string, unknown> = {}): string {
  const groups = vscode.window.tabGroups.all.map((group) => ({
    column: group.viewColumn,
    active: group.isActive,
    tabs: group.tabs.map((tab) => ({ label: tab.label, active: tab.isActive, diff: tab.input instanceof vscode.TabInputTextDiff })),
  }));
  return JSON.stringify({ groups, activeEditor: vscode.window.activeTextEditor?.document.uri.fsPath, ...extra });
}
