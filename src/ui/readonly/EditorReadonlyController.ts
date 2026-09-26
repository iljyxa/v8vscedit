import * as path from 'path';
import * as vscode from 'vscode';
import { getRepositoryUnitAncestors, isRootLockName } from '../../infra/repository/RepositoryObjectNames';
import { resolveLockUnitByRelativePath } from '../../infra/repository/RepositoryObjectScope';
import type { RepositoryLocksChangedNotice, RepositoryService, RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { BslReadonlyGuard } from './BslReadonlyGuard';
import { isImmediatelyApplicable, selectReadonlyApplyRoute } from './readonlyTabSelection';
import { planReadonlyTransitions, type ReadonlyTransition } from './readonlyTransitionPlan';
import {
  collectOpenTabs,
  describeActivationOutcome,
  RESET_READONLY_COMMAND,
  runWithResourceActive,
  SET_READONLY_COMMAND,
  type OpenTab,
} from './sessionReadonly';

/**
 * Файлы вне конкретных объектов (корень, нераспознанные) пересчитываются на любое
 * событие цели: их состояние зависит от захвата корня, а событие рекурсивного корня
 * не перечисляет затронутые объекты.
 */
const TARGET_WIDE_OWNER = '\u0000target';

/**
 * Переводит уже открытые вкладки файлов объектов в readonly/редактируемые после
 * захвата/отмены захвата без переоткрытия. Readonly в VS Code 1.85 ставится только
 * командой для активного редактора, поэтому видимые вкладки ненадолго активируются
 * (фокус затем возвращается исходному редактору), а скрытые — ждут собственной активации.
 * Файл, открытый только левой стороной сравнения, переключается сразу через временную
 * обычную вкладку: событие активации сравнения приходит по правой стороне.
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
    const locks = this.repositoryService.onDidChangeLocks((event) => { this.onLocksChanged(event); });
    const active = vscode.window.onDidChangeActiveTextEditor((editor) => { this.onActiveEditorChanged(editor); });
    const close = vscode.workspace.onDidCloseTextDocument((document) => { this.onDocumentClosed(document); });
    return vscode.Disposable.from({ dispose: () => locks.dispose() }, active, close);
  }

  /**
   * Применяет отложенный переход скрытой вкладки при её активации. Идемпотентен:
   * запись снимается при первом применении, повторный вызов ничего не делает.
   */
  onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      return;
    }
    const key = editor.document.uri.toString();
    const readonly = this.pending.get(key);
    if (readonly === undefined) {
      return;
    }
    this.pending.delete(key);
    // Вкладка уже активна: команда readonly действует на активный редактор, поэтому
    // применяется сразу — ожидание очереди дало бы другому переходу сменить активный
    // редактор. Последующие переходы очереди всё равно дождутся этого.
    this.track(Promise.all([this.queue, this.applyToActive(editor.document.uri, readonly)]).then(() => undefined));
  }

  /** Закрытая вкладка больше не ждёт перехода. */
  onDocumentClosed(document: vscode.TextDocument): void {
    this.pending.delete(document.uri.toString());
  }

  /** Переходы выполняются последовательно: каждый временно меняет активный редактор. */
  private enqueue(task: () => Promise<void>): void {
    this.track(this.queue.then(task));
  }

  private track(operation: Promise<void>): void {
    this.queue = operation.catch((error: unknown) => { this.logError(error); });
  }

  private logError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.appendLine(`[readonly][error] ${message}`);
  }

  /**
   * Отложенные переходы скрытых вкладок фиксируются сразу — вкладку могут активировать
   * или закрыть раньше, чем до события дойдёт очередь; активация видимых — в очереди.
   */
  private onLocksChanged(event: RepositoryLocksChangedNotice): void {
    let planned: { tabs: OpenTab[]; applyNow: ReadonlyTransition[] };
    try {
      planned = this.planTransitions(event);
    } catch (error) {
      this.logError(error);
      return;
    }
    if (planned.applyNow.length > 0) {
      this.enqueue(() => this.applyToVisibleTabs(planned.tabs, planned.applyNow));
    }
  }

  private planTransitions(event: RepositoryLocksChangedNotice): { tabs: OpenTab[]; applyNow: ReadonlyTransition[] } {
    const tabs = collectOpenTabs();
    const touchesRoot = event.fullNames.some(isRootLockName);
    // Цель события известна только по корню; вид цели нужен лишь для имени корня,
    // а корень здесь всё равно сводится к TARGET_WIDE_OWNER.
    const target: RepositoryTarget = { configRoot: event.target.configRoot, configKind: 'cf', displayName: '' };
    const plan = planReadonlyTransitions({
      openFiles: tabs.map((tab) => ({ path: tab.path, visible: isImmediatelyApplicable(tab) })),
      changedOwnerFullNames: [...event.fullNames, TARGET_WIDE_OWNER],
      allObjects: event.allObjects,
      configRoot: event.target.configRoot,
      ownerChainOf: (filePath) => {
        if (touchesRoot) {
          return [TARGET_WIDE_OWNER];
        }
        const unit = resolveLockUnitByRelativePath(path.relative(event.target.configRoot, filePath), target);
        return unit === null || isRootLockName(unit) ? [TARGET_WIDE_OWNER] : [unit, ...getRepositoryUnitAncestors(unit)];
      },
      isRestricted: (filePath) => this.supportService.isLocked(filePath) || this.repositoryService.isEditRestricted(filePath),
    });
    for (const transition of plan.defer) {
      const route = selectReadonlyApplyRoute(tabs, transition.path);
      if (route?.kind === 'defer') {
        this.pending.set(route.tab.uri.toString(), transition.readonly);
      }
    }
    return { tabs, applyNow: plan.applyNow };
  }

  private async applyToVisibleTabs(tabs: readonly OpenTab[], transitions: readonly ReadonlyTransition[]): Promise<void> {
    const originalEditor = vscode.window.activeTextEditor;
    const originalGroup = vscode.window.tabGroups.activeTabGroup;
    const originalTab = originalGroup.activeTab;
    const originalColumn = originalGroup.viewColumn;
    for (const transition of transitions) {
      const route = selectReadonlyApplyRoute(tabs, transition.path);
      if (route) {
        const uri = route.tab.uri;
        const outcome = await runWithResourceActive(route, uri, () => this.applyToActive(uri, transition.readonly));
        const note = describeActivationOutcome(outcome, uri);
        if (note) {
          this.log.appendLine(note);
        }
      }
    }
    await restoreActiveEditor(originalTab, originalColumn, originalEditor);
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

/**
 * Фокус возвращается исходному редактору. Сравнение открывается заново как сравнение:
 * `showTextDocument` его правой стороны создал бы лишнюю обычную вкладку.
 */
async function restoreActiveEditor(
  originalTab: vscode.Tab | undefined,
  originalColumn: vscode.ViewColumn,
  originalEditor: vscode.TextEditor | undefined
): Promise<void> {
  const input = originalTab?.input;
  if (input instanceof vscode.TabInputTextDiff) {
    if (!isActiveDiff(input, originalColumn)) {
      await vscode.commands.executeCommand('vscode.diff', input.original, input.modified, originalTab?.label, {
        viewColumn: originalColumn,
      });
    }
    return;
  }
  if (originalEditor && vscode.window.activeTextEditor?.document !== originalEditor.document) {
    await vscode.window.showTextDocument(originalEditor.document, { viewColumn: originalEditor.viewColumn });
  }
}

function isActiveDiff(diff: vscode.TabInputTextDiff, viewColumn: vscode.ViewColumn): boolean {
  const group = vscode.window.tabGroups.activeTabGroup;
  const input = group.activeTab?.input;
  return group.viewColumn === viewColumn
    && input instanceof vscode.TabInputTextDiff
    && input.original.toString() === diff.original.toString()
    && input.modified.toString() === diff.modified.toString();
}
