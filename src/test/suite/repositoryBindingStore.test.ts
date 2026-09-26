import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryBindingStore } from '../../infra/repository/RepositoryBindingStore';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/**
 * `RepositoryBindingStore` уже покрыт КОСВЕННО через `RepositoryService`
 * (`repositoryService.test.ts`/`repositoryServiceSecrets.test.ts`), но эти
 * наборы используют `configKind:'cfe'` только с ЯВНО заданным `extensionName` —
 * ветки `target.extensionName ?? ''` (cfe-цель без имени расширения) и форма
 * `env.default`, отличная от «обычного объекта» (`getDefaultSection`), там не
 * возникают. Прямой тест класса — контроль над этими граничными формами данных.
 */
function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

suite('RepositoryBindingStore — граничные ветки (issue #1)', () => {
  let workspaceRoot: string;
  let store: RepositoryBindingStore;
  let cfeTargetNoName: RepositoryTarget;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-binding-store-'));
    store = new RepositoryBindingStore(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
    cfeTargetNoName = { configRoot: path.join(workspaceRoot, 'src', 'cfe', 'Ext'), configKind: 'cfe', displayName: 'Расширение' };
  });

  teardown(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function writeEnvJson(content: Record<string, unknown>): void {
    fs.writeFileSync(store.getEnvJsonPath(), JSON.stringify(content, null, 2), 'utf-8');
  }

  function readEnvJson(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(store.getEnvJsonPath(), 'utf-8')) as Record<string, unknown>;
  }

  test('cfe-цель БЕЗ extensionName: saveBinding пишет секцию под ключом "" (fallback ??)', async () => {
    await store.saveBinding(cfeTargetNoName, { repoPath: '\\\\repo\\ext', repoUser: 'bob', repoPassword: 'x' });
    const env = readEnvJson();
    const defaults = env.default as Record<string, unknown>;
    const extension = defaults.extension as Record<string, unknown>;
    assert.deepStrictEqual(extension[''], { 'repo-path': '\\\\repo\\ext', 'repo-user': 'bob' });
  });

  test('cfe-цель БЕЗ extensionName: loadBinding читает ту же секцию "" и мигрирует legacy-пароль', async () => {
    writeEnvJson({ default: { extension: { '': { 'repo-path': '\\\\repo\\ext', 'repo-user': 'bob', 'repo-pwd': 'legacy' } } } });

    const loaded = await store.loadBinding(cfeTargetNoName);

    assert.deepStrictEqual(loaded, { repoPath: '\\\\repo\\ext', repoUser: 'bob' });
    assert.strictEqual(await store.hasStoredRepoPassword(cfeTargetNoName), true, 'legacy-пароль должен быть перенесён в SecretStorage.');
    const envAfter = readEnvJson();
    const item = ((envAfter.default as Record<string, unknown>).extension as Record<string, Record<string, unknown>>)[''];
    assert.strictEqual(item['repo-pwd'], undefined, 'legacy repo-pwd должен быть стёрт из env.json.');
  });

  test('cfe-цель БЕЗ extensionName: clearBinding удаляет секцию "" (fallback ??)', async () => {
    writeEnvJson({ default: { extension: { '': { 'repo-path': '\\\\repo\\ext', 'repo-user': 'bob' } } } });

    await store.clearBinding(cfeTargetNoName);

    assert.strictEqual(store.hasBinding(cfeTargetNoName), false);
  });

  test('repoUser отсутствует в env.json (не строка) → loadBinding отдаёт repoUser="" (readString ?? "")', async () => {
    const cfTarget: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    writeEnvJson({ default: { '--repo-path': '\\\\repo\\main', '--repo-user': 42 } });

    const loaded = await store.loadBinding(cfTarget);

    assert.deepStrictEqual(loaded, { repoPath: '\\\\repo\\main', repoUser: '' });
  });

  test('repoUser cfe-секции отсутствует (не строка) → loadBinding отдаёт repoUser="" (readString ?? "")', async () => {
    writeEnvJson({ default: { extension: { '': { 'repo-path': '\\\\repo\\ext', 'repo-user': null } } } });

    const loaded = await store.loadBinding(cfeTargetNoName);

    assert.deepStrictEqual(loaded, { repoPath: '\\\\repo\\ext', repoUser: '' });
  });

  test('env.default отсутствует (env.json = {}) → getDefaultSection отдаёт {} без ошибки, hasBinding=false', () => {
    writeEnvJson({});
    const cfTarget: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    assert.strictEqual(store.hasBinding(cfTarget), false);
  });

  test('env.default — массив (некорректная форма) → getDefaultSection отдаёт {} без ошибки', () => {
    writeEnvJson({ default: ['неожиданный массив'] });
    const cfTarget: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    assert.strictEqual(store.hasBinding(cfTarget), false);
  });

  test('saveBinding для одного расширения санирует ЧУЖИЕ записи секции extension без repo-path/repo-user (readString ?? "")', async () => {
    writeEnvJson({
      default: {
        extension: {
          'БезПользователя': { 'repo-path': '\\\\repo\\a' },
          'БезПути': { 'repo-user': 'carol' },
        },
      },
    });
    const targetB: RepositoryTarget = { configRoot: cfeTargetNoName.configRoot, configKind: 'cfe', extensionName: 'Б', displayName: 'Б' };

    await store.saveBinding(targetB, { repoPath: '\\\\repo\\b', repoUser: 'bob', repoPassword: 'x' });

    const extension = ((readEnvJson().default as Record<string, unknown>).extension) as Record<string, Record<string, unknown>>;
    assert.deepStrictEqual(extension['БезПользователя'], { 'repo-path': '\\\\repo\\a', 'repo-user': '' });
    assert.deepStrictEqual(extension['БезПути'], { 'repo-path': '', 'repo-user': 'carol' });
  });

  test('env.default — строка (некорректная форма) → getDefaultSection отдаёт {} без ошибки', () => {
    writeEnvJson({ default: 'неожиданная строка' });
    const cfTarget: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
    assert.strictEqual(store.hasBinding(cfTarget), false);
  });
});
