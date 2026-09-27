import * as vscode from 'vscode';
import type { RepositoryLockStatusSyncResult } from '../../../infra/repository/RepositoryLockStatusService';
import type { RepositoryNodeRef, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';
import { resolveRepositoryTarget } from './RepositoryCommandRunner';
import { refreshRepositoryUi } from './RepositoryDatabaseSync';

/**
 * «Обновить статусы захватов» (issue #6): опрос сервера хранилища или файла 1CD и запись
 * чужих/своих захватов в state.json. Меняется только локальный кэш — конфигурация и база
 * не трогаются, поэтому MCP-инструмента нет (как у прочих команд хранилища без записи XML).
 */

export interface RepositoryLockStatusNotifier {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export type RepositoryLockStatusServices = Pick<CommandServices, 'repositoryService' | 'treeProvider' | 'refreshActionsView' | 'outputChannel'>;

const LOG_PREFIX = '[repository][locks]';

export function describeLockStatusResult(
  target: RepositoryTarget,
  result: RepositoryLockStatusSyncResult
): { level: 'info' | 'warning' | 'error'; message: string } {
  const name = `«${target.displayName}»`;
  switch (result.status) {
    case 'synced': {
      const details = [
        `чужих — ${String(result.foreign)}`,
        `своих — ${String(result.own)}`,
        ...(result.ownElsewhere.length > 0 ? [`из них вне проекта — ${String(result.ownElsewhere.length)}`] : []),
        ...(result.unconfirmed.length > 0 ? [`не подтверждено сервером — ${String(result.unconfirmed.length)}`] : []),
        ...(result.unmatched > 0 ? [`не найдено в выгрузке — ${String(result.unmatched)}`] : []),
      ];
      return { level: 'info', message: `Статусы захватов ${name} обновлены: ${details.join(', ')}.` };
    }
    case 'not-connected':
      return { level: 'warning', message: `Конфигурация ${name} не подключена к хранилищу.` };
    case 'stale':
      return { level: 'warning', message: `Захваты ${name} изменились во время обновления статусов — повторите обновление.` };
    case 'failed':
      return { level: 'error', message: `Не удалось обновить статусы захватов ${name}: ${result.reason}` };
  }
}

/** Ручное обновление: по узлу — его цель, без узла (палитра команд) — все подключённые цели. */
export async function refreshRepositoryLockStatuses(
  node: RepositoryNodeRef | undefined,
  services: RepositoryLockStatusServices,
  notifier: RepositoryLockStatusNotifier
): Promise<void> {
  let targets: RepositoryTarget[];
  if (node) {
    const target = resolveRepositoryTarget(services.repositoryService, node);
    if (!target) {
      notifier.error('Не удалось определить конфигурацию для выбранного узла.');
      return;
    }
    targets = [target];
  } else {
    targets = listConnectedTargets(services);
    if (targets.length === 0) {
      notifier.warning('Нет конфигураций, подключённых к хранилищу.');
      return;
    }
  }
  await syncTargets(targets, services, (level, message) => notifier[level](message));
}

/**
 * Однократное обновление при старте: только лог и никогда не отклоняется. В недоверенной
 * рабочей области не выполняется — подложенный env.json увёл бы хеш пароля на чужой сервер.
 */
export async function syncRepositoryLockStatusesOnStartup(services: RepositoryLockStatusServices, workspaceTrusted: boolean): Promise<void> {
  const log = (message: string): void => services.outputChannel.appendLine(`${LOG_PREFIX} ${message}`);
  if (!workspaceTrusted) {
    log('автообновление статусов захватов пропущено: рабочая область недоверенная.');
    return;
  }
  try {
    // Исходы уже в логе (syncTargets пишет их всегда) — уведомлений при старте нет.
    await syncTargets(listConnectedTargets(services), services, () => undefined);
  } catch (error) {
    // Повреждённый env.json бросает уже при проверке подключения цели.
    log(`автообновление статусов захватов не выполнено: ${String(error)}`);
  }
}

/* c8 ignore start -- тонкая обёртка над vscode.window: сама логика команды проверяется с внедрённым notifier */
const WINDOW_NOTIFIER: RepositoryLockStatusNotifier = {
  // Немодальные уведомления без ожидания: команда не держит эксклюзивных операций.
  info: (message) => { void vscode.window.showInformationMessage(message); },
  warning: (message) => { void vscode.window.showWarningMessage(message); },
  error: (message) => { void vscode.window.showErrorMessage(message); },
};
/* c8 ignore stop */

export function registerRepositoryLockStatusCommands(
  context: vscode.ExtensionContext,
  services: CommandServices,
  notifier: RepositoryLockStatusNotifier = WINDOW_NOTIFIER
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.repository.refreshLocks', (node?: RepositoryNodeRef) =>
      refreshRepositoryLockStatuses(node, services, notifier))
  );
}

function listConnectedTargets(services: RepositoryLockStatusServices): RepositoryTarget[] {
  const { repositoryService } = services;
  return services.treeProvider.getEntries()
    .map((entry) => repositoryService.resolveTargetByConfigRoot(entry.rootPath))
    .filter((target): target is RepositoryTarget => target !== null && repositoryService.isConnected(target));
}

/**
 * Опрос целей по очереди: исход — в лог и в `report`; дерево обновляется один раз и только
 * если состояние изменилось.
 */
async function syncTargets(
  targets: readonly RepositoryTarget[],
  services: RepositoryLockStatusServices,
  report: (level: 'info' | 'warning' | 'error', message: string) => void
): Promise<void> {
  let changed = false;
  for (const target of targets) {
    const result = await services.repositoryService.lockStatus.syncTarget(target);
    const described = describeLockStatusResult(target, result);
    services.outputChannel.appendLine(`${LOG_PREFIX} ${described.message}`);
    if (result.status === 'synced') {
      logSyncDetails(services, target, result);
      changed ||= result.changed.length > 0;
    }
    report(described.level, described.message);
  }
  if (changed) {
    refreshRepositoryUi(services);
  }
}

function logSyncDetails(
  services: RepositoryLockStatusServices,
  target: RepositoryTarget,
  result: Extract<RepositoryLockStatusSyncResult, { status: 'synced' }>
): void {
  if (result.ownElsewhere.length > 0) {
    services.outputChannel.appendLine(`${LOG_PREFIX} ${target.displayName}: захвачены вашим пользователем вне проекта `
      + `(захватите, чтобы редактировать): ${result.ownElsewhere.join(', ')}`);
  }
  if (result.unconfirmed.length > 0) {
    services.outputChannel.appendLine(`${LOG_PREFIX}[warn] ${target.displayName}: локальные захваты не подтверждены сервером: `
      + result.unconfirmed.join(', '));
  }
}
