import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { buildRepositoryScopeKey } from '../../infra/repository/RepositoryLockState';
import { RepositoryService, type RepositoryBinding } from '../../infra/repository/RepositoryService';
import { resolveDesignerRepositoryBinding, runDbClientFromWorkspace } from '../../ui/commands/db/DbRunCommandRunner';
import { createArgsRecordingDesigner, type ArgsRecordingDesigner } from './support/argsRecordingDesigner';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_CFE = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

function createSecrets(workspaceRoot: string): ProjectSecretStorage {
  const map = new Map<string, string>();
  return new ProjectSecretStorage({
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  }, workspaceRoot);
}

function writeEnvJson(workspaceRoot: string, defaults: Record<string, unknown>): void {
  fs.writeFileSync(path.join(workspaceRoot, 'env.json'), JSON.stringify({ default: defaults }), 'utf-8');
}

/**
 * Issue #8: если основная конфигурация подключена к хранилищу, интерактивный
 * конфигуратор запускается с параметрами хранилища, чтобы пользователь не
 * вводил их вручную.
 */
suite('Запуск конфигуратора с параметрами хранилища (issue #8)', () => {
  let workspaceRoot: string;
  let secrets: ProjectSecretStorage;
  let repositoryService: RepositoryService;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-designer-repo-'));
    secrets = createSecrets(workspaceRoot);
    repositoryService = new RepositoryService(workspaceRoot, secrets);
  });

  teardown(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  suite('resolveDesignerRepositoryBinding', () => {
    function cfTarget() {
      const target = repositoryService.resolveTargetByConfigRoot(EXAMPLE_CF);
      assert.ok(target);
      return target;
    }

    test('cf подключена к хранилищу — привязка с паролем из SecretStorage', async () => {
      writeEnvJson(workspaceRoot, { '--repo-path': '/srv/хранилище', '--repo-user': 'Разработчик' });
      await secrets.setRepoPassword(buildRepositoryScopeKey(cfTarget()), 'секрет');
      repositoryService.setConnected(cfTarget(), true);

      const binding = await resolveDesignerRepositoryBinding(repositoryService, [{ kind: 'cf', rootPath: EXAMPLE_CF }]);

      assert.deepStrictEqual(binding, { repoPath: '/srv/хранилище', repoUser: 'Разработчик', repoPassword: 'секрет' });
    });

    test('привязка cf есть, но подключение не установлено — параметры не передаются', async () => {
      writeEnvJson(workspaceRoot, { '--repo-path': '/srv/хранилище', '--repo-user': 'Разработчик' });
      repositoryService.setConnected(cfTarget(), false);

      const binding = await resolveDesignerRepositoryBinding(repositoryService, [{ kind: 'cf', rootPath: EXAMPLE_CF }]);

      assert.strictEqual(binding, null);
    });

    test('привязки cf нет — параметры не передаются', async () => {
      writeEnvJson(workspaceRoot, {});
      repositoryService.setConnected(cfTarget(), true);

      const binding = await resolveDesignerRepositoryBinding(repositoryService, [{ kind: 'cf', rootPath: EXAMPLE_CF }]);

      assert.strictEqual(binding, null);
    });

    test('подключено только расширение — хранилище расширения конфигуратору не передаётся', async () => {
      writeEnvJson(workspaceRoot, { extension: { EVOLC: { 'repo-path': '/srv/хранилище-расширения', 'repo-user': 'Разработчик' } } });
      const cfeTarget = repositoryService.resolveTargetByConfigRoot(EXAMPLE_CFE);
      assert.ok(cfeTarget);
      repositoryService.setConnected(cfeTarget, true);

      const binding = await resolveDesignerRepositoryBinding(repositoryService, [
        { kind: 'cfe', rootPath: EXAMPLE_CFE },
        { kind: 'cf', rootPath: EXAMPLE_CF },
      ]);

      assert.strictEqual(binding, null);
    });

    test('корень без Configuration.xml пропускается, берётся следующая подключённая cf', async () => {
      writeEnvJson(workspaceRoot, { '--repo-path': '/srv/хранилище', '--repo-user': 'Разработчик' });
      repositoryService.setConnected(cfTarget(), true);

      const binding = await resolveDesignerRepositoryBinding(repositoryService, [
        { kind: 'cf', rootPath: path.join(workspaceRoot, 'нет-выгрузки') },
        { kind: 'cf', rootPath: EXAMPLE_CF },
      ]);

      assert.deepStrictEqual(binding, { repoPath: '/srv/хранилище', repoUser: 'Разработчик', repoPassword: '' });
    });
  });

  suite('runDbClientFromWorkspace — командная строка запуска', () => {
    let designer: ArgsRecordingDesigner;
    let outputLines: string[];
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    const infoBasePath = '/tmp/v8-designer-repo-база';

    suiteSetup(function () {
      if (process.platform === 'win32') {
        // Процесс-заглушка — shell-скрипт; на Windows запускать нечем.
        this.skip();
      }
    });

    setup(() => {
      designer = createArgsRecordingDesigner(workspaceRoot);
      writeEnvJson(workspaceRoot, {
        '--ibconnection': `/F${infoBasePath}`,
        '--db-user': 'Админ',
        '--db-pwd': 'пароль-базы',
        '--path': designer.executablePath,
      });
      outputLines = [];
      originalShowInformationMessage = vscode.window.showInformationMessage;
      (vscode.window as Pick<typeof vscode.window, 'showInformationMessage'>).showInformationMessage =
        () => Promise.resolve(undefined);
    });

    teardown(() => {
      (vscode.window as Pick<typeof vscode.window, 'showInformationMessage'>).showInformationMessage = originalShowInformationMessage;
    });

    async function launch(mode: 'DESIGNER' | 'ENTERPRISE', repository: RepositoryBinding | null): Promise<string[]> {
      await runDbClientFromWorkspace(
        { uri: vscode.Uri.file(workspaceRoot), name: 'designer-repo', index: 0 },
        { appendLine: (line: string) => { outputLines.push(line); } } as unknown as vscode.OutputChannel,
        secrets,
        { mode, repository }
      );
      return designer.waitForArgs();
    }

    function launchLogLine(): string {
      const line = outputLines.find((item) => item.startsWith('[db-run] Запуск:'));
      assert.ok(line, outputLines.join('\n'));
      return line;
    }

    test('конфигуратор получает путь, пользователя и пароль хранилища; пароли в лог не попадают', async () => {
      const args = await launch('DESIGNER', { repoPath: '/srv/хранилище', repoUser: 'Разработчик', repoPassword: 'пароль-хранилища' });

      assert.deepStrictEqual(args, [
        'DESIGNER', '/F', infoBasePath, '/NАдмин', '/Pпароль-базы',
        '/ConfigurationRepositoryF', '/srv/хранилище',
        '/ConfigurationRepositoryN', 'Разработчик',
        '/ConfigurationRepositoryP', 'пароль-хранилища',
      ]);
      const logLine = launchLogLine();
      assert.ok(logLine.endsWith(
        `DESIGNER /F ${infoBasePath} /NАдмин /P*** /ConfigurationRepositoryF /srv/хранилище /ConfigurationRepositoryN Разработчик /ConfigurationRepositoryP ***`
      ), logLine);
    });

    test('без сохранённого пароля хранилища параметр /ConfigurationRepositoryP не передаётся', async () => {
      const args = await launch('DESIGNER', { repoPath: '/srv/хранилище', repoUser: 'Разработчик', repoPassword: '' });

      assert.deepStrictEqual(args.slice(5), ['/ConfigurationRepositoryF', '/srv/хранилище', '/ConfigurationRepositoryN', 'Разработчик']);
      assert.ok(!launchLogLine().includes('/ConfigurationRepositoryP'));
    });

    test('без подключения к хранилищу конфигуратор запускается только с параметрами базы', async () => {
      const args = await launch('DESIGNER', null);

      assert.deepStrictEqual(args, ['DESIGNER', '/F', infoBasePath, '/NАдмин', '/Pпароль-базы']);
    });

    test('тонкий клиент параметры хранилища не получает', async () => {
      const args = await launch('ENTERPRISE', { repoPath: '/srv/хранилище', repoUser: 'Разработчик', repoPassword: 'пароль-хранилища' });

      assert.deepStrictEqual(args, ['ENTERPRISE', '/F', infoBasePath, '/NАдмин', '/Pпароль-базы']);
    });
  });
});
