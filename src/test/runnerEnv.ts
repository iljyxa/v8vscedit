const INHERITED_IDE_ENV_PREFIXES = ['VSCODE_', 'ELECTRON_'];

export interface RunnerSettings {
  readonly version: string;
}

/**
 * Готовит окружение процесса-раннера: забирает собственные настройки прогона и
 * вычищает переменные, унаследованные от IDE, из которой запущен прогон.
 *
 * Чтение и санитайз объединены в одну функцию намеренно: настройки прогона сами
 * начинаются с `VSCODE_` (`VSCODE_TEST_VERSION`), и прочитанные после санитайза
 * они молча пропадали бы — так было в обоих раннерах (issue #11).
 */
export function takeRunnerSettingsAndSanitize(env: NodeJS.ProcessEnv = process.env): RunnerSettings {
  const settings: RunnerSettings = {
    version: env.VSCODE_TEST_VERSION ?? 'stable',
  };

  for (const key of Object.keys(env)) {
    if (INHERITED_IDE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      Reflect.deleteProperty(env, key);
    }
  }

  return settings;
}
