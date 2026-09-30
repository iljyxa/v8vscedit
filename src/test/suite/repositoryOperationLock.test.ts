import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RepositoryService, RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import {
  endConfigurationOperation,
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { runRepositoryCliCommand } from '../../ui/commands/repository/RepositoryCommandRunner';
import { ensureTargetUpdatedBeforeCommit, runPostRepositorySync } from '../../ui/commands/repository/RepositoryCommands';

/**
 * Команды хранилища запускают Конфигуратор на той же базе, что импорт и обновление, но шли
 * мимо общего замка операций над конфигурацией: фоновая синхронизация после подключения
 * хранилища, обновление перед помещением и сами команды хранилища могли поднять второй
 * процесс Конфигуратора параллельно ручному импорту. Проверяются ветки занятости и
 * освобождение замка — без процесса 1С.
 */
suite('Команды хранилища под общим замком операций над конфигурацией', () => {
  let root: string;
  let logLines: string[];
  let outputChannel: vscode.OutputChannel;
  let target: RepositoryTarget;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repository-lock-'));
    logLines = [];
    outputChannel = { appendLine: (line: string) => logLines.push(line) } as unknown as vscode.OutputChannel;
    target = { configRoot: path.join(root, 'src', 'cf'), configKind: 'cf', displayName: 'Основная' };
  });

  teardown(async () => {
    if (isConfigurationOperationRunning()) {
      await endConfigurationOperation();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** env.json читается первым шагом команды: исключение здесь доказывает, что команда стартовала. */
  function cliServices(): Parameters<typeof runRepositoryCliCommand>[1] {
    return {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'w', index: 0 },
      outputChannel,
      repositoryService: {
        getEnvJsonPath: () => {
          throw new Error('команда дошла до чтения env.json');
        },
      } as unknown as RepositoryService,
      projectSecretStorage: {} as ProjectSecretStorage,
    };
  }

  const CLI_OPTIONS = {
    command: 'repository-report',
    target: undefined as unknown as RepositoryTarget,
    progressTitle: 'Отчёт по хранилищу',
    successMessage: 'готово',
    errorTitle: 'Ошибка отчёта',
  } as unknown as Parameters<typeof runRepositoryCliCommand>[0];

  test('команда хранилища при занятом замке не запускается и сообщает о занятости', async () => {
    assert.ok(await tryBeginConfigurationOperation());

    assert.strictEqual(await runRepositoryCliCommand({ ...CLI_OPTIONS, target }, cliServices()), false);

    assert.ok(logLines.some((line) => line.startsWith('[repository][busy] Отчёт по хранилищу')), logLines.join(' | '));
    assert.ok(isConfigurationOperationRunning(), 'чужой замок не освобождается');
  });

  test('команда хранилища занимает замок на время работы и освобождает его при исключении', async () => {
    await assert.rejects(runRepositoryCliCommand({ ...CLI_OPTIONS, target }, cliServices()), /дошла до чтения env\.json/);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  function syncServices(changedRootPaths: readonly string[] = []): Parameters<typeof ensureTargetUpdatedBeforeCommit>[1]
    & Parameters<typeof runPostRepositorySync>[1] {
    return {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'w', index: 0 },
      outputChannel,
      getChangedConfigurations: () => changedRootPaths.map((rootPath) => ({ rootPath, name: 'Основная', changedFilesCount: 1 })),
      markConfigurationsClean: () => undefined,
      reloadEntries: () => Promise.resolve(),
      treeProvider: { refresh: () => undefined },
      refreshActionsView: () => undefined,
    } as unknown as Parameters<typeof ensureTargetUpdatedBeforeCommit>[1] & Parameters<typeof runPostRepositorySync>[1];
  }

  test('синхронизация после подключения при занятом замке пропускается с записью в журнал', async () => {
    assert.ok(await tryBeginConfigurationOperation());

    await runPostRepositorySync(target, syncServices());

    assert.ok(logLines.some((line) => line.startsWith('[repository][post-sync][busy] "Основная"')), logLines.join(' | '));
    assert.ok(isConfigurationOperationRunning(), 'чужой замок не освобождается');
  });

  test('синхронизация после подключения освобождает замок и при неудаче цепочки', async () => {
    await runPostRepositorySync(target, syncServices());

    assert.strictEqual(isConfigurationOperationRunning(), false);
    assert.ok(!logLines.some((line) => line.includes('[post-sync][busy]')));
  });

  test('помещение без локальных изменений не требует обновления базы и замка', async () => {
    assert.ok(await tryBeginConfigurationOperation());
    assert.strictEqual(await ensureTargetUpdatedBeforeCommit(target, syncServices()), true);
  });

  test('обновление перед помещением при занятом замке отбивается до выбора пользователя', async () => {
    assert.ok(await tryBeginConfigurationOperation());
    // QuickPick при занятом замке не показывается: иначе вызов ждал бы выбора и тест повис бы.
    assert.strictEqual(await ensureTargetUpdatedBeforeCommit(target, syncServices([target.configRoot])), false);
    assert.ok(isConfigurationOperationRunning(), 'чужой замок не освобождается');
  });
});
