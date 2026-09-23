import * as assert from 'assert';
import { takeRunnerSettingsAndSanitize } from '../runnerEnv';

// Объект окружения передаётся явно: мутация настоящего process.env хоста тестов
// повлияла бы на соседние наборы.
suite('Окружение тестовых раннеров', () => {
  test('Отдаёт VSCODE_TEST_VERSION, хотя санитайз удаляет префикс VSCODE_', () => {
    const env: NodeJS.ProcessEnv = { VSCODE_TEST_VERSION: '1.85.0' };

    assert.deepStrictEqual(takeRunnerSettingsAndSanitize(env), { version: '1.85.0' });
    assert.strictEqual(env.VSCODE_TEST_VERSION, undefined);
  });

  test('Без VSCODE_TEST_VERSION берёт stable', () => {
    assert.deepStrictEqual(takeRunnerSettingsAndSanitize({}), { version: 'stable' });
  });

  test('Удаляет унаследованные VSCODE_ и ELECTRON_, остальные переменные оставляет', () => {
    const env: NodeJS.ProcessEnv = {
      VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc.sock',
      ELECTRON_RUN_AS_NODE: '1',
      MOCHA_GREP: 'OnecPlatform',
      E2E_WORKSPACE: '/tmp/ws',
    };

    takeRunnerSettingsAndSanitize(env);

    assert.deepStrictEqual(env, { MOCHA_GREP: 'OnecPlatform', E2E_WORKSPACE: '/tmp/ws' });
  });
});
