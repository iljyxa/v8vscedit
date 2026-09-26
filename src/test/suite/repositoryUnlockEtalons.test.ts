import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { acquireUnlockEtalons } from '../../ui/commands/repository/RepositoryUnlockEtalons';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices, RepositorySubject } from '../../ui/commands/repository/RepositoryFileSyncShared';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { CONFIGURATION_ROOT_LOCK_NAME, subordinateUnitFullName } from '../../infra/repository/RepositoryObjectNames';
import { resolveObjectScope } from '../../infra/repository/RepositoryObjectScope';
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
 *
 * Рабочая область — РЕАЛЬНАЯ копия `example/2.21/src/cf` (см. CLAUDE.md TDD
 * п.3 — только реальные фикстуры): `Справочник.Контрагенты` с формами
 * `ФормаЭлемента`/`ФормаСписка`. «Версия хранилища» для `dumpToTemp` — тоже
 * копия реального XML, при необходимости с точечной текстовой правкой (удаление
 * строки `<Form>…</Form>`) — тот же приём, что и в
 * `repositoryLockSyncRealFixtureFlow.test.ts` (Р4).
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

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

/** Рабочая область с РЕАЛЬНОЙ копией example/2.21/src/cf. */
function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-etalons-'));
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.cpSync(EXAMPLE_CF, configRoot, { recursive: true });

  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };
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

/** Раскладка снимков на диске — совпадает с `RepositoryLockSnapshotStore` (см. её тесты). */
function legacySnapshotDir(harness: Harness, fullName: string): string {
  const scopeKey = crypto.createHash('sha1').update(`cf|${path.resolve(harness.configRoot)}|`).digest('hex');
  const fullNameHash = crypto.createHash('sha1').update(fullName).digest('hex');
  return path.join(harness.workspaceRoot, '.v8vscedit', 'repository', 'snapshots', scopeKey, fullNameHash);
}

/** Реальный Catalogs/Контрагенты.xml БЕЗ ссылок на формы (текстовая правка копии — не сборка XML). */
function ownerXmlWithoutForms(): string {
  const original = fs.readFileSync(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml'), 'utf-8');
  const stripped = original
    .replace(/\s*<Form>ФормаЭлемента<\/Form>/, '')
    .replace(/\s*<Form>ФормаСписка<\/Form>/, '');
  assert.notStrictEqual(stripped, original, 'В реальном Контрагенты.xml обязаны быть обе ссылки <Form>.');
  return stripped;
}

const kontragenty = 'Справочник.Контрагенты';
const formaElementa = subordinateUnitFullName(kontragenty, 'Form', 'ФормаЭлемента');
const formaSpiska = subordinateUnitFullName(kontragenty, 'Form', 'ФормаСписка');

suite('RepositoryUnlockEtalons — acquireUnlockEtalons: снимок покрывает предком (issue #1, раздел 10, Р8, критерий 10.1.10)', () => {
  test('старый (глубокий, v1/v2) снимок владельца при рекурсивной отмене покрывает подчинённую единицу — она пропускается без собственного эталона', async () => {
    const harness = createHarness();

    // Легаси-манифест (без version/depth) — readSnapshotInfo трактует его как depth:"tree".
    const snapshotDir = legacySnapshotDir(harness, kontragenty);
    fs.mkdirSync(path.join(snapshotDir, 'files', 'Catalogs'), { recursive: true });
    fs.copyFileSync(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml'), path.join(snapshotDir, 'files', 'Catalogs', 'Контрагенты.xml'));
    fs.writeFileSync(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify({ files: ['Catalogs/Контрагенты.xml'] }),
      'utf-8'
    );

    const subject = buildSubject(harness, kontragenty, [kontragenty, formaElementa]);
    const result = await acquireUnlockEtalons(
      subject,
      [kontragenty, formaElementa],
      true,
      {},
      harness.services,
      baseDeps()
    );

    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.objects.length, 1, 'Подчинённая единица не должна получить отдельный эталон — она покрыта деревом владельца.');
    assert.strictEqual(result.objects[0].fullName, kontragenty);
    assert.strictEqual(result.objects[0].source, 'snapshot');
    assert.strictEqual(result.objects[0].depth, 'tree');
    result.dispose();
  });
});

suite('RepositoryUnlockEtalons — acquireUnlockEtalons: единица создана локально (issue #1, раздел 10, Р8)', () => {
  test('единица без снимка, но снимок ближайшего предка (v3, subordinates) её не перечисляет — эталон "empty" (создана локально)', async () => {
    const harness = createHarness();
    // Форма, созданная ЛОКАЛЬНО уже ПОСЛЕ захвата (в снимке владельца её ещё нет) —
    // содержимое неважно (source:'empty' решается по списку subordinates снимка, а
    // не чтением файла), поэтому маркер — пустой реальный файл, без синтетического XML.
    const newLocalFormPath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаНоваяЛокальная.xml');
    fs.writeFileSync(newLocalFormPath, '', 'utf-8');
    const formaNovaya = subordinateUnitFullName(kontragenty, 'Form', 'ФормаНоваяЛокальная');

    // Снимок владельца v3 со СПИСКОМ подчинённых версии хранилища — ФормаНоваяЛокальная
    // в этот список НЕ входит (появилась в проекте уже после захвата).
    const scope = resolveObjectScope(harness.configRoot, kontragenty, harness.target, 'unit');
    assert.ok(scope, 'предпосылка: область владельца обязана резолвиться.');
    harness.repositoryService.snapshots.captureFromDirectory(
      harness.target,
      kontragenty,
      harness.configRoot,
      scope,
      [],
      'unit',
      [formaElementa, formaSpiska]
    );

    const subject = buildSubject(harness, kontragenty, [kontragenty]);
    const result = await acquireUnlockEtalons(
      subject,
      [formaNovaya],
      true,
      {},
      harness.services,
      baseDeps()
    );

    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.objects.length, 1);
    assert.deepStrictEqual(
      result.objects[0],
      { fullName: formaNovaya, source: 'empty', depth: 'unit' }
    );
    result.dispose();
  });
});

suite('RepositoryUnlockEtalons — acquireUnlockEtalons: dumpEtalons без снимка (issue #1, раздел 10, Р8)', () => {
  test('подчинённая единица отсутствует в ДАМПЕ найденного родителя — эталон "empty" (isAbsentInDumpedParent)', async () => {
    const harness = createHarness();
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-etalons-dump-absent-'));
    try {
      // "Хранилище" отдаёт владельца БЕЗ ссылки на форму — форма никогда не была
      // выгружена сама по себе (её и не запросят следующим раундом), и ближайший
      // найденный родитель (владелец) её не перечисляет → она отсутствует в хранилище.
      fs.mkdirSync(path.join(dumpDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(dumpDir, 'Catalogs', 'Контрагенты.xml'), ownerXmlWithoutForms(), 'utf-8');

      const subject = buildSubject(harness, kontragenty, [kontragenty]);
      const deps = baseDeps({
        dumpToTemp: () => Promise.resolve({ ok: true, dir: dumpDir, dispose: () => undefined }),
      });

      const result = await acquireUnlockEtalons(
        subject,
        [kontragenty, formaElementa],
        true,
        {},
        harness.services,
        deps
      );

      assert.strictEqual(result.status, 'ready');
      const byName = new Map(result.objects.map((o) => [o.fullName, o]));
      assert.strictEqual(byName.get(kontragenty)?.source, 'dump');
      assert.deepStrictEqual(byName.get(formaElementa), {
        fullName: formaElementa, source: 'empty', depth: 'unit',
      });
      result.dispose();
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('подчинённая единица есть в дампе родителя, но её собственная довыгрузка провалилась — без эталона, только лог (missing)', async () => {
    const harness = createHarness();
    const ownerDumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-etalons-dump-missing-owner-'));
    try {
      // "Хранилище" отдаёт владельца, ССЫЛАЮЩЕГОСЯ на форму (реальный ChildObjects,
      // без правок) — она РЕАЛЬНО существует в хранилище, но раунд её собственной
      // довыгрузки (второй вызов dumpToTemp) проваливается.
      fs.mkdirSync(path.join(ownerDumpDir, 'Catalogs'), { recursive: true });
      fs.copyFileSync(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml'), path.join(ownerDumpDir, 'Catalogs', 'Контрагенты.xml'));

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

      const subject = buildSubject(harness, kontragenty, [kontragenty]);
      const result = await acquireUnlockEtalons(
        subject,
        [kontragenty, formaElementa],
        true,
        {},
        harness.services,
        deps
      );

      assert.strictEqual(result.status, 'ready');
      assert.strictEqual(result.objects.length, 1, 'Для формы не должно быть эталона вовсе — только лог.');
      assert.strictEqual(result.objects[0].fullName, kontragenty);
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

suite('RepositoryUnlockEtalons — decideSnapshotEtalons: сортировка byDepth (issue #1, раздел 10, Р8)', () => {
  test('при равной глубине предков (0) единицы упорядочиваются по имени (fallback localeCompare)', async () => {
    const harness = createHarness();
    // Два реальных верхнеуровневых справочника фикстуры: "Валюты" < "Контрагенты"
    // по алфавиту — порядок обработки должен быть именно таким независимо от
    // порядка в исходном массиве released.
    const subject = buildSubject(harness, kontragenty, [kontragenty, 'Справочник.Валюты']);
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-etalons-sort-dump-'));
    try {
      fs.mkdirSync(path.join(dumpDir, 'Catalogs'), { recursive: true });
      fs.copyFileSync(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml'), path.join(dumpDir, 'Catalogs', 'Контрагенты.xml'));
      fs.copyFileSync(path.join(EXAMPLE_CF, 'Catalogs', 'Валюты.xml'), path.join(dumpDir, 'Catalogs', 'Валюты.xml'));
      const deps = baseDeps({ dumpToTemp: () => Promise.resolve({ ok: true, dir: dumpDir, dispose: () => undefined }) });

      // Оба переданы в порядке "Контрагенты", "Валюты" (обратном алфавитному) — оба
      // верхнеуровневые (ancestors.length===0 у обоих, разница глубин 0 — только
      // тай-брейк по имени решает порядок обработки, а не порядок в исходном массиве released).
      const result = await acquireUnlockEtalons(subject, [kontragenty, 'Справочник.Валюты'], true, {}, harness.services, deps);

      assert.strictEqual(result.status, 'ready');
      assert.deepStrictEqual(
        result.objects.map((o) => o.fullName),
        ['Справочник.Валюты', kontragenty],
        'Порядок обработки обязан быть алфавитным (localeCompare), а не порядком исходного массива.'
      );
      result.dispose();
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });
});

/**
 * ВРЕМЕННАЯ СИНТЕТИКА (issue #1, раздел 10.7, фикстура F1 — issue #48 форка):
 * реальной фикстуры вложенных подсистем (`Подсистема.A.Подсистема.B`) в `example/`
 * ещё нет. До появления F1 цепочка «непосредственный родитель тоже не найден»
 * проверяется на минимальном синтетическом дереве подсистем.
 */
function buildSubsystemXml(name: string, refs: string[], childSubsystems: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MetaDataObject>
  <Subsystem>
    <Properties>
      <Name>${name}</Name>
      ${refs.length > 0
        ? `<Content>${refs.map((ref) => `<xr:Item xsi:type="xr:MDObjectRef">${ref}</xr:Item>`).join('')}</Content>`
        : '<Content/>'}
    </Properties>
    ${childSubsystems.length > 0
      ? `<ChildObjects>${childSubsystems.map((child) => `<Subsystem>${child}</Subsystem>`).join('')}</ChildObjects>`
      : '<ChildObjects/>'}
  </Subsystem>
</MetaDataObject>`;
}

suite('RepositoryUnlockEtalons — isAbsentInDumpedParent: непосредственный родитель тоже не найден (issue #1, раздел 10, Р8) (временно синтетика: ждёт фикстуру F1, issue #48)', () => {
  test('раунд довыгрузки родителя провалился — потомок родителя тоже не получает эталон (ветка !parent)', async () => {
    const harness = createHarness();
    fs.mkdirSync(path.join(harness.configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница', 'Subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи.xml'),
      buildSubsystemXml('Продажи', [], ['Розница']),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница', 'Розница.xml'),
      buildSubsystemXml('Розница', [], ['Интернет']),
      'utf-8'
    );
    fs.mkdirSync(path.join(harness.configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница', 'Subsystems', 'Интернет'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница', 'Subsystems', 'Интернет', 'Интернет.xml'),
      buildSubsystemXml('Интернет', [], []),
      'utf-8'
    );

    const rozница = subordinateUnitFullName('Подсистема.Продажи', 'Subsystem', 'Розница');
    const internet = subordinateUnitFullName(rozница, 'Subsystem', 'Интернет');

    const dumpDirLevel0 = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unlock-etalons-chain-level0-'));
    try {
      // Раунд 0 (анкер "Продажи") успешен и ссылается на "Розница".
      fs.mkdirSync(path.join(dumpDirLevel0, 'Subsystems'), { recursive: true });
      fs.writeFileSync(path.join(dumpDirLevel0, 'Subsystems', 'Продажи.xml'), buildSubsystemXml('Продажи', [], ['Розница']), 'utf-8');

      let calls = 0;
      const deps = baseDeps({
        dumpToTemp: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve({ ok: true, dir: dumpDirLevel0, dispose: () => undefined });
          }
          // Раунд довыгрузки "Розница" (обнаружена через закрытие "Продажи") проваливается —
          // "Интернет" (вложенная под "Розница") так и не будет даже запрошена.
          return Promise.resolve({ ok: false, reason: 'сеть недоступна' });
        },
      });

      const subject = buildSubject(harness, 'Подсистема.Продажи', ['Подсистема.Продажи']);
      const result = await acquireUnlockEtalons(
        subject,
        ['Подсистема.Продажи', rozница, internet],
        true,
        {},
        harness.services,
        deps
      );

      assert.strictEqual(result.status, 'ready');
      assert.strictEqual(calls, 2, 'основной раунд ("Продажи") + провалившийся раунд довыгрузки ("Розница"); "Интернет" не запрашивается вовсе.');
      assert.strictEqual(result.objects.length, 1, 'эталон есть только у "Продажи" — ни "Розница", ни "Интернет" эталона не получают.');
      assert.strictEqual(result.objects[0].fullName, 'Подсистема.Продажи');
      assert.ok(
        harness.outputLines.some((line) => line.includes('версия хранилища не получена') && line.includes(internet)),
        '"Интернет" (её непосредственный родитель тоже не найден) должна быть залогирована как непереданный эталон, а не упасть с ошибкой.'
      );
      result.dispose();
    } finally {
      fs.rmSync(dumpDirLevel0, { recursive: true, force: true });
    }
  });
});

suite('RepositoryUnlockEtalons — рекурсивный корень без заранее посчитанных хешей (issue #1, N1)', () => {
  let harness: Harness;

  setup(() => {
    harness = createHarness();
  });

  teardown(() => {
    fs.rmSync(harness.workspaceRoot, { recursive: true, force: true });
  });

  function rootSubject(): RepositorySubject {
    return {
      target: harness.target,
      objectsFile: path.join(harness.workspaceRoot, 'Objects.xml'),
      anchor: CONFIGURATION_ROOT_LOCK_NAME,
      members: [CONFIGURATION_ROOT_LOCK_NAME],
      isRoot: true,
      mode: 'recursive',
      plan: { kind: 'root-incremental' },
    };
  }

  test('хеши корня не переданы — функция хеширует проект сама: без изменений против манифеста эталонов нет и выгрузки нет', async () => {
    harness.repositoryService.snapshots.captureRootManifest(harness.target);

    const result = await acquireUnlockEtalons(rootSubject(), [CONFIGURATION_ROOT_LOCK_NAME], true, {}, harness.services, baseDeps());

    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.objects, []);
    result.dispose();
  });

  test('хеши корня не переданы, модуль формы изменён после манифеста — изменение найдено собственным хешированием', async () => {
    harness.repositoryService.snapshots.captureRootManifest(harness.target);
    fs.appendFileSync(path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl'), '\n// локальная правка\n', 'utf-8');
    const requested: string[][] = [];

    await acquireUnlockEtalons(rootSubject(), [CONFIGURATION_ROOT_LOCK_NAME], true, {}, harness.services, baseDeps({
      dumpToTemp: (_target, request) => {
        requested.push(request.mode === 'partial' ? [...request.fullNames] : [request.mode]);
        return Promise.resolve({ ok: false, reason: 'выгрузка не нужна для проверки' });
      },
    }));

    assert.deepStrictEqual(requested, [['Справочник.Контрагенты.Форма.ФормаЭлемента']]);
  });
});
