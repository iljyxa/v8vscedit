import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { buildMergeBackupDir } from '../../infra/repository/RepositoryMergeApplier';
import { RepositoryService } from '../../infra/repository/RepositoryService';
import {
  DEFAULT_MERGE_BACKUP_RETENTION,
  disposeOnError,
  disposeOnErrorAsync,
  getRepositoryMergeRoot,
  getRepositoryObjectsDir,
  pruneMergeBackups,
  pruneRepositoryObjectsFiles,
} from '../../infra/repository/RepositoryTempCleanup';

/**
 * Issue #64 — раскладка и очистка временных артефактов хранилища
 * (`.v8vscedit/repository/objects`, `.v8vscedit/repository/merge`). Каталоги и файлы —
 * собственные служебные артефакты расширения во временной рабочей области, их формат
 * имён задают `createObjectsFileForNode` и `buildMergeBackupDir`.
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const NOW = new Date('2024-01-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

const createdWorkspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-temp-cleanup-'));
  createdWorkspaces.push(dir);
  return dir;
}

// Тесты про накопление временных файлов сами не должны их оставлять.
teardown(() => {
  createdWorkspaces.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

/** Каталог бэкапа в формате `buildMergeBackupDir` — единственный источник формата имени. */
function makeBackup(workspaceRoot: string, scope: string, at: Date, label = 'lock'): string {
  const dir = buildMergeBackupDir(workspaceRoot, scope, label, at);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Configuration.xml'), 'копия', 'utf-8');
  return dir;
}

function writeFile(filePath: string, content = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

suite('RepositoryTempCleanup — раскладка каталогов (issue #64)', () => {
  test('objects/ и merge/ лежат под .v8vscedit/repository рабочей области', () => {
    const root = path.join(os.tmpdir(), 'ws');
    assert.strictEqual(getRepositoryObjectsDir(root), path.join(root, '.v8vscedit', 'repository', 'objects'));
    assert.strictEqual(getRepositoryMergeRoot(root), path.join(root, '.v8vscedit', 'repository', 'merge'));
  });

  test('createObjectsFileForNode пишет файл в getRepositoryObjectsDir, buildMergeBackupDir — под getRepositoryMergeRoot', () => {
    const workspaceRoot = makeWorkspace();
    const configRoot = path.join(workspaceRoot, 'src', 'cf');
    fs.cpSync(EXAMPLE_CF, configRoot, { recursive: true });
    const service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));

    const objects = service.createObjectsFileForNode(
      { nodeKind: 'Catalog', label: 'Валюты', xmlPath: path.join(configRoot, 'Catalogs', 'Валюты.xml') },
      false
    );

    assert.strictEqual(path.dirname(objects.filePath), getRepositoryObjectsDir(workspaceRoot));
    assert.ok(fs.existsSync(objects.filePath));
    assert.strictEqual(
      path.dirname(path.dirname(buildMergeBackupDir(workspaceRoot, 'scope', 'lock', NOW))),
      getRepositoryMergeRoot(workspaceRoot)
    );
  });
});

suite('RepositoryTempCleanup — pruneRepositoryObjectsFiles', () => {
  test('каталога objects/ нет — пустой результат', () => {
    assert.deepStrictEqual(pruneRepositoryObjectsFiles(makeWorkspace()), []);
  });

  test('удаляются только обычные *.xml: note.txt и подкаталог с именем *.xml остаются', () => {
    const workspaceRoot = makeWorkspace();
    const dir = getRepositoryObjectsDir(workspaceRoot);
    const first = path.join(dir, `${'a'.repeat(40)}-1.xml`);
    const second = path.join(dir, `${'b'.repeat(40)}-2.XML`);
    writeFile(first, '<Objects/>');
    writeFile(second, '<Objects/>');
    writeFile(path.join(dir, 'note.txt'), 'заметка');
    fs.mkdirSync(path.join(dir, 'x.xml'));

    const removed = pruneRepositoryObjectsFiles(workspaceRoot);

    assert.deepStrictEqual([...removed].sort(), [first, second].sort());
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['note.txt', 'x.xml']);
  });

  test('objects — обычный файл: ошибка чтения каталога пробрасывается', () => {
    const workspaceRoot = makeWorkspace();
    writeFile(getRepositoryObjectsDir(workspaceRoot), 'не каталог');
    assert.throws(() => pruneRepositoryObjectsFiles(workspaceRoot), /ENOTDIR/);
  });
});

suite('RepositoryTempCleanup — pruneMergeBackups', () => {
  test('каталога merge/ нет — пустой результат', () => {
    assert.deepStrictEqual(pruneMergeBackups(makeWorkspace(), NOW), []);
  });

  test('файлы на уровне корня и scope, неразборчивые имена и метки из будущего не трогаются', () => {
    const workspaceRoot = makeWorkspace();
    const mergeRoot = getRepositoryMergeRoot(workspaceRoot);
    const scopeDir = path.join(mergeRoot, 'scopeA');
    writeFile(path.join(mergeRoot, 'readme.txt'));
    writeFile(path.join(scopeDir, '2023-01-01T00-00-00-000Z-lock'));
    fs.mkdirSync(path.join(scopeDir, 'foo'), { recursive: true });
    fs.mkdirSync(path.join(scopeDir, '2023-13-45T00-00-00-000Z-lock'), { recursive: true });
    fs.mkdirSync(path.join(scopeDir, '2023-01-01T00-00-00-000Z'), { recursive: true });
    const future = makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() + HOUR));

    assert.deepStrictEqual(pruneMergeBackups(workspaceRoot, NOW), []);
    assert.ok(fs.existsSync(path.join(mergeRoot, 'readme.txt')));
    assert.ok(fs.existsSync(path.join(scopeDir, '2023-01-01T00-00-00-000Z-lock')));
    assert.ok(fs.existsSync(path.join(scopeDir, 'foo')));
    assert.ok(fs.existsSync(path.join(scopeDir, '2023-13-45T00-00-00-000Z-lock')));
    assert.ok(fs.existsSync(path.join(scopeDir, '2023-01-01T00-00-00-000Z')));
    assert.ok(fs.existsSync(future));
  });

  test('возраст: старше 7 дней удаляется, 6 дней и ровно maxAgeMs остаются', () => {
    const workspaceRoot = makeWorkspace();
    const old = makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() - 8 * DAY));
    const fresh = makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() - 6 * DAY));
    const boundary = makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() - DEFAULT_MERGE_BACKUP_RETENTION.maxAgeMs), 'update');

    assert.deepStrictEqual(pruneMergeBackups(workspaceRoot, NOW), [old]);
    assert.ok(!fs.existsSync(old));
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(boundary));
  });

  test('лимит на scope: из 22 свежих в A удаляются 2 самых старых, единственный в B не тронут', () => {
    const workspaceRoot = makeWorkspace();
    const scopeA = Array.from({ length: 22 }, (_, index) => makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() - (index + 1) * 60_000)));
    const scopeB = makeBackup(workspaceRoot, 'scopeB', new Date(NOW.getTime() - 22 * 60_000));

    const removed = pruneMergeBackups(workspaceRoot, NOW);

    assert.deepStrictEqual(removed, [scopeA[20], scopeA[21]]);
    scopeA.slice(0, 20).forEach((dir) => assert.ok(fs.existsSync(dir), dir));
    assert.ok(fs.existsSync(scopeB));
  });

  test('опустевший scope удаляется, непустой остаётся', () => {
    const workspaceRoot = makeWorkspace();
    const mergeRoot = getRepositoryMergeRoot(workspaceRoot);
    makeBackup(workspaceRoot, 'emptied', new Date(NOW.getTime() - 8 * DAY));
    makeBackup(workspaceRoot, 'kept', new Date(NOW.getTime() - 8 * DAY));
    makeBackup(workspaceRoot, 'kept', new Date(NOW.getTime() - HOUR));

    pruneMergeBackups(workspaceRoot, NOW);

    assert.deepStrictEqual(fs.readdirSync(mergeRoot), ['kept']);
    assert.strictEqual(fs.readdirSync(path.join(mergeRoot, 'kept')).length, 1);
  });

  test('собственная политика {maxAgeMs: 1ч, maxPerScope: 1}', () => {
    const workspaceRoot = makeWorkspace();
    const newest = makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() - 10 * 60_000));
    const second = makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() - 20 * 60_000));
    const tooOld = makeBackup(workspaceRoot, 'scopeB', new Date(NOW.getTime() - 2 * HOUR));

    const removed = pruneMergeBackups(workspaceRoot, NOW, { maxAgeMs: HOUR, maxPerScope: 1 });

    assert.deepStrictEqual([...removed].sort(), [second, tooOld].sort());
    assert.ok(fs.existsSync(newest));
  });

  for (const label of ['lock', 'update', 'unlock']) {
    test(`сквозной формат buildMergeBackupDir, метка "${label}": 8 дней — удалён, 1 час — остаётся`, () => {
      const workspaceRoot = makeWorkspace();
      const old = makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() - 8 * DAY), label);
      const fresh = makeBackup(workspaceRoot, 'scopeA', new Date(NOW.getTime() - HOUR), label);

      assert.deepStrictEqual(pruneMergeBackups(workspaceRoot, NOW), [old]);
      assert.ok(fs.existsSync(fresh));
    });
  }

  test('merge — обычный файл: ошибка пробрасывается', () => {
    const workspaceRoot = makeWorkspace();
    writeFile(getRepositoryMergeRoot(workspaceRoot), 'не каталог');
    assert.throws(() => pruneMergeBackups(workspaceRoot, NOW), /ENOTDIR/);
  });
});

suite('RepositoryTempCleanup — disposeOnError / disposeOnErrorAsync', () => {
  function counter(): { dispose(): void; readonly calls: number } {
    let calls = 0;
    return { dispose: () => { calls += 1; }, get calls() { return calls; } };
  }

  test('disposeOnError: успех — результат тела, dispose не вызывается', () => {
    const resource = counter();
    assert.strictEqual(disposeOnError(resource, () => 42), 42);
    assert.strictEqual(resource.calls, 0);
  });

  test('disposeOnError: исключение — dispose ровно один раз, наружу та же ошибка', () => {
    const resource = counter();
    const error = new Error('сбой');
    assert.throws(() => disposeOnError(resource, () => { throw error; }), (thrown) => thrown === error);
    assert.strictEqual(resource.calls, 1);
  });

  test('disposeOnErrorAsync: успех — результат тела, dispose не вызывается', async () => {
    const resource = counter();
    assert.strictEqual(await disposeOnErrorAsync(resource, () => Promise.resolve('ok')), 'ok');
    assert.strictEqual(resource.calls, 0);
  });

  test('disposeOnErrorAsync: reject — dispose ровно один раз, наружу та же ошибка', async () => {
    const resource = counter();
    const error = new Error('reject');
    await assert.rejects(disposeOnErrorAsync(resource, () => Promise.reject(error)), (thrown) => thrown === error);
    assert.strictEqual(resource.calls, 1);
  });

  test('disposeOnErrorAsync: синхронный throw внутри async-тела — dispose один раз', async () => {
    const resource = counter();
    const error = new Error('throw');
    // eslint-disable-next-line @typescript-eslint/require-await -- проверяется именно async-тело без await
    await assert.rejects(disposeOnErrorAsync(resource, async () => { throw error; }), (thrown) => thrown === error);
    assert.strictEqual(resource.calls, 1);
  });
});
