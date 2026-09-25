import * as path from 'path';
import * as vscode from 'vscode';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';

/**
 * Настраивает watcher за файлом `Ext/ParentConfigurations.bin`: при его
 * изменении сбрасывается кэш `SupportInfoService` и обновляется дерево:
 * индикатор поддержки строится из `contextValue` узлов при их перерисовке.
 *
 * Вынос из `extension.ts` выполнен для того, чтобы активатор оставался тонкой
 * композицией, а инфраструктурная подписка жила в `ui/support/`.
 */
export function registerSupportWatcher(
  workspaceFolder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  supportService: SupportInfoService,
  onTreeRefresh: () => void
): void {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, '**/Ext/ParentConfigurations.bin'),
    false,
    false,
    false
  );

  const handlers = createParentConfigurationsHandlers(supportService, onTreeRefresh);

  watcher.onDidCreate(handlers.onChange, null, context.subscriptions);
  watcher.onDidChange(handlers.onChange, null, context.subscriptions);
  watcher.onDidDelete(handlers.onDelete, null, context.subscriptions);
  context.subscriptions.push(watcher);
}

export interface ParentConfigurationsHandlers {
  readonly onChange: (uri: vscode.Uri) => void;
  readonly onDelete: (uri: vscode.Uri) => void;
}

/**
 * Реакция на события файла `<корень>/Ext/ParentConfigurations.bin`. Отделена от
 * подписки, чтобы её можно было проверить на реальной выгрузке без ожидания
 * событий файловой системы.
 */
export function createParentConfigurationsHandlers(
  supportService: SupportInfoService,
  onTreeRefresh: () => void
): ParentConfigurationsHandlers {
  return {
    onChange: (uri) => {
      const configRoot = configRootOfBin(uri);
      supportService.invalidate(configRoot);
      supportService.loadConfig(configRoot);
      onTreeRefresh();
    },
    onDelete: (uri) => {
      supportService.invalidate(configRootOfBin(uri));
      onTreeRefresh();
    },
  };
}

function configRootOfBin(binUri: vscode.Uri): string {
  return path.dirname(path.dirname(binUri.fsPath));
}
