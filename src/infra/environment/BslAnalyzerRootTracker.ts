import type { ConfigEntry } from '../../domain/Configuration';

/**
 * bsl-analyzer ищет корень конфигурации один раз при старте: если основной выгрузки
 * `src/cf` тогда не было, он индексирует всю рабочую область (включая `.v8vscedit/**`)
 * и не узнаёт о появившейся выгрузке. Трекер решает, когда сервер надо перезапустить.
 */

export type BslAnalyzerRestartReason =
  | 'initial'
  | 'main-configuration-appeared'
  | 'main-configuration-unchanged'
  | 'main-configuration-missing'
  | 'lsp-disabled';

export interface BslAnalyzerRestartDecision {
  readonly restart: boolean;
  readonly reason: BslAnalyzerRestartReason;
}

export function hasMainConfiguration(entries: readonly ConfigEntry[]): boolean {
  return entries.some((entry) => entry.kind === 'cf');
}

/**
 * Первое наблюдение — не повод для перезапуска: сервер стартует уже с текущим составом.
 * Расширения на выбор корня не влияют, поэтому их появление перезапуска не требует.
 */
export function decideBslAnalyzerRestart(
  previousHasMain: boolean | undefined,
  entries: readonly ConfigEntry[],
  lspEnabled: boolean
): BslAnalyzerRestartDecision {
  if (previousHasMain === undefined) {
    return { restart: false, reason: 'initial' };
  }
  if (!hasMainConfiguration(entries)) {
    return { restart: false, reason: 'main-configuration-missing' };
  }
  if (previousHasMain) {
    return { restart: false, reason: 'main-configuration-unchanged' };
  }
  if (!lspEnabled) {
    return { restart: false, reason: 'lsp-disabled' };
  }
  return { restart: true, reason: 'main-configuration-appeared' };
}

export class BslAnalyzerRootTracker {
  private previousHasMain: boolean | undefined;

  /**
   * Снимок обновляется при любом исходе: при выключенном LSP сервер после включения
   * стартует заново и сам увидит выгрузку, перезапуск ему уже не нужен.
   */
  observe(entries: readonly ConfigEntry[], lspEnabled: boolean): BslAnalyzerRestartDecision {
    const decision = decideBslAnalyzerRestart(this.previousHasMain, entries, lspEnabled);
    this.previousHasMain = hasMainConfiguration(entries);
    return decision;
  }
}
