import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/**
 * Issue #55: файлы корня (`Configuration.xml`, модули и прочее содержимое `Ext/`)
 * не имеют XML объекта-владельца, и `isEditRestricted` считал их редактируемыми
 * при подключённом хранилище без захвата корня. Их захват — захват корня, как в
 * дереве (`isRootLocked`). Фикстуры — временные копии `example/2.21/src/cf` и
 * `example/2.21/src/cfe/EVOLC`.
 */

const EXAMPLE_21 = path.resolve(__dirname, '../../../example/2.21/src');

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

interface Harness {
  configRoot: string;
  target: RepositoryTarget;
  service: RepositoryService;
  dispose(): void;
}

function createHarness(sourceRel: string, kind: 'cf' | 'cfe'): Harness {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-root-files-')));
  const configRoot = path.join(workspaceRoot, 'src', path.basename(sourceRel));
  fs.cpSync(path.join(EXAMPLE_21, sourceRel), configRoot, { recursive: true });
  const service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target = service.resolveTargetByConfigRoot(configRoot);
  assert.ok(target, 'цель хранилища должна определяться по корню выгрузки.');
  assert.strictEqual(target.configKind, kind);
  return { configRoot, target, service, dispose: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }) };
}

async function connect(harness: Harness): Promise<void> {
  await harness.service.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
  harness.service.setConnected(harness.target, true);
}

const CASES = [
  { name: 'cf: Configuration.xml', source: 'cf', kind: 'cf', rel: 'Configuration.xml' },
  { name: 'cf: модуль сеанса Ext/SessionModule.bsl', source: 'cf', kind: 'cf', rel: path.join('Ext', 'SessionModule.bsl') },
  { name: 'cf: модуль управляемого приложения', source: 'cf', kind: 'cf', rel: path.join('Ext', 'ManagedApplicationModule.bsl') },
  { name: 'cfe: Configuration.xml расширения', source: path.join('cfe', 'EVOLC'), kind: 'cfe', rel: 'Configuration.xml' },
] as const;

suite('RepositoryService.isEditRestricted — файлы корня требуют захвата корня (issue #55)', () => {
  for (const item of CASES) {
    test(`${item.name}: без подключения — разрешено; подключено без захвата корня — запрещено; корень захвачен — разрешено`, async () => {
      const harness = createHarness(item.source, item.kind);
      try {
        const filePath = path.join(harness.configRoot, item.rel);
        assert.ok(fs.existsSync(filePath), `фикстура должна содержать ${item.rel}.`);
        assert.strictEqual(harness.service.isEditRestricted(filePath), false);

        await connect(harness);
        assert.strictEqual(harness.service.isEditRestricted(filePath), true);

        harness.service.setLocked(harness.target, [getRootLockName(harness.target)], true);
        assert.strictEqual(harness.service.isEditRestricted(filePath), false);
      } finally {
        harness.dispose();
      }
    });
  }

  test('захват объекта не снимает ограничение с файлов корня', async () => {
    const harness = createHarness('cf', 'cf');
    try {
      await connect(harness);
      harness.service.setLocked(harness.target, ['Справочник.Контрагенты'], true);
      assert.strictEqual(harness.service.isEditRestricted(path.join(harness.configRoot, 'Catalogs', 'Контрагенты.xml')), false);
      assert.strictEqual(harness.service.isEditRestricted(path.join(harness.configRoot, 'Configuration.xml')), true);
    } finally {
      harness.dispose();
    }
  });

  test('ConfigDumpInfo.xml — служебный файл выгрузки, не единица хранилища: не ограничивается', async () => {
    const harness = createHarness('cf', 'cf');
    try {
      await connect(harness);
      assert.strictEqual(harness.service.isEditRestricted(path.join(harness.configRoot, 'ConfigDumpInfo.xml')), false);
    } finally {
      harness.dispose();
    }
  });

  test('файл вне корня выгрузки — не ограничивается', async () => {
    const harness = createHarness('cf', 'cf');
    try {
      await connect(harness);
      const outside = path.join(path.dirname(path.dirname(harness.configRoot)), 'readme.txt');
      fs.writeFileSync(outside, 'x', 'utf-8');
      assert.strictEqual(harness.service.isEditRestricted(outside), false);
    } finally {
      harness.dispose();
    }
  });
});
