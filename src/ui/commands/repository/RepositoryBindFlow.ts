import * as vscode from 'vscode';
import {
  isRepositoryBindNotEmptyFailure,
  parseRepositoryBindUnmarkedLocks,
  resolveBindReportedUnits,
} from '../../../infra/repository/RepositoryLockOutputParser';
import { toLocalTimestamp } from '../../../infra/repository/RepositoryLockState';
import { isRootLockName } from '../../../infra/repository/RepositoryObjectNames';
import type { RepositoryLockStatusSyncResult } from '../../../infra/repository/RepositoryLockStatusService';
import type { RepositoryBinding, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';
import {
  type PostRepositorySyncOutcome,
  refreshRepositoryUi,
  type RepositoryDatabaseSyncServices,
  runPostRepositorySync,
} from './RepositoryDatabaseSync';
import { logLockStatusResult } from './RepositoryLockStatusCommands';

/**
 * Завершение подключения к хранилищу (issue #106): после привязки база ещё пуста, поэтому
 * объекты, которые пользователь хранилища уже держит захваченными, в проекте не видны.
 * Сначала конфигурация хранилища применяется к базе и выгружается, затем опрашиваются
 * статусы захватов; если опрос невозможен — свои захваты берутся из вывода привязки.
 */

export type RepositoryBindServices = RepositoryDatabaseSyncServices & Pick<CommandServices, 'repositoryService'>;

export interface RepositoryBindDeps {
  readonly runPostSync: (target: RepositoryTarget, services: RepositoryDatabaseSyncServices) => Promise<PostRepositorySyncOutcome>;
  readonly isWorkspaceTrusted: () => boolean;
  /** Немодальное предупреждение без ожидания: пользователь может не закрывать его сразу. */
  readonly notifyWarning: (message: string) => void;
  readonly now: () => Date;
}

/* c8 ignore start -- тонкие обёртки над vscode и процессом 1С: поведение потока проверяется с внедрёнными deps */
export const DEFAULT_REPOSITORY_BIND_DEPS: RepositoryBindDeps = {
  runPostSync: (target, services) => runPostRepositorySync(target, services),
  // В недоверенной области подложенный env.json увёл бы хеш пароля на чужой сервер.
  isWorkspaceTrusted: () => vscode.workspace.isTrusted,
  notifyWarning: (message) => { void vscode.window.showWarningMessage(message); },
  now: () => new Date(),
};
/* c8 ignore stop */

export const MAX_LISTED_OWN_ELSEWHERE = 10;

export type RepositoryBindLockSource = 'server' | 'bind-output' | 'none';

export interface RepositoryBindCompletion {
  readonly postSync: PostRepositorySyncOutcome;
  readonly lockStatus: RepositoryLockStatusSyncResult | { status: 'skipped-untrusted' };
  readonly source: RepositoryBindLockSource;
  readonly ownElsewhere: readonly string[];
}

const LOG_PREFIX = '[repository][locks]';

export async function completeRepositoryBind(
  request: { target: RepositoryTarget; repoUser: string; bindOutput: string },
  services: RepositoryBindServices,
  deps: RepositoryBindDeps = DEFAULT_REPOSITORY_BIND_DEPS
): Promise<RepositoryBindCompletion> {
  const log = (message: string): void => services.outputChannel.appendLine(`${LOG_PREFIX} ${message}`);
  const reported = parseRepositoryBindUnmarkedLocks(request.bindOutput);
  if (reported.length > 0) {
    log(`${request.target.displayName}: при подключении платформа сообщила захваты вашего пользователя, `
      + `не помеченные в базе: ${reported.join(', ')}`);
  }

  // Исход пост-синхронизации не важен: опрос сам сообщит, если выгрузки ещё нет.
  const postSync = await deps.runPostSync(request.target, services);
  // Импорт в пустой проект меняет имя конфигурации: цель разрешается заново.
  const { repositoryService } = services;
  const current = repositoryService.resolveTargetByConfigRoot(request.target.configRoot) ?? request.target;

  let lockStatus: RepositoryBindCompletion['lockStatus'];
  if (deps.isWorkspaceTrusted()) {
    lockStatus = await repositoryService.lockStatus.syncTarget(current);
    logLockStatusResult(services, current, lockStatus);
  } else {
    log(`${current.displayName}: рабочая область недоверенная — опрос статусов захватов пропущен.`);
    lockStatus = { status: 'skipped-untrusted' };
  }

  let source: RepositoryBindLockSource = 'none';
  let ownElsewhere: readonly string[] = [];
  if (lockStatus.status === 'synced') {
    source = 'server';
    ownElsewhere = lockStatus.ownElsewhere;
  } else if (lockStatus.status !== 'not-connected' && repositoryService.isConnected(current)) {
    const resolved = resolveBindReportedUnits(reported, current);
    if (resolved.unrecognized.length > 0) {
      log(`${current.displayName}: не удалось сопоставить с объектами проекта: ${resolved.unrecognized.join(', ')}`);
    }
    if (resolved.fullNames.length > 0) {
      repositoryService.lockState.applyReportedOwnLocks(current, {
        user: request.repoUser.trim(),
        observedAt: toLocalTimestamp(deps.now()),
        fullNames: resolved.fullNames,
      });
      source = 'bind-output';
      ownElsewhere = resolved.fullNames.filter((fullName) =>
        repositoryService.lockState.getLockInfo(current, fullName).state === 'own-elsewhere');
    }
  }

  if ((lockStatus.status === 'synced' && lockStatus.changed.length > 0) || source === 'bind-output') {
    refreshRepositoryUi(services);
  }
  if (ownElsewhere.length > 0) {
    notifyOwnElsewhere(current, ownElsewhere, log, deps);
  }
  return { postSync, lockStatus, source, ownElsewhere };
}

function notifyOwnElsewhere(
  target: RepositoryTarget,
  ownElsewhere: readonly string[],
  log: (message: string) => void,
  deps: RepositoryBindDeps
): void {
  log(`${target.displayName}: захвачены вашим пользователем вне проекта (захватите, чтобы редактировать): `
    + ownElsewhere.join(', '));
  const listed = ownElsewhere.slice(0, MAX_LISTED_OWN_ELSEWHERE).map((fullName) => formatOwnElsewhereName(fullName, target)).join(', ');
  const rest = ownElsewhere.length - MAX_LISTED_OWN_ELSEWHERE;
  deps.notifyWarning(`«${target.displayName}»: ваш пользователь хранилища уже держит захваченными объекты, `
    + `не помеченные захваченными в этом проекте: ${listed}${rest > 0 ? ` и ещё ${String(rest)} (см. журнал)` : ''}. `
    + 'Захватите их («Захватить»), чтобы редактировать.');
}

/**
 * Имя единицы для пользователя: корень в state.json хранится служебным ключом, в уведомлении
 * он показывается видом и именем цели. В журнал идут fullName как есть (как у опроса).
 */
export function formatOwnElsewhereName(fullName: string, target: RepositoryTarget): string {
  if (!isRootLockName(fullName)) {
    return fullName;
  }
  return `${target.configKind === 'cfe' ? 'расширение' : 'конфигурация'} «${target.displayName}»`;
}

/** Подсказка к ошибке привязки: распознаётся отказ из-за непустой конфигурации базы. */
export function describeBindFailureHint(output: string): string | undefined {
  return isRepositoryBindNotEmptyFailure(output)
    ? 'Конфигурация базы не пустая. Чтобы заменить её конфигурацией хранилища, повторите подключение с флагом '
      + '«Принудительно заменить конфигурацию» (-ForceReplaceCfg); изменения базы, не помещённые в хранилище, будут потеряны.'
    : undefined;
}

export function validateBindingForm(
  formData: { repoPath: string; repoUser: string; repoPassword: string }
): { ok: true; binding: RepositoryBinding } | { ok: false; errorMessage: string } {
  const repoPath = formData.repoPath.trim();
  const repoUser = formData.repoUser.trim();
  if (!repoPath) {
    return { ok: false, errorMessage: 'Нужно указать путь к хранилищу или адрес сервера.' };
  }
  if (!repoUser) {
    return { ok: false, errorMessage: 'Нужно указать пользователя хранилища.' };
  }
  return {
    ok: true,
    binding: {
      repoPath,
      repoUser,
      repoPassword: formData.repoPassword,
    },
  };
}
