import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { takeRunnerSettingsAndSanitize } from './runnerEnv';
import { withIsolatedTempDir } from './runnerTempDir';

async function main(): Promise<void> {
  try {
    const { version } = takeRunnerSettingsAndSanitize();

    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await withIsolatedTempDir((extensionTestsEnv) => runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv,
      launchArgs: ['--disable-extensions'],
      version,
    }));
  } catch (err) {
    console.error('Тесты завершились с ошибкой:', err);
    process.exit(1);
  }
}

void main();
