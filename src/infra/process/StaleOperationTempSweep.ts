import { pruneStaleAgentDumps } from '../agent/AgentDumpCleanup';
import { pruneStaleImportTempDirs } from '../fs/WorkspaceTempDir';

/**
 * Порог устаревания временных каталогов операций. Подметание идёт вне аренды
 * `ConfigurationOperationGuard` (слияние и диалог конфликта держат каталог выгрузки и
 * после аренды), поэтому единственная защита живого потока — возраст: сутки заведомо
 * больше любой операции, в том числе в другом окне VS Code на том же проекте.
 */
export const STALE_OPERATION_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StaleOperationTempSweepResult {
  readonly removed: readonly string[];
  readonly failures: readonly string[];
}

/**
 * Подметание хвостов операций, прерванных аварийным завершением extension host:
 * `import-temp/*` и одноразовых выгрузок агента. Шаги независимы: сбой одного не
 * мешает другому и возвращается текстом, а не исключением — очистка не должна
 * срывать активацию.
 */
export async function sweepStaleOperationTemp(
  workspaceRoot: string,
  now: Date,
  maxAgeMs: number = STALE_OPERATION_TEMP_MAX_AGE_MS
): Promise<StaleOperationTempSweepResult> {
  const steps: readonly (() => Promise<string[]>)[] = [
    () => pruneStaleImportTempDirs(workspaceRoot, now, maxAgeMs),
    () => pruneStaleAgentDumps(workspaceRoot, now, maxAgeMs),
  ];
  const removed: string[] = [];
  const failures: string[] = [];
  for (const step of steps) {
    try {
      removed.push(...await step());
    } catch (error) {
      // fs бросает только Error; String(error) — страховка типа unknown.
      /* c8 ignore next */
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { removed, failures };
}
