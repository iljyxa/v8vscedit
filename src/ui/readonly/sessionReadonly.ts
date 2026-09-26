import * as path from 'path';
import * as vscode from 'vscode';
import type { ReadonlyApplyRoute, ReadonlyTabCandidate } from './readonlyTabSelection';

export const SET_READONLY_COMMAND = 'workbench.action.files.setActiveEditorReadonlyInSession';
// reset (а не «сделать редактируемым») уважает files.readonlyInclude пользователя.
export const RESET_READONLY_COMMAND = 'workbench.action.files.resetActiveEditorReadonlyInSession';

export interface OpenTab extends ReadonlyTabCandidate {
  uri: vscode.Uri;
  /** Для обеих сторон сравнения — данные, чтобы открыть это сравнение заново. */
  diff?: { original: vscode.Uri; modified: vscode.Uri; label: string };
}

/** `applied-kept-temporary` — временная вкладка оставлена открытой из-за несохранённых правок. */
export type ResourceActivationOutcome = 'applied' | 'applied-kept-temporary' | 'skipped';

/**
 * Вкладки файлов со схемой file: обычные и обе стороны сравнения. Левая сторона видима
 * вместе со сравнением — `visibleTextEditors` для сравнения содержит правую сторону.
 */
export function collectOpenTabs(): OpenTab[] {
  const visibleUris = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));
  const result: OpenTab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText && input.uri.scheme === 'file') {
        result.push({
          path: input.uri.fsPath,
          uri: input.uri,
          role: 'text',
          visible: tab.isActive && visibleUris.has(input.uri.toString()),
          viewColumn: group.viewColumn,
        });
      } else if (input instanceof vscode.TabInputTextDiff) {
        const visible = tab.isActive && visibleUris.has(input.modified.toString());
        const diff = { original: input.original, modified: input.modified, label: tab.label };
        for (const [uri, role] of [[input.modified, 'diff-modified'], [input.original, 'diff-original']] as const) {
          if (uri.scheme === 'file') {
            result.push({ path: uri.fsPath, uri, role, visible, viewColumn: group.viewColumn, diff });
          }
        }
      }
    }
  }
  return result;
}

/**
 * Делает ресурс активным редактором и выполняет `apply` (readonly-команду сессии —
 * она действует только на основную сторону активного редактора). Файл, открытый лишь
 * левой стороной сравнения, открывается временной обычной вкладкой: readonly хранится
 * по ресурсу, и сравнение подхватывает его для своей левой стороны.
 */
export async function runWithResourceActive(
  route: ReadonlyApplyRoute<OpenTab> | undefined,
  uri: vscode.Uri,
  apply: () => Promise<unknown>
): Promise<ResourceActivationOutcome> {
  if (!route || route.kind === 'defer') {
    return 'skipped';
  }
  if (route.kind === 'temporary') {
    return runInTemporaryTab(route.tab, uri, apply);
  }
  await activateTab(route.tab);
  return applyIfActive(uri, apply);
}

async function activateTab(tab: OpenTab): Promise<void> {
  if (tab.diff) {
    await vscode.commands.executeCommand('vscode.diff', tab.diff.original, tab.diff.modified, tab.diff.label, {
      viewColumn: tab.viewColumn,
    });
    return;
  }
  const document = await vscode.workspace.openTextDocument(tab.uri);
  await vscode.window.showTextDocument(document, { viewColumn: tab.viewColumn });
}

/** Команда для чужого активного редактора переключила бы readonly не того файла. */
async function applyIfActive(uri: vscode.Uri, apply: () => Promise<unknown>): Promise<'applied' | 'skipped'> {
  if (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) {
    return 'skipped';
  }
  await apply();
  return 'applied';
}

async function runInTemporaryTab(
  tab: OpenTab,
  uri: vscode.Uri,
  apply: () => Promise<unknown>
): Promise<ResourceActivationOutcome> {
  // Проверяется непосредственно перед открытием: уже существующую обычную вкладку
  // пользователя закрывать нельзя.
  const createsTab = findTextTab(tab.viewColumn, tab.uri) === undefined;
  const document = await vscode.workspace.openTextDocument(tab.uri);
  await vscode.window.showTextDocument(document, { viewColumn: tab.viewColumn, preview: false });
  const applied = await applyIfActive(uri, apply);
  const keptTemporary = createsTab && !(await closeUnlessDirty(tab, document));
  if (tab.visible && tab.diff) {
    await vscode.commands.executeCommand('vscode.diff', tab.diff.original, tab.diff.modified, tab.diff.label, {
      viewColumn: tab.viewColumn,
    });
  }
  return applied === 'applied' && keptTemporary ? 'applied-kept-temporary' : applied;
}

/** Закрытие несохранённого документа вызвало бы модальный вопрос о сохранении. */
async function closeUnlessDirty(tab: OpenTab, document: vscode.TextDocument): Promise<boolean> {
  if (document.isDirty) {
    return false;
  }
  const opened = findTextTab(tab.viewColumn, tab.uri);
  if (opened) {
    await vscode.window.tabGroups.close(opened, true);
  }
  return true;
}

function findTextTab(viewColumn: number, uri: vscode.Uri): vscode.Tab | undefined {
  const group = vscode.window.tabGroups.all.find((candidate) => {
    // ViewColumn — числовой enum; колонка кандидата хранится числом, чтобы планировщик не знал о vscode.
    const column: number = candidate.viewColumn;
    return column === viewColumn;
  });
  return group?.tabs.find((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
}

/** Строка журнала для исхода, отличного от обычного применения. */
export function describeActivationOutcome(outcome: ResourceActivationOutcome, uri: vscode.Uri): string | undefined {
  const name = path.basename(uri.fsPath);
  if (outcome === 'skipped') {
    return `[readonly][skip] активен не ${name}`;
  }
  return outcome === 'applied-kept-temporary' ? `[readonly] временная вкладка оставлена (несохранённые изменения): ${name}` : undefined;
}
