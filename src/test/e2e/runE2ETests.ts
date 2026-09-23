import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { takeRunnerSettingsAndSanitize } from '../runnerEnv';

/**
 * Запуск E2E-набора: открывает проект-выгрузку 1С как workspace и гоняет
 * реальные команды/сервисы расширения (создание → загрузка в базу → правка →
 * удаление). Workspace по умолчанию — `example/2.20`; переопределяется
 * переменной `E2E_WORKSPACE` (абсолютный путь), чтобы прогонять на другой
 * выгрузке/базе (напр. временной). Реальная загрузка в базу требует платформы
 * 1С и базы из `env.json`; без них тесты внутри набора пропускаются.
 */
async function main(): Promise<void> {
  try {
    const { version } = takeRunnerSettingsAndSanitize();

    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './index');
    const workspace = process.env.E2E_WORKSPACE ?? path.resolve(__dirname, '../../../example/2.20');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions'],
      version,
    });
  } catch (err) {
    console.error('E2E завершились с ошибкой:', err);
    process.exit(1);
  }
}

void main();
