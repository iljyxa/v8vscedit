import * as vscode from 'vscode';
import type { MergeChoice } from '../../../infra/repository/RepositoryMergeApplier';

/** Сводка конфликтов слияния для единственного модального диалога операции. */
export interface ConflictSummary {
  /** «Захват», «Получение» — для заголовка. */
  operationLabel: string;
  objectLabel: string;
  conflictCount: number;
  /** Пути конфликтных файлов относительно корня конфигурации (первые из списка). */
  files: string[];
}

/** Сводка расхождений файлов с версией хранилища при отмене захвата. */
export interface RollbackSummary {
  objectLabel: string;
  objectCount: number;
  changedCount: number;
  missingCount: number;
  extraCount: number;
  files: string[];
}

/**
 * Пара для окна сравнения: `left` — версия, из которой переносят правки,
 * `right` — файл проекта. `writable` — правую сторону можно редактировать
 * (объект захвачен, поддержка разрешает), значит readonly сессии снимается.
 */
export interface MergeDiffPair {
  title: string;
  left: string;
  right: string;
  writable: boolean;
}

export interface NotificationAction {
  label: string;
  run: () => void;
}

const COMPARE_CHOICE = 'Сравнить';
const REPLACE_CHOICE = 'Заменить';
const ROLLBACK_CHOICE = 'Откатить к версии хранилища';
const KEEP_CHOICE = 'Оставить изменения';
const MAX_LISTED_FILES = 10;

function listFiles(files: readonly string[]): string {
  const listed = files.slice(0, MAX_LISTED_FILES).join('\n');
  return files.length > MAX_LISTED_FILES ? `${listed}\n… и ещё ${String(files.length - MAX_LISTED_FILES)}` : listed;
}

/** Немодальное уведомление без ожидания закрытия (запрет №18) с необязательными кнопками. */
export function showNotification(
  show: (message: string, ...items: string[]) => Thenable<string | undefined>,
  message: string,
  actions: readonly NotificationAction[] = []
): void {
  void show(message, ...actions.map((action) => action.label)).then((picked) => {
    actions.find((action) => action.label === picked)?.run();
  });
}

/* c8 ignore start -- модальные диалоги и открытие вкладок сравнения vscode не автоматизируются
   в тестовом хосте (правило CLAUDE.md №4); решения потоков проверяются через внедрённые deps. */

/** Esc/закрытие диалога = `keep-local`: локальные правки не должны теряться без явного выбора. */
export async function chooseConflictResolutionModal(summary: ConflictSummary): Promise<MergeChoice> {
  const choice = await vscode.window.showWarningMessage(
    `${summary.operationLabel} «${summary.objectLabel}»: локально изменено файлов — ${String(summary.conflictCount)}, ` +
      'в хранилище для них другая версия.',
    {
      modal: true,
      detail:
        '«Сравнить» — записать версию хранилища, сохранить ваши правки в резервную копию и открыть сравнение для переноса. ' +
        '«Заменить» — записать версию хранилища (ваши правки останутся только в резервной копии). ' +
        `Закрыть окно — оставить локальные файлы без изменений.\n\n${listFiles(summary.files)}`,
    },
    COMPARE_CHOICE,
    REPLACE_CHOICE
  );
  if (choice === COMPARE_CHOICE) {
    return 'compare';
  }
  return choice === REPLACE_CHOICE ? 'replace' : 'keep-local';
}

/** Esc/закрытие диалога = оставить изменения. */
export async function confirmRollbackModal(summary: RollbackSummary): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Захват «${summary.objectLabel}» отменён, но файлы отличаются от версии хранилища ` +
      `(изменено: ${String(summary.changedCount)}, удалено: ${String(summary.missingCount)}, добавлено: ${String(summary.extraCount)}).`,
    {
      modal: true,
      detail:
        '«Откатить к версии хранилища» — вернуть файлы к версии хранилища (текущие попадут в резервную копию). ' +
        `«Оставить изменения» — файлы останутся как есть и будут помечены изменёнными.\n\n${listFiles(summary.files)}`,
    },
    ROLLBACK_CHOICE,
    KEEP_CHOICE
  );
  return choice === ROLLBACK_CHOICE;
}

export async function openMergeDiffs(pairs: MergeDiffPair[]): Promise<void> {
  for (const pair of pairs) {
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(pair.left),
      vscode.Uri.file(pair.right),
      pair.title,
      { preview: false }
    );
    if (pair.writable) {
      // Файл мог быть открыт как readonly до захвата — сессионный флаг снимается явно,
      // иначе перенести правки в правую сторону сравнения нельзя.
      await vscode.commands.executeCommand('workbench.action.files.resetActiveEditorReadonlyInSession');
    }
  }
}

export function isFileSyncOnLockUnlockEnabled(): boolean {
  return vscode.workspace.getConfiguration('v8vscedit.repository').get<boolean>('syncFilesOnLockUnlock', true);
}

/** Несохранённые редакторы: такой файл нельзя молча перезаписать версией хранилища. */
export function getDirtyEditorFilePaths(): string[] {
  return vscode.workspace.textDocuments
    .filter((document) => document.isDirty && document.uri.scheme === 'file')
    .map((document) => document.uri.fsPath);
}
/* c8 ignore stop */
