/**
 * Явный исход команд импорта/обновления конфигураций. Раньше команды
 * возвращали `boolean`/`undefined`, и MCP-мост не отличал «занято другой
 * операцией» от «отменено пользователем» или «сбой»: агент не мог решить,
 * повторять ли вызов. Модуль без `vscode` — решающая логика тестируется
 * отдельно от команд.
 */

export type ConfigurationCommandOutcome =
  | { readonly status: 'done'; readonly completed: readonly string[] }
  | { readonly status: 'no-changes' }
  | { readonly status: 'no-targets' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'busy'; readonly heldBy: string }
  | {
    readonly status: 'failed';
    readonly completed: readonly string[];
    readonly stoppedAt?: string;
    readonly error?: string;
  };

export type ConfigurationCommandStatus = ConfigurationCommandOutcome['status'];

/** Единый перечень статусов — из него собирается описание MCP-инструмента. */
export const CONFIGURATION_COMMAND_STATUSES = [
  'done',
  'no-changes',
  'no-targets',
  'cancelled',
  'busy',
  'failed',
] as const satisfies readonly ConfigurationCommandStatus[];

/** `no-changes` — тоже успех: прежняя boolean-семантика обновления давала `true`. */
export function isConfigurationCommandSucceeded(outcome: ConfigurationCommandOutcome): boolean {
  return outcome.status === 'done' || outcome.status === 'no-changes';
}

export function failedOutcome(
  completed: readonly string[],
  cause: { readonly stoppedAt: string } | { readonly error: unknown }
): ConfigurationCommandOutcome {
  if ('stoppedAt' in cause) {
    return { status: 'failed', completed, stoppedAt: cause.stoppedAt };
  }
  // Исход уходит в JSON-ответ MCP: объект Error сериализуется в `{}`.
  const error = cause.error instanceof Error ? cause.error.message : String(cause.error);
  return { status: 'failed', completed, error };
}
