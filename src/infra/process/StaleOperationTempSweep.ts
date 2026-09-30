import { pruneStaleImportTempDirs } from '../fs/WorkspaceTempDir';

/**
 * Порог устаревания временных каталогов операций. Подметание идёт вне замка операций
 * над конфигурацией, поэтому единственная защита живого потока — возраст: сутки заведомо
 * больше любой операции, в том числе в другом окне VS Code на том же проекте.
 */
export const STALE_OPERATION_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StaleOperationTempSweepResult {
  readonly removed: readonly string[];
  readonly failures: readonly string[];
}

/**
 * Подметание хвостов операций, прерванных аварийным завершением extension host:
 * `import-temp/*`. Сбой возвращается текстом, а не исключением — очистка не должна
 * срывать активацию.
 */
export async function sweepStaleOperationTemp(
  workspaceRoot: string,
  now: Date,
  maxAgeMs: number = STALE_OPERATION_TEMP_MAX_AGE_MS
): Promise<StaleOperationTempSweepResult> {
  try {
    return { removed: await pruneStaleImportTempDirs(workspaceRoot, now, maxAgeMs), failures: [] };
  } catch (error) {
    // fs бросает только Error; String(error) — страховка типа unknown.
    /* c8 ignore next */
    return { removed: [], failures: [error instanceof Error ? error.message : String(error)] };
  }
}
