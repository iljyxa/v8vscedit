import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { acquireUnlockEtalons } from '../../ui/commands/repository/RepositoryUnlockEtalons';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices, RepositorySubject } from '../../ui/commands/repository/RepositoryFileSyncShared';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';

/**
 * `RepositoryUnlockEtalons.acquireUnlockEtalons` — раздел 10, Р8: алгоритм
 * эталона отмены захвата по единицам (обход от предков к потомкам, 4 источника
 * эталона — снимок/dump/empty/missing), критерии приёмки 10.1.8/10.1.10.
 * Прямой вызов экспортированной функции (а не через полный
 * `runRepositoryUnlockFlow`/CLI/guard) — `decideSnapshotEtalons`/`dumpEtalons`/
 * `isAbsentInDumpedParent` не экспортированы и наблюдаемы только через неё;
 * прямой вызов даёт контроль над иерархией снимков без накладных расходов
 * полного потока (см. оговорку в `repositoryUnlockSync.test.ts` — этот файл
 * и есть тот «отдельный заход», предусмотренный там).
 */

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  services: RepositoryFileSyncServices;
  outputLines: string[];
}

function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-etalons-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');

  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
  const outputLines: string[] = [];

  const services: RepositoryFileSyncServices = {
    configurationOperationGuard: new ConfigurationOperationGuard(),
    workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
    outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
    repositoryService,
    projectSecretStorage: {} as unknown as RepositoryFileSyncServices['projectSecretStorage'],
    supportService: undefined,
    suppressConfigurationReloadForFiles: () => undefined,
    markChangedConfigurationByFiles: () => undefined,
    treeProvider: { refresh: () => undefined, refreshCacheForFiles: () => true } as unknown as MetadataTreeProvider,
    refreshActionsView: () => undefined,
    reloadEntries: () => Promise.resolve(),
  };

  return { workspaceRoot, configRoot, target, repositoryService, services, outputLines };
}

function buildSubject(harness: Harness, anchor: string, members: string[]): RepositorySubject {
  return {
    target: harness.target,
    objectsFile: path.join(harness.workspaceRoot, 'Objects.xml'),
    anchor,
    members,
    isRoot: false,
    mode: 'recursive',
    plan: { kind: 'objects', anchors: [anchor], fullNames: members, expansion: 'subordinates' },
  };
}

function baseDeps(overrides: Partial<RepositoryFileSyncDeps> = {}): RepositoryFileSyncDeps {
  return {
    runRepositoryCli: () => Promise.reject(new Error('не используется')),
    dumpToTemp: () => Promise.reject(new Error('dumpToTemp не должен вызываться в этом сценарии')),
    chooseConflictResolution: () => Promise.reject(new Error('не используется')),
    confirmRollback: () => Promise.reject(new Error('не используется')),
    openDiffs: () => Promise.reject(new Error('не используется')),
    notifyBusy: () => undefined,
    notifyInfo: () => undefined,
    notifyWarning: () => undefined,
    notifyError: () => undefined,
    isFileSyncEnabled: () => true,
    getDirtyFilePaths: () => [],
    now: () => new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Owner-каталог с Form-подчинёнными в ChildObjects (тот же минимальный синтетический
 * приём, что уже используется в repositoryLockSync.test.ts для buildSubsystemXml —
 * ChildObjectRefsReader читает только прямые текстовые дети <ChildObjects>). */
function buildCatalogXml(name: string, forms: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MetaDataObject>
  <Catalog>
    <Properties><Name>${name}</Name></Properties>
    <ChildObjects>${forms.map((form) => `<Form>${form}</Form>`).join('')}</ChildObjects>
  </Catalog>
</MetaDataObject>`;
}

function writeOwnerAndForm(configRoot: string, forms: string[]): void {
  fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
  fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Объект.xml'), buildCatalogXml('Объект', forms), 'utf-8');
}

/** Раскладка снимков на диске — совпадает с `RepositoryLockSnapshotStore` (см. её тесты). */
function legacySnapshotDir(harness: Harness, fullName: string): string {
  const scopeKey = crypto.createHash('sha1').update(`cf|${path.resolve(harness.configRoot)}|`).digest('hex');
  const fullNameHash = crypto.createHash('sha1').update(fullName).digest('hex');
  return path.join(harness.workspaceRoot, '.v8vscedit', 'repository', 'snapshots', scopeKey, fullNameHash);
}

suite('RepositoryUnlockEtalons — acquireUnlockEtalons: снимок покрывает предком (issue #1, раздел 10, Р8, критерий 10.1.10)', () => {
  test('старый (глубокий, v1/v2) снимок владельца при рекурсивной отмене покрывает подчинённую единицу — она пропускается без собственного эталона', async () => {
    const harness = createHarness();
    writeOwnerAndForm(harness.configRoot, ['ФормаЭлемента']);
    const formXmlPath = path.join(harness.configRoot, 'Catalogs', 'Объект', 'ФормаЭлемента.xml');
    fs.mkdirSync(path.dirname(formXmlPath), { recursive: true });
    fs.writeFileSync(formXmlPath, '<MetaDataObject/>', 'utf-8');

    // Легаси-манифест (без version/depth) — readSnapshotInfo трактует его как depth:"tree".
    const snapshotDir = legacySnapshotDir(harness, 'Справочник.Объект');
    fs.mkdirSync(path.join(snapshotDir, 'files', 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'files', 'Catalogs', 'Объект.xml'), buildCatalogXml('Объект', ['ФормаЭлемента']), 'utf-8');
    fs.writeFileSync(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify({ files: ['Catalogs/Объект.xml'] }),
      'utf-8'
    );

    const subject = buildSubject(harness, 'Справочник.Объект', ['Справочник.Объект', 'Справочник.Объект.Форма.ФормаЭлемента']);
    const result = await acquireUnlockEtalons(
      subject,
      ['Справочник.Объект', 'Справочник.Объект.Форма.ФормаЭлемента'],
      true,
      {},
      harness.services,
      baseDeps()
    );

    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.objects.length, 1, 'Подчинённая единица не должна получить отдельный эталон — она покрыта деревом владельца.');
    assert.strictEqual(result.objects[0].fullName, 'Справочник.Объект');
    assert.strictEqual(result.objects[0].source, 'snapshot');
    assert.strictEqual(result.objects[0].depth, 'tree');
    result.dispose();
  });
});

suite('RepositoryUnlockEtalons — acquireUnlockEtalons: единица создана локально (issue #1, раздел 10, Р8)', () => {
  test('единица без снимка, но снимок ближайшего предка (v3, subordinates) её не перечисляет — эталон "empty" (создана локально)', async () => {
    const harness = createHarness();
    writeOwnerAndForm(harness.configRoot, ['ФормаЭлемента', 'ФормаНоваяЛокальная']);
    for (const form of ['ФормаЭлемента', 'ФормаНоваяЛокальная']) {
      const formXmlPath = path.join(harness.configRoot, 'Catalogs', 'Объект', `${form}.xml`);
      fs.mkdirSync(path.dirname(formXmlPath), { recursive: true });
      fs.writeFileSync(formXmlPath, '<MetaDataObject/>', 'utf-8');
    }

    // Снимок владельца v3 со СПИСКОМ подчинённых версии хранилища — ФормаНоваяЛокальная
    // в этот список НЕ входит (появилась в проекте уже после захвата).
    harness.repositoryService.snapshots.captureFromDirectory(
      harness.target,
      'Справочник.Объект',
      harness.configRoot,
      { kind: 'object', fullName: 'Справочник.Объект', xmlRel: 'Catalogs/Объект.xml', dirRel: 'Catalogs/Объект', excludeDirRels: [], depth: 'unit' },
      [],
      'unit',
      ['Справочник.Объект.Форма.ФормаЭлемента']
    );

    const subject = buildSubject(harness, 'Справочник.Объект', ['Справочник.Объект']);
    const result = await acquireUnlockEtalons(
      subject,
      ['Справочник.Объект.Форма.ФормаНоваяЛокальная'],
      true,
      {},
      harness.services,
      baseDeps()
    );

    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.objects.length, 1);
    assert.deepStrictEqual(
      result.objects[0],
      { fullName: 'Справочник.Объект.Форма.ФормаНоваяЛокальная', source: 'empty', depth: 'unit' }
    );
    result.dispose();
  });
});

suite('RepositoryUnlockEtalons — acquireUnlockEtalons: dumpEtalons без снимка (issue #1, раздел 10, Р8)', () => {
  test('подчинённая единица отсутствует в ДАМПЕ найденного родителя — эталон "empty" (isAbsentInDumpedParent)', async () => {
    const harness = createHarness();
    writeOwnerAndForm(harness.configRoot, ['ФормаЭлемента']);
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-etalons-dump-absent-'));
    try {
      // "Хранилище" отдаёт владельца БЕЗ ссылки на форму — форма никогда не была
      // выгружена сама по себе (её и не запросят следующим раундом), и ближайший
      // найденный родитель (владелец) её не перечисляет → она отсутствует в хранилище.
      fs.mkdirSync(path.join(dumpDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(dumpDir, 'Catalogs', 'Объект.xml'), buildCatalogXml('Объект', []), 'utf-8');

      const subject = buildSubject(harness, 'Справочник.Объект', ['Справочник.Объект']);
      const deps = baseDeps({
        dumpToTemp: () => Promise.resolve({ ok: true, dir: dumpDir, dispose: () => undefined }),
      });

      const result = await acquireUnlockEtalons(
        subject,
        ['Справочник.Объект', 'Справочник.Объект.Форма.ФормаЭлемента'],
        true,
        {},
        harness.services,
        deps
      );

      assert.strictEqual(result.status, 'ready');
      const byName = new Map(result.objects.map((o) => [o.fullName, o]));
      assert.strictEqual(byName.get('Справочник.Объект')?.source, 'dump');
      assert.deepStrictEqual(byName.get('Справочник.Объект.Форма.ФормаЭлемента'), {
        fullName: 'Справочник.Объект.Форма.ФормаЭлемента', source: 'empty', depth: 'unit',
      });
      result.dispose();
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('подчинённая единица есть в дампе родителя, но её собственная довыгрузка провалилась — без эталона, только лог (missing)', async () => {
    const harness = createHarness();
    writeOwnerAndForm(harness.configRoot, ['ФормаЭлемента']);
    const ownerDumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-etalons-dump-missing-owner-'));
    try {
      // "Хранилище" отдаёт владельца, ССЫЛАЮЩЕГОСЯ на форму — она РЕАЛЬНО существует
      // в хранилище, но раунд её собственной довыгрузки (второй вызов dumpToTemp) проваливается.
      fs.mkdirSync(path.join(ownerDumpDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(ownerDumpDir, 'Catalogs', 'Объект.xml'), buildCatalogXml('Объект', ['ФормаЭлемента']), 'utf-8');

      let calls = 0;
      const deps = baseDeps({
        dumpToTemp: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve({ ok: true, dir: ownerDumpDir, dispose: () => undefined });
          }
          return Promise.resolve({ ok: false, reason: 'сеть недоступна' });
        },
      });

      const subject = buildSubject(harness, 'Справочник.Объект', ['Справочник.Объект']);
      const result = await acquireUnlockEtalons(
        subject,
        ['Справочник.Объект', 'Справочник.Объект.Форма.ФормаЭлемента'],
        true,
        {},
        harness.services,
        deps
      );

      assert.strictEqual(result.status, 'ready');
      assert.strictEqual(result.objects.length, 1, 'Для формы не должно быть эталона вовсе — только лог.');
      assert.strictEqual(result.objects[0].fullName, 'Справочник.Объект');
      assert.ok(
        harness.outputLines.some((line) => line.includes('версия хранилища не получена') && line.includes('ФормаЭлемента')),
        'должен быть залогирован факт непереданного эталона для формы.'
      );
      result.dispose();
    } finally {
      fs.rmSync(ownerDumpDir, { recursive: true, force: true });
    }
  });
});
