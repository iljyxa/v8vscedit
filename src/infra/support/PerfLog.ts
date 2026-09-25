/**
 * Единый префикс строк замера: по нему строки фаз легко отфильтровать в канале
 * «1С Редактор» и сравнить между запусками.
 */
export const PERF_LOG_PREFIX = '[perf]';

export function formatPerfLine(label: string, durationMs: number, details?: string): string {
  const line = `${PERF_LOG_PREFIX} ${label}: ${String(Math.round(durationMs))} мс`;
  return details ? `${line} (${details})` : line;
}

/**
 * Замеряет синхронную фазу и отдаёт строку `[perf]` приёмнику. Если фаза
 * бросила, строка не пишется и исключение уходит вызывающему как было: замер не
 * должен менять поведение активации.
 */
export function measurePerfPhase<T>(
  clock: () => number,
  write: (line: string) => void,
  label: string,
  run: () => T,
  details?: (result: T) => string
): T {
  const startedAt = clock();
  const result = run();
  write(formatPerfLine(label, clock() - startedAt, details?.(result)));
  return result;
}
