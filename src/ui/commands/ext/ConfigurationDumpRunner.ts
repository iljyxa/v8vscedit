import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ConfigurationDumpHandle, ConfigurationDumpRequest } from '../../../infra/agent';
import { collectAllRelativeFiles } from '../../../infra/agent/DirectorySnapshot';
import { configurationProcessPort, isAgentConfigurationOperationMode } from './ExtensionCommandRunner';

export interface ConfigurationDumpTarget {
  readonly kind: 'cf' | 'cfe';
  readonly name: string;
  readonly rootPath: string;
  readonly extensionName?: string;
}

export type ConfigurationDumpResult =
  | { ok: true; handle: ConfigurationDumpHandle }
  | { ok: false; reason: string };

/** Значение `-Mode` внутреннего CLI `export-configuration` для каждого вида выгрузки. */
const EXPORT_CLI_MODE: Readonly<Record<ConfigurationDumpRequest['mode'], string>> = {
  partial: 'Partial',
  'update-info': 'UpdateInfo',
  full: 'Full',
};

/** Аргументы `export-configuration` для выгрузки во временный каталог (пакетный режим). */
export function buildExportToTempCliArgs(
  target: ConfigurationDumpTarget,
  request: ConfigurationDumpRequest,
  tempDir: string,
  projectRoot: string,
  connectionArgs: readonly string[]
): string[] {
  return [
    'export-configuration',
    '-ProjectRoot', projectRoot,
    '-Target', target.kind,
    '-ConfigDir', tempDir,
    '-Mode', EXPORT_CLI_MODE[request.mode],
    ...(request.mode === 'partial' ? ['-Objects', request.fullNames.join(',')] : []),
    ...(target.kind === 'cfe' && target.extensionName ? ['-Extension', target.extensionName] : []),
    ...connectionArgs,
  ];
}

/**
 * Выгружает конфигурацию/расширение из базы во временный каталог, не трогая проект.
 * Режим (агент/пакетный) — как у полного импорта. Модальных сообщений об ошибке
 * здесь нет: вызов идёт внутри аренды guard'а, исход сообщает вызывающая сторона.
 */
/* c8 ignore start -- запуск Конфигуратора/агента: внешний процесс 1С недоступен в тестовом окружении;
   аргументы процесса покрыты тестом buildExportToTempCliArgs, слияние результата — тестами infra/repository. */
export async function dumpConfigurationToTemp(
  target: ConfigurationDumpTarget,
  request: ConfigurationDumpRequest,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<ConfigurationDumpResult> {
  const title = `Выгрузка «${target.name}» из базы во временный каталог`;
  if (isAgentConfigurationOperationMode()) {
    let handle: ConfigurationDumpHandle | undefined;
    const ok = await configurationProcessPort.runAgentConfigurationOperation(
      {
        progressTitle: title,
        progressStartMessage: 'Выгрузка через агент конфигуратора...',
        successMessage: `Выгрузка «${target.name}» завершена.`,
        errorTitle: `Ошибка выгрузки «${target.name}» из базы.`,
        showSuccessMessage: false,
        workspaceFolder,
        outputChannel,
        rootPath: target.rootPath,
      },
      async (service, hooks) => {
        handle = await service.dumpToDirectory(
          { kind: target.kind, name: target.name, rootPath: target.rootPath, extensionName: target.extensionName },
          request,
          hooks
        );
      }
    );
    return ok && handle
      ? { ok: true, handle }
      : { ok: false, reason: 'выгрузка через агент конфигуратора не выполнена, подробности — в журнале' };
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  let tempRoot: string | undefined;
  try {
    const settingsPath = configurationProcessPort.resolveSettingsPath(workspaceRoot, target.rootPath);
    const connection = await configurationProcessPort.resolveConnectionFromSettings(settingsPath);
    tempRoot = configurationProcessPort.createWorkspaceTempDir(workspaceRoot, 'repository-dump-');
    const tempConfigDir = path.join(tempRoot, target.kind);
    fs.mkdirSync(tempConfigDir, { recursive: true });
    let failureReason = '';
    const ok = await configurationProcessPort.runInternalCliCommand(
      {
        cliArgs: buildExportToTempCliArgs(
          target,
          request,
          tempConfigDir,
          workspaceRoot,
          configurationProcessPort.buildConnectionCliArgs(connection)
        ),
        progressTitle: title,
        progressStartMessage: 'Выгрузка из базы во временный каталог...',
        successMessage: `Выгрузка «${target.name}» завершена.`,
        errorTitle: `Ошибка выгрузки «${target.name}» из базы.`,
        failureOperation: 'выгрузке из базы во временный каталог',
        logPrefix: 'export-configuration',
        showSuccessMessage: false,
        showErrorMessage: false,
        onFailureReason: (reason) => { failureReason = reason; },
      },
      workspaceFolder,
      outputChannel
    );
    if (!ok) {
      configurationProcessPort.removeTempDir(tempRoot, outputChannel);
      return { ok: false, reason: failureReason || 'выгрузка прервана' };
    }
    const root = tempRoot;
    return {
      ok: true,
      handle: {
        dir: tempConfigDir,
        relativeFiles: collectAllRelativeFiles(tempConfigDir),
        dispose: () => configurationProcessPort.removeTempDir(root, outputChannel),
      },
    };
  } catch (error) {
    if (tempRoot) {
      configurationProcessPort.removeTempDir(tempRoot, outputChannel);
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
/* c8 ignore stop */
