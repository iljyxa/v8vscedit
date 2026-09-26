import * as path from 'path';
import * as vscode from 'vscode';
import { selectReadonlyApplyRoute } from '../../readonly/readonlyTabSelection';
import { collectOpenTabs, RESET_READONLY_COMMAND, runWithResourceActive } from '../../readonly/sessionReadonly';
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

/** Какая сторона окна сравнения — файл проекта (вторая — резервная копия или копия хранилища). */
export type MergeDiffProjectSide = 'local' | 'repository';

/**
 * Пара для окна сравнения. Единая конвенция для захвата/получения: слева — локальное
 * состояние, справа — версия хранилища, независимо от того, какая сторона — файл
 * проекта. `writable` — файл проекта можно редактировать (объект захвачен, поддержка
 * разрешает), значит readonly сессии с него снимается.
 */
export interface MergeDiffPair {
  title: string;
  /** Левая сторона — локальное состояние. */
  local: string;
  /** Правая сторона — версия хранилища. */
  repository: string;
  projectSide: MergeDiffProjectSide;
  writable: boolean;
}

export function mergeDiffProjectPath(pair: Pick<MergeDiffPair, 'local' | 'repository' | 'projectSide'>): string {
  return pair[pair.projectSide];
}

/** Подписи сторон в заголовке: без них по окну не понять, какую сторону можно править. */
export function formatMergeDiffTitle(rel: string, projectSide: MergeDiffProjectSide): string {
  const sides = projectSide === 'local'
    ? 'мои изменения: файл проекта ↔ хранилище: копия'
    : 'мои изменения: копия ↔ хранилище: файл проекта';
  return `${path.posix.basename(rel)} (${sides})`;
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

/**
 * Файл мог быть открыт как readonly до захвата — сессионный флаг снимается явно,
 * иначе перенести правки нельзя. Команда действует только на правую сторону активного
 * сравнения, поэтому файл проекта слева снимается через временную обычную вкладку,
 * а сравнение затем снова делается активным.
 */
export async function openMergeDiffs(pairs: readonly MergeDiffPair[]): Promise<void> {
  for (const pair of pairs) {
    const showDiff = (): Thenable<unknown> => vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(pair.local),
      vscode.Uri.file(pair.repository),
      pair.title,
      { preview: false }
    );
    await showDiff();
    if (pair.writable) {
      const projectPath = mergeDiffProjectPath(pair);
      await runWithResourceActive(
        selectReadonlyApplyRoute(collectOpenTabs(), projectPath),
        vscode.Uri.file(projectPath),
        () => Promise.resolve(vscode.commands.executeCommand(RESET_READONLY_COMMAND))
      );
      if (pair.projectSide === 'local') {
        await showDiff();
      }
    }
  }
}

/* c8 ignore start -- модальные диалоги и тонкие чтения настроек/документов vscode не автоматизируются
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
