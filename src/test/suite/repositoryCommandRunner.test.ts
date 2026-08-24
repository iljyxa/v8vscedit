import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  maybeRestoreLockSnapshot,
  maybeRestoreLockSnapshotForFullNames,
  type RepositoryCliServices,
} from '../../ui/commands/repository/RepositoryCommandRunner';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/** Фейковый SecretStore на Map — структурный контракт vscode.SecretStorage, не используется этими тестами. */
function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

/**
 * `maybeRestoreLockSnapshot` работает поверх `RepositoryService`, для которого не нужны
 * реальные XML-фикстуры 1С (`example/`) — путь к объекту резолвится по `node.label`,
 * поэтому здесь достаточно самодостаточного временного каталога.
 */
suite('RepositoryCommandRunner — maybeRestoreLockSnapshot (issue #2)', () => {
  let workspaceRoot: string;
  let repositoryService: RepositoryService;
  let target: RepositoryTarget;
  let node: RepositoryNodeRef;
  let objectXmlPath: string;
  let services: RepositoryCliServices;

  let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
  let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
  const windowRef = vscode.window as {
    showWarningMessage: typeof vscode.window.showWarningMessage;
    showInformationMessage: typeof vscode.window.showInformationMessage;
  };

  let warningCalls: unknown[][];
  let warningResolution: string | undefined;
  let infoCalls: unknown[][];
  let outputLines: string[];

  setup(() => {
    workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repo-runner-')));
    repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
    target = { configRoot: workspaceRoot, configKind: 'cf', displayName: 'Тестовая конфигурация' };

    objectXmlPath = path.join(workspaceRoot, 'Catalogs', 'ТестовыйСправочник.xml');
    fs.mkdirSync(path.dirname(objectXmlPath), { recursive: true });
    fs.writeFileSync(objectXmlPath, '<Catalog>исходное содержимое</Catalog>\n', 'utf-8');
    node = { nodeKind: 'Catalog', label: 'ТестовыйСправочник', xmlPath: objectXmlPath };

    warningCalls = [];
    warningResolution = undefined;
    infoCalls = [];
    outputLines = [];

    originalShowWarningMessage = vscode.window.showWarningMessage;
    originalShowInformationMessage = vscode.window.showInformationMessage;
    windowRef.showWarningMessage = ((message: string, ...rest: unknown[]) => {
      warningCalls.push([message, ...rest]);
      return Promise.resolve(warningResolution);
    });
    windowRef.showInformationMessage = ((message: string, ...rest: unknown[]) => {
      infoCalls.push([message, ...rest]);
      return Promise.resolve(undefined);
    });

    services = {
      workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
      outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
      repositoryService,
      projectSecretStorage: {} as unknown as ProjectSecretStorage,
    };
  });

  teardown(() => {
    windowRef.showWarningMessage = originalShowWarningMessage;
    windowRef.showInformationMessage = originalShowInformationMessage;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('Без предварительного захвата (нет снапшота) — диалог не показывается', async () => {
    await maybeRestoreLockSnapshot(services, target, node);
    assert.deepStrictEqual(warningCalls, []);
    assert.deepStrictEqual(infoCalls, []);
  });

  test('Файл не менялся после захвата — снапшот тихо удаляется без диалога', async () => {
    repositoryService.captureLockSnapshot(target, node);

    await maybeRestoreLockSnapshot(services, target, node);

    assert.deepStrictEqual(warningCalls, []);
    assert.strictEqual(repositoryService.getLockSnapshotDiff(target, node).hasSnapshot, false);
  });

  test('Пользователь выбирает откат — файл возвращается к состоянию на момент захвата', async () => {
    const originalContent = fs.readFileSync(objectXmlPath, 'utf-8');
    repositoryService.captureLockSnapshot(target, node);

    fs.writeFileSync(objectXmlPath, `${originalContent}<!-- правка после захвата -->\n`, 'utf-8');
    warningResolution = 'Откатить изменения';

    await maybeRestoreLockSnapshot(services, target, node);

    assert.strictEqual(warningCalls.length, 1);
    assert.strictEqual(fs.readFileSync(objectXmlPath, 'utf-8'), originalContent);
    assert.strictEqual(infoCalls.length, 1);
    assert.ok(outputLines.some((line) => line.includes('Откат файлов')));
    assert.strictEqual(repositoryService.getLockSnapshotDiff(target, node).hasSnapshot, false);
  });

  test('Пользователь оставляет изменения — файл не трогается, снапшот удаляется', async () => {
    const originalContent = fs.readFileSync(objectXmlPath, 'utf-8');
    repositoryService.captureLockSnapshot(target, node);

    const editedContent = `${originalContent}<!-- изменения оставлены -->\n`;
    fs.writeFileSync(objectXmlPath, editedContent, 'utf-8');
    warningResolution = 'Оставить изменения';

    await maybeRestoreLockSnapshot(services, target, node);

    assert.strictEqual(warningCalls.length, 1);
    assert.strictEqual(fs.readFileSync(objectXmlPath, 'utf-8'), editedContent);
    assert.deepStrictEqual(infoCalls, []);
    assert.strictEqual(repositoryService.getLockSnapshotDiff(target, node).hasSnapshot, false);
  });

  test('Пользователь закрывает диалог без выбора — трактуется как «оставить», снапшот всё равно удаляется', async () => {
    const originalContent = fs.readFileSync(objectXmlPath, 'utf-8');
    repositoryService.captureLockSnapshot(target, node);

    const editedContent = `${originalContent}<!-- диалог закрыт -->\n`;
    fs.writeFileSync(objectXmlPath, editedContent, 'utf-8');
    warningResolution = undefined;

    await maybeRestoreLockSnapshot(services, target, node);

    assert.strictEqual(fs.readFileSync(objectXmlPath, 'utf-8'), editedContent);
    assert.deepStrictEqual(infoCalls, []);
    assert.strictEqual(repositoryService.getLockSnapshotDiff(target, node).hasSnapshot, false);
  });

  suite('maybeRestoreLockSnapshotForFullNames — рекурсивный захват Подсистемы с несколькими участниками', () => {
    let secondXmlPath: string;
    const firstFullName = 'Справочник.ТестовыйСправочник';
    const secondFullName = 'Справочник.ВторойУчастник';

    setup(() => {
      secondXmlPath = path.join(workspaceRoot, 'Catalogs', 'ВторойУчастник.xml');
      fs.writeFileSync(secondXmlPath, '<Catalog>исходное содержимое участника 2</Catalog>\n', 'utf-8');
    });

    test('Ни у одного участника нет снапшота — диалог не показывается', async () => {
      await maybeRestoreLockSnapshotForFullNames(services, target, [firstFullName, secondFullName], 'Продажи');
      assert.deepStrictEqual(warningCalls, []);
    });

    test('Ни один участник не менялся — снапшоты тихо удаляются без диалога', async () => {
      repositoryService.captureLockSnapshotForFullName(target, firstFullName, objectXmlPath);
      repositoryService.captureLockSnapshotForFullName(target, secondFullName, secondXmlPath);

      await maybeRestoreLockSnapshotForFullNames(services, target, [firstFullName, secondFullName], 'Продажи');

      assert.deepStrictEqual(warningCalls, []);
      assert.strictEqual(repositoryService.getLockSnapshotDiffForFullName(target, firstFullName).hasSnapshot, false);
      assert.strictEqual(repositoryService.getLockSnapshotDiffForFullName(target, secondFullName).hasSnapshot, false);
    });

    test('Изменён только один из двух участников — откат восстанавливает его и снимает оба снапшота', async () => {
      const firstOriginal = fs.readFileSync(objectXmlPath, 'utf-8');
      const secondOriginal = fs.readFileSync(secondXmlPath, 'utf-8');
      repositoryService.captureLockSnapshotForFullName(target, firstFullName, objectXmlPath);
      repositoryService.captureLockSnapshotForFullName(target, secondFullName, secondXmlPath);

      fs.writeFileSync(objectXmlPath, `${firstOriginal}<!-- правка первого -->\n`, 'utf-8');
      warningResolution = 'Откатить изменения';

      await maybeRestoreLockSnapshotForFullNames(services, target, [firstFullName, secondFullName], 'Продажи');

      assert.strictEqual(warningCalls.length, 1);
      assert.ok(String(warningCalls[0][0]).includes('1 объект'), 'В сообщении должно фигурировать число изменённых объектов (1), а не всех переданных (2).');
      assert.strictEqual(fs.readFileSync(objectXmlPath, 'utf-8'), firstOriginal);
      assert.strictEqual(fs.readFileSync(secondXmlPath, 'utf-8'), secondOriginal, 'Неизменённый участник не должен трогаться восстановлением.');
      assert.strictEqual(infoCalls.length, 1);
      assert.strictEqual(repositoryService.getLockSnapshotDiffForFullName(target, firstFullName).hasSnapshot, false);
      assert.strictEqual(repositoryService.getLockSnapshotDiffForFullName(target, secondFullName).hasSnapshot, false);
    });

    test('Пользователь оставляет изменения обоих участников — файлы не трогаются, снапшоты снимаются', async () => {
      const firstOriginal = fs.readFileSync(objectXmlPath, 'utf-8');
      repositoryService.captureLockSnapshotForFullName(target, firstFullName, objectXmlPath);
      repositoryService.captureLockSnapshotForFullName(target, secondFullName, secondXmlPath);

      const firstEdited = `${firstOriginal}<!-- правка -->\n`;
      const secondEdited = `${fs.readFileSync(secondXmlPath, 'utf-8')}<!-- правка -->\n`;
      fs.writeFileSync(objectXmlPath, firstEdited, 'utf-8');
      fs.writeFileSync(secondXmlPath, secondEdited, 'utf-8');
      warningResolution = 'Оставить изменения';

      await maybeRestoreLockSnapshotForFullNames(services, target, [firstFullName, secondFullName], 'Продажи');

      assert.strictEqual(warningCalls.length, 1);
      assert.ok(String(warningCalls[0][0]).includes('2 объект'));
      assert.strictEqual(fs.readFileSync(objectXmlPath, 'utf-8'), firstEdited);
      assert.strictEqual(fs.readFileSync(secondXmlPath, 'utf-8'), secondEdited);
      assert.deepStrictEqual(infoCalls, []);
      assert.strictEqual(repositoryService.getLockSnapshotDiffForFullName(target, firstFullName).hasSnapshot, false);
      assert.strictEqual(repositoryService.getLockSnapshotDiffForFullName(target, secondFullName).hasSnapshot, false);
    });
  });
});
