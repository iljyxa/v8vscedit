import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangedConfiguration } from '../../../infra/fs/ConfigurationChangeDetector';
import type { ConfigurationOperationExclusiveResult } from '../../../infra/process/ConfigurationOperationGuard';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';
import {
  runApplyDatabaseConfiguration,
  runDecompileExtension,
  runDecompileMainConfiguration,
  runUpdateExtension,
  runUpdateMainConfiguration,
} from '../ext/ExtensionCommandRunner';
import {
  CONFIGURATION_OPERATION_BUSY_MESSAGE,
  notifyConfigurationOperationBusy,
} from '../ext/configurationOperationBusy';

export type RepositoryDatabaseSyncServices = Pick<
  CommandServices,
  | 'configurationOperationGuard'
  | 'workspaceFolder'
  | 'outputChannel'
  | 'getChangedConfigurations'
  | 'markConfigurationsClean'
  | 'reloadEntries'
  | 'treeProvider'
  | 'refreshActionsView'
>;

/**
 * Внешние точки (запуск Конфигуратора и модальные диалоги) внедряются, чтобы
 * логику захвата guard'а и порядок цепочки можно было проверить без процесса 1С.
 */
export interface RepositoryDatabaseSyncDeps {
  readonly applyDatabaseConfiguration: typeof runApplyDatabaseConfiguration;
  readonly decompileMainConfiguration: typeof runDecompileMainConfiguration;
  readonly decompileExtension: typeof runDecompileExtension;
  readonly updateMainConfiguration: typeof runUpdateMainConfiguration;
  readonly updateExtension: typeof runUpdateExtension;
  readonly confirmUpdateBeforeCommit: (changed: ChangedConfiguration) => Promise<boolean>;
  readonly notifyBusy: (message: string) => void;
}

/* c8 ignore start -- модальный QuickPick vscode не автоматизируется в тестовом хосте (правило CLAUDE.md №4) */
async function confirmUpdateBeforeCommitWithQuickPick(changed: ChangedConfiguration): Promise<boolean> {
  const picked = await vscode.window.showQuickPick([
    {
      id: 'update',
      label: '$(sync) Обновить и продолжить',
      description: 'Сначала загрузить локальные изменения в базу, затем выполнить помещение',
      detail: `${changed.name}: изменённых файлов ${String(changed.changedFilesCount)}`,
    },
    {
      id: 'cancel',
      label: '$(close) Отменить помещение',
      description: 'Помещение без предварительного обновления запрещено',
    },
  ], {
    title: 'Перед помещением требуется обновление конфигурации',
    placeHolder: 'В конфигурации есть локальные изменения, ещё не загруженные в базу',
    ignoreFocusOut: true,
  });
  return picked?.id === 'update';
}
/* c8 ignore stop */

export const DEFAULT_REPOSITORY_DATABASE_SYNC_DEPS: RepositoryDatabaseSyncDeps = {
  applyDatabaseConfiguration: runApplyDatabaseConfiguration,
  decompileMainConfiguration: runDecompileMainConfiguration,
  decompileExtension: runDecompileExtension,
  updateMainConfiguration: runUpdateMainConfiguration,
  updateExtension: runUpdateExtension,
  confirmUpdateBeforeCommit: confirmUpdateBeforeCommitWithQuickPick,
  notifyBusy: notifyConfigurationOperationBusy,
};

export type PostRepositorySyncOutcome = 'done' | 'busy' | 'apply-failed' | 'import-failed' | 'error';

export function refreshRepositoryUi(services: Pick<CommandServices, 'treeProvider' | 'refreshActionsView'>): void {
  services.treeProvider.refresh();
  services.refreshActionsView();
}

/**
 * Применение конфигурации из хранилища к базе и загрузка результата в выгрузку.
 * Guard держится на всю цепочку: иначе параллельный импорт/обновление запустил
 * бы второй Конфигуратор на той же базе.
 */
export async function runPostRepositorySync(
  target: RepositoryTarget,
  services: RepositoryDatabaseSyncServices,
  deps: RepositoryDatabaseSyncDeps = DEFAULT_REPOSITORY_DATABASE_SYNC_DEPS
): Promise<PostRepositorySyncOutcome> {
  let result: ConfigurationOperationExclusiveResult<Awaited<ReturnType<typeof runSyncChain>>>;
  try {
    result = await services.configurationOperationGuard.runExclusive(
      `Синхронизация с хранилищем: ${target.displayName}`,
      () => runSyncChain(target, services, deps)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.outputChannel.appendLine(`[repository][post-sync][error] ${message}`);
    return 'error';
  }

  if (!result.acquired) {
    services.outputChannel.appendLine(
      `[repository][post-sync][busy] "${target.displayName}": пропущено, выполняется "${result.heldBy}"`
    );
    deps.notifyBusy(
      `Конфигурация "${target.displayName}" подключена к хранилищу, но загрузка из базы пропущена: ` +
      `уже выполняется операция "${result.heldBy}". После её завершения выполните «Импортировать из базы».`
    );
    return 'busy';
  }
  return result.value;
}

async function runSyncChain(
  target: RepositoryTarget,
  services: RepositoryDatabaseSyncServices,
  deps: RepositoryDatabaseSyncDeps
): Promise<Exclude<PostRepositorySyncOutcome, 'busy' | 'error'>> {
  const updated = await deps.applyDatabaseConfiguration({
    kind: target.configKind,
    name: target.displayName,
    rootPath: target.configRoot,
    extensionName: target.extensionName,
  }, services.workspaceFolder, services.outputChannel, false);
  if (!updated) {
    return 'apply-failed';
  }

  const imported = target.configKind === 'cfe'
    ? await deps.decompileExtension(
        target.extensionName ?? target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel
      )
    : await deps.decompileMainConfiguration(
        target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel
      );
  if (!imported) {
    return 'import-failed';
  }

  services.markConfigurationsClean([target.configRoot]);
  await services.reloadEntries();
  refreshRepositoryUi(services);
  return 'done';
}

/**
 * Помещение в хранилище требует, чтобы локальные изменения уже были в базе.
 * Занятость guard'а проверяется до QuickPick, чтобы не предлагать обновление,
 * которое всё равно не сможет стартовать.
 */
export async function ensureTargetUpdatedBeforeCommit(
  target: RepositoryTarget,
  services: RepositoryDatabaseSyncServices,
  deps: RepositoryDatabaseSyncDeps = DEFAULT_REPOSITORY_DATABASE_SYNC_DEPS
): Promise<boolean> {
  const changed = services.getChangedConfigurations().find(
    (item) => path.resolve(item.rootPath).toLowerCase() === path.resolve(target.configRoot).toLowerCase()
  );
  if (!changed) {
    return true;
  }

  const guard = services.configurationOperationGuard;
  if (guard.isBusy) {
    deps.notifyBusy(CONFIGURATION_OPERATION_BUSY_MESSAGE);
    return false;
  }

  if (!(await deps.confirmUpdateBeforeCommit(changed))) {
    return false;
  }

  // Повторная проверка через runExclusive: пока QuickPick был открыт, guard
  // мог занять другой путь.
  const result = await guard.runExclusive(`Обновление ${target.displayName} перед помещением`, async () => {
    const updated = target.configKind === 'cfe'
      ? await deps.updateExtension(
          target.extensionName ?? target.displayName,
          target.configRoot,
          services.workspaceFolder,
          services.outputChannel,
          false
        )
      : await deps.updateMainConfiguration(
          target.displayName,
          target.configRoot,
          services.workspaceFolder,
          services.outputChannel,
          false
        );
    if (updated) {
      services.markConfigurationsClean([target.configRoot]);
    }
    return updated;
  });

  if (!result.acquired) {
    deps.notifyBusy(CONFIGURATION_OPERATION_BUSY_MESSAGE);
    return false;
  }
  if (!result.value) {
    return false;
  }

  refreshRepositoryUi(services);
  return true;
}
