import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { parseV8iContent } from '../../infra/environment/InfoBaseRegistryService';
import { ProjectEnvironmentService } from '../../infra/environment/ProjectEnvironmentService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';

const DEV = '[Разработка]\nConnect=File="/srv/bases/dev";\n';
const TEST = '[Тестовая]\nConnect=Srvr="srv01";Ref="Demo_Test";\n';
const OTHER = '[Другая]\nConnect=File="/srv/bases/other";\n';

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

// Issue #5: id базы, показанный в панели «Окружение проекта», должен оставаться
// действительным после того, как лаунчер 1С перезаписал ibases.v8i в другом порядке.
suite('ProjectEnvironmentService — выбор базы после перезаписи ibases.v8i', () => {
  let workspaceRoot: string;

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-env-base-'));
  });

  teardown(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('save находит базу по id из прошлого скана и пишет её строку подключения', async () => {
    // Реальный разбор v8i: первый скан — как при открытии панели, следующие — после
    // того, как лаунчер добавил чужую базу выше: позиция «Тестовой» 1 досталась бы
    // «Разработке», и позиционный id молча подменил бы выбранную базу.
    const v8iVersions = [DEV + TEST, OTHER + DEV + TEST];
    let scanIndex = 0;
    const service = new ProjectEnvironmentService(
      workspaceRoot,
      new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot),
      {
        scanInfoBases: () => {
          const content = v8iVersions[Math.min(scanIndex, v8iVersions.length - 1)];
          scanIndex += 1;
          return { bases: parseV8iContent(content, '/tmp/ibases.v8i'), sources: [], warnings: [] };
        },
        scanPlatforms: () => [],
      }
    );

    const shown = await service.getSnapshot(true);
    const testBaseId = shown.bases.find((base) => base.name === 'Тестовая')?.id;
    assert.ok(testBaseId);

    // Повторное открытие панели пересканировало уже перезаписанный список.
    await service.getSnapshot(true);
    await service.save({ platformPath: '', baseId: testBaseId, dbUser: '', dbPassword: '' });

    const env = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'env.json'), 'utf-8')) as {
      default: Record<string, unknown>;
    };
    assert.strictEqual(env.default['--ibconnection'], '/Ssrv01/Demo_Test');
  });
});
