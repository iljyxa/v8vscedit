import * as path from 'path';
import * as vscode from 'vscode';
import { isRootLockName } from '../../infra/repository/RepositoryObjectNames';
import { resolveOwnerFullNameByRelativePath } from '../../infra/repository/RepositoryObjectScope';
import type { RepositoryLocksChangedNotice, RepositoryService, RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { BslReadonlyGuard } from './BslReadonlyGuard';
import { planReadonlyTransitions, type ReadonlyTransition } from './readonlyTransitionPlan';

const SET_READONLY_COMMAND = 'workbench.action.files.setActiveEditorReadonlyInSession';
// reset (а не «сделать редактируемым») уважает files.readonlyInclude пользователя.
const RESET_READONLY_COMMAND = 'workbench.action.files.resetActiveEditorReadonlyInSession';

/**
 * Файлы вне конкретных объектов (корень, нераспознанные) пересчитываются на любое
 * событие цели: их состояние зависит от захвата корня, а событие рекурсивного корня
 * не перечисляет затронутые объекты.
 */
const TARGET_WIDE_OWNER = '\u0000target';

interface OpenTab {
  path: string;
  uri: vscode.Uri;
  visible: boolean;
  /** Вкладка сравнения, где файл — правая (изменяемая) сторона. */
  diff?: { original: vscode.Uri; label: string; viewColumn: vscode.ViewColumn };
  viewColumn?: vscode.ViewColumn;
}

/**
 * Переводит уже открытые вкладки файлов объектов в readonly/редактируемые после
 * захвата/отмены захвата без переоткрытия. Readonly в VS Code 1.85 ставится только
 * командой для активного редактора, поэтому видимые вкладки ненадолго активируются
 * (без кражи фокуса), а скрытые — ждут собственной активации.
 */
export class EditorReadonlyController {
  private readonly pending = new Map<string, boolean>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repositoryService: RepositoryService,
    private readonly supportService: SupportInfoService,
    private readonly bslReadonlyGuard: BslReadonlyGuard,
    private readonly log: vscode.OutputChannel
  ) {}

  register(): vscode.Disposable {
    const locks = this.repositoryService.onDidChangeLocks((event) => {
      this.enqueue(() => this.handleLocksChanged(event));
    });
    const active = vscode.window.onDidChangeActiveTextEditor((editor) => {
      const readonly = editor ? this.pending.get(editor.document.uri.toString()) : undefined;
      if (editor && readonly !== undefined) {
        this.pending.delete(editor.document.uri.toString());
        this.enqueue(() => this.applyToActive(editor.document.uri, readonly));
      }
    });
    const close = vscode.workspace.onDidCloseTextDocument((document) => {
      this.pending.delete(document.uri.toString());
    });
    return vscode.Disposable.from({ dispose: () => locks.dispose() }, active, close);
  }

  /** Переходы выполняются последовательно: каждый временно меняет активный редактор. */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.appendLine(`[readonly][error] ${message}`);
    });
  }

  private async handleLocksChanged(event: RepositoryLocksChangedNotice): Promise<void> {
    const tabs = collectOpenTabs();
    const touchesRoot = event.fullNames.some(isRootLockName);
    // Цель события известна только по корню; вид цели нужен лишь для имени корня,
    // а корень здесь всё равно сводится к TARGET_WIDE_OWNER.
    const target: RepositoryTarget = { configRoot: event.target.configRoot, configKind: 'cf', displayName: '' };
    const plan = planReadonlyTransitions({
      openFiles: tabs.map((tab) => ({ path: tab.path, visible: tab.visible })),
      changedOwnerFullNames: [...event.fullNames, TARGET_WIDE_OWNER],
      allObjects: event.allObjects,
      configRoot: event.target.configRoot,
      ownerOf: (filePath) => {
        if (touchesRoot) {
          return TARGET_WIDE_OWNER;
        }
        const owner = resolveOwnerFullNameByRelativePath(path.relative(event.target.configRoot, filePath), target);
        return owner === null || isRootLockName(owner) ? TARGET_WIDE_OWNER : owner;
      },
      isRestricted: (filePath) => this.supportService.isLocked(filePath) || this.repositoryService.isEditRestricted(filePath),
    });
    for (const transition of plan.defer) {
      const tab = findTab(tabs, transition.path);
      if (tab) {
        this.pending.set(tab.uri.toString(), transition.readonly);
      }
    }
    if (plan.applyNow.length === 0) {
      return;
    }
    const originalEditor = vscode.window.activeTextEditor;
    for (const transition of plan.applyNow) {
      const tab = findTab(tabs, transition.path);
      if (tab) {
        await this.applyToVisibleTab(tab, transition);
      }
    }
    if (originalEditor && vscode.window.activeTextEditor?.document !== originalEditor.document) {
      await vscode.window.showTextDocument(originalEditor.document, {
        viewColumn: originalEditor.viewColumn,
        preserveFocus: true,
      });
    }
  }

  private async applyToVisibleTab(tab: OpenTab, transition: ReadonlyTransition): Promise<void> {
    if (tab.diff) {
      await vscode.commands.executeCommand('vscode.diff', tab.diff.original, tab.uri, tab.diff.label, {
        viewColumn: tab.diff.viewColumn,
        preserveFocus: true,
      });
    } else {
      const document = await vscode.workspace.openTextDocument(tab.uri);
      await vscode.window.showTextDocument(document, { viewColumn: tab.viewColumn, preserveFocus: true });
    }
    await this.applyToActive(tab.uri, transition.readonly);
  }

  private async applyToActive(uri: vscode.Uri, readonly: boolean): Promise<void> {
    if (!readonly) {
      // Иначе после отмены захвата BslReadonlyGuard счёл бы readonly уже применённым.
      this.bslReadonlyGuard.forget(uri);
    }
    await vscode.commands.executeCommand(readonly ? SET_READONLY_COMMAND : RESET_READONLY_COMMAND);
    this.log.appendLine(`[readonly] ${readonly ? 'Только чтение' : 'Редактирование'}: ${path.basename(uri.fsPath)}`);
  }
}

function findTab(tabs: readonly OpenTab[], filePath: string): OpenTab | undefined {
  const key = path.resolve(filePath).toLowerCase();
  const matches = tabs.filter((tab) => path.resolve(tab.path).toLowerCase() === key);
  return matches.find((tab) => tab.visible) ?? matches[0];
}

/** Вкладки файлов (обычные и правая сторона сравнения) со схемой file. */
function collectOpenTabs(): OpenTab[] {
  const visibleUris = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));
  const result: OpenTab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText && input.uri.scheme === 'file') {
        result.push({
          path: input.uri.fsPath,
          uri: input.uri,
          visible: tab.isActive && visibleUris.has(input.uri.toString()),
          viewColumn: group.viewColumn,
        });
      } else if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'file') {
        result.push({
          path: input.modified.fsPath,
          uri: input.modified,
          visible: tab.isActive && visibleUris.has(input.modified.toString()),
          diff: { original: input.original, label: tab.label, viewColumn: group.viewColumn },
        });
      }
    }
  }
  return result;
}
