import * as vscode from 'vscode';

export const CONFIGURATION_OPERATION_BUSY_MESSAGE =
  'Операция с конфигурацией уже выполняется. Дождитесь её завершения.';

/**
 * Уведомление о занятом guard'е показывается без `await` (запрет CLAUDE.md №18):
 * иначе вызывающая команда или MCP-мост висели бы до закрытия нотификации.
 */
export function notifyConfigurationOperationBusy(message = CONFIGURATION_OPERATION_BUSY_MESSAGE): void {
  void vscode.window.showInformationMessage(message);
}
