import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryLockSnapshotStore, diffOwnersAgainstBaseline } from '../../infra/repository/RepositoryLockSnapshotStore';
import { resolveObjectScope, type ObjectScope } from '../../infra/repository/RepositoryObjectScope';
import { computeFileHash } from '../../infra/cache/HashCache';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { fixtureUuid, writeConfigurationXml, writeObjectXml } from './support/flatMetadataFixtures';

/**
 * `RepositoryLockSnapshotStore` — перенос снапшота захвата (issue #2, критерии
 * приёмки №8–10 плана архитектора) с прежней node-центричной сигнатуры
 * (`RepositoryService.captureLockSnapshot(target, node)`) на scope-центричную
 * (`captureFromDirectory/captureFromProject(target, fullName, ..., scope)`),
 * плюс новый хеш-манифест ВСЕГО корня для рекурсивного захвата (issue #1, п.10).
 *
 * Решение (неоднозначность плана): хранилище снапшотов было и остаётся привязано
 * к КОРНЮ ВСЕЙ РАБОЧЕЙ ОБЛАСТИ (`workspaceRoot` — тот же параметр, что у
 * `new RepositoryService(root, secrets)`), а не к `target.configRoot` (внутри
 * одной рабочей области могут быть несколько целей — cf и несколько cfe). Так же,
 * как старый `RepositoryService.getSnapshotDir`, это подразумевает, что
 * `RepositoryLockSnapshotStore` — КЛАСС с конструктором `(workspaceRoot)`, а не
 * набор чистых функций: `RepositoryService.get snapshots()` из плана архитектора
 * возвращает именно такой экземпляр, созданный в конструкторе `RepositoryService`.
 *
 * Раскладка на диске СОХРАНЯЕТСЯ такой же, как в прежней реализации — иначе
 * снапшоты, снятые ДО обновления расширения, стали бы нечитаемыми в разгар
 * отмены захвата. Тест на совместимость с манифестом v1 (`{files: [...]}`, без
 * хешей — только копия содержимого рядом в `files/<rel>`) намеренно кладёт файл
 * по этой же схеме: `.v8vscedit/repository/snapshots/<sha1(scopeKey)>/<sha1(fullName)>/`.
 */

function buildScopeKey(target: RepositoryTarget): string {
  const raw = `${target.configKind}|${path.resolve(target.configRoot)}|${target.extensionName ?? ''}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function legacySnapshotDir(workspaceRoot: string, target: RepositoryTarget, fullName: string): string {
  const fullNameHash = crypto.createHash('sha1').update(fullName).digest('hex');
  return path.join(workspaceRoot, '.v8vscedit', 'repository', 'snapshots', buildScopeKey(target), fullNameHash);
}

suite('RepositoryLockSnapshotStore — captureFromDirectory/readSnapshotHashes/restoreToProject', () => {
  test('нет снапшота — readSnapshotHashes отдаёт undefined', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-none-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      assert.strictEqual(store.readSnapshotHashes(target, 'Справочник.Нет'), undefined);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('captureFromDirectory снимает хеши файлов области из указанного каталога (temp-выгрузка)', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-capture-dir-'));
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-capture-dump-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
      writeConfigurationXml(dumpDir, fixtureUuid('snap-capture-dump-config'));
      const dumpXmlPath = writeObjectXml(dumpDir, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('snap-capture-object'), 'flat');

      const scope = resolveObjectScope(dumpDir, 'Справочник.Объект', target) as Extract<ObjectScope, { kind: 'object' }>;
      store.captureFromDirectory(target, 'Справочник.Объект', dumpDir, scope);

      const hashes = store.readSnapshotHashes(target, 'Справочник.Объект');
      assert.ok(hashes);
      assert.strictEqual(hashes['Catalogs/Объект.xml'], computeFileHash(dumpXmlPath));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('повторный захват затирает предыдущий снапшот того же fullName', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-overwrite-'));
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-overwrite-dump-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
      writeConfigurationXml(dumpDir, fixtureUuid('snap-overwrite-config'));
      const xmlPath = writeObjectXml(dumpDir, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('snap-overwrite-object'), 'flat');
      const scope = resolveObjectScope(dumpDir, 'Справочник.Объект', target) as Extract<ObjectScope, { kind: 'object' }>;

      store.captureFromDirectory(target, 'Справочник.Объект', dumpDir, scope);
      const firstHash = store.readSnapshotHashes(target, 'Справочник.Объект')?.['Catalogs/Объект.xml'];

      fs.writeFileSync(xmlPath, '<MetaDataObject changed="true"/>', 'utf-8');
      store.captureFromDirectory(target, 'Справочник.Объект', dumpDir, scope);
      const secondHash = store.readSnapshotHashes(target, 'Справочник.Объект')?.['Catalogs/Объект.xml'];

      assert.notStrictEqual(firstHash, secondHash);
      assert.strictEqual(secondHash, computeFileHash(xmlPath));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('captureFromProject снимает снапшот из самого проекта (для пересъёма при commit keepLocked)', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-capture-project-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      writeConfigurationXml(configRoot, fixtureUuid('snap-project-config'));
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('snap-project-object'), 'flat');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(configRoot, 'Справочник.Объект', target) as Extract<ObjectScope, { kind: 'object' }>;

      store.captureFromProject(target, 'Справочник.Объект', scope);

      const hashes = store.readSnapshotHashes(target, 'Справочник.Объект');
      assert.ok(hashes);
      assert.strictEqual(hashes['Catalogs/Объект.xml'], computeFileHash(xmlPath));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('restoreToProject восстанавливает изменённый файл и удаляет лишний (с бэкапом), возвращает списки', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-restore-'));
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-restore-dump-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
      writeConfigurationXml(dumpDir, fixtureUuid('snap-restore-dump-config'));
      writeObjectXml(dumpDir, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('snap-restore-object-dump'), 'flat');
      const dumpScope = resolveObjectScope(dumpDir, 'Справочник.Объект', target) as Extract<ObjectScope, { kind: 'object' }>;
      store.captureFromDirectory(target, 'Справочник.Объект', dumpDir, dumpScope);

      // Проект: сам захваченный объект изменён локально, плюс появился лишний файл в его области.
      writeConfigurationXml(configRoot, fixtureUuid('snap-restore-project-config'));
      const projectXmlPath = writeObjectXml(configRoot, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('snap-restore-object-project'), 'flat');
      fs.mkdirSync(path.join(configRoot, 'Catalogs', 'Объект', 'Ext'), { recursive: true });
      const extraPath = path.join(configRoot, 'Catalogs', 'Объект', 'Ext', 'ObjectModule.bsl');
      fs.writeFileSync(extraPath, 'Процедура НоваяВоВремяЗахвата() КонецПроцедуры', 'utf-8');

      const backupDir = path.join(workspaceRoot, '.v8vscedit', 'repository', 'merge', 'test', 'unlock');
      const projectScope = resolveObjectScope(configRoot, 'Справочник.Объект', target) as Extract<ObjectScope, { kind: 'object' }>;
      const result = store.restoreToProject(target, 'Справочник.Объект', projectScope, backupDir);

      assert.ok(result.restored.some((f: string) => path.resolve(f) === path.resolve(projectXmlPath)));
      assert.ok(result.deleted.some((f: string) => path.resolve(f) === path.resolve(extraPath)));
      assert.strictEqual(fs.existsSync(extraPath), false, 'Лишний файл должен быть удалён.');
      assert.strictEqual(
        fs.readFileSync(projectXmlPath).equals(fs.readFileSync(path.join(dumpDir, 'Catalogs', 'Объект.xml'))),
        true,
        'Файл должен быть восстановлен из снапшота.'
      );
      assert.ok(result.backups.some((b: { projectPath: string }) => path.resolve(b.projectPath) === path.resolve(extraPath)), 'Удаляемый лишний файл должен быть забэкаплен.');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('манифест v1 ({files}, без хешей, с копией содержимого в files/<rel>) читается корректно', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-legacy-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
      const fullName = 'Справочник.Легаси';
      const snapshotDir = legacySnapshotDir(workspaceRoot, target, fullName);
      fs.mkdirSync(path.join(snapshotDir, 'files', 'Catalogs'), { recursive: true });
      const legacyContent = '<MetaDataObject legacy="true"/>';
      fs.writeFileSync(path.join(snapshotDir, 'files', 'Catalogs', 'Легаси.xml'), legacyContent, 'utf-8');
      fs.writeFileSync(
        path.join(snapshotDir, 'manifest.json'),
        `${JSON.stringify({ files: ['Catalogs/Легаси.xml'] }, null, 2)}\n`,
        'utf-8'
      );

      const hashes = store.readSnapshotHashes(target, fullName);
      assert.ok(hashes, 'Манифест v1 должен читаться, а не игнорироваться как повреждённый.');
      assert.strictEqual(hashes['Catalogs/Легаси.xml'], computeFileHash(path.join(snapshotDir, 'files', 'Catalogs', 'Легаси.xml')));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('битый манифест (не JSON) трактуется как отсутствие снапшота, а не как ошибка', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-broken-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      const snapshotDir = legacySnapshotDir(workspaceRoot, target, 'Справочник.Битый');
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), '{ не json', 'utf-8');

      assert.doesNotThrow(() => store.readSnapshotHashes(target, 'Справочник.Битый'));
      assert.strictEqual(store.readSnapshotHashes(target, 'Справочник.Битый'), undefined);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('discardAll удаляет и корневой манифест, и все снапшоты объектов данной цели', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-discard-all-'));
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-discard-all-dump-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
      writeConfigurationXml(configRoot, fixtureUuid('snap-discard-config'));
      writeConfigurationXml(dumpDir, fixtureUuid('snap-discard-dump-config'));
      writeObjectXml(dumpDir, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('snap-discard-object'), 'flat');
      const scope = resolveObjectScope(dumpDir, 'Справочник.Объект', target) as Extract<ObjectScope, { kind: 'object' }>;
      store.captureFromDirectory(target, 'Справочник.Объект', dumpDir, scope);
      store.captureRootManifest(target);

      assert.ok(store.readSnapshotHashes(target, 'Справочник.Объект'));
      assert.strictEqual(store.diffRootManifest(target).hasManifest, true);

      store.discardAll(target);

      assert.strictEqual(store.readSnapshotHashes(target, 'Справочник.Объект'), undefined);
      assert.strictEqual(store.diffRootManifest(target).hasManifest, false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });
});

suite('RepositoryLockSnapshotStore — captureRootManifest/diffRootManifest (issue #1, рекурсивный корень)', () => {
  test('без манифеста — hasManifest:false, owners пуст', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-root-none-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      writeConfigurationXml(configRoot, fixtureUuid('snap-root-none-config'));
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
      const diff = store.diffRootManifest(target);
      assert.deepStrictEqual(diff, { owners: [], hasManifest: false });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('изменение файлов у двух объектов и появление нового файла → owners содержит обоих владельцев', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-root-diff-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      writeConfigurationXml(configRoot, fixtureUuid('snap-root-diff-config'));
      const aXmlPath = writeObjectXml(configRoot, 'Catalogs', 'А', 'Catalog', fixtureUuid('snap-root-diff-a'), 'flat');
      writeObjectXml(configRoot, 'Catalogs', 'Б', 'Catalog', fixtureUuid('snap-root-diff-b'), 'flat');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };

      store.captureRootManifest(target);
      assert.strictEqual(store.diffRootManifest(target).hasManifest, true);
      assert.deepStrictEqual(store.diffRootManifest(target).owners, [], 'Сразу после снятия манифеста изменений быть не должно.');

      fs.writeFileSync(aXmlPath, '<MetaDataObject changed="true"/>', 'utf-8');
      fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Новый.xml'), '<MetaDataObject/>', 'utf-8');

      const diff = store.diffRootManifest(target);
      assert.strictEqual(diff.hasManifest, true);
      assert.deepStrictEqual([...diff.owners].sort(), ['Справочник.А', 'Справочник.Новый'].sort());
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('удаление файла владельца тоже отражается в owners', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-root-delete-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      writeConfigurationXml(configRoot, fixtureUuid('snap-root-delete-config'));
      const xmlPath = writeObjectXml(configRoot, 'Catalogs', 'Удаляемый', 'Catalog', fixtureUuid('snap-root-delete-object'), 'flat');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };

      store.captureRootManifest(target);
      fs.unlinkSync(xmlPath);

      const diff = store.diffRootManifest(target);
      assert.deepStrictEqual(diff.owners, ['Справочник.Удаляемый']);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('ConfigDumpInfo.xml не участвует в хеш-манифесте корня', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-root-nodumpinfo-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      writeConfigurationXml(configRoot, fixtureUuid('snap-root-nodumpinfo-config'));
      fs.writeFileSync(path.join(configRoot, 'ConfigDumpInfo.xml'), '<ConfigDumpInfo/>', 'utf-8');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };

      store.captureRootManifest(target);
      fs.writeFileSync(path.join(configRoot, 'ConfigDumpInfo.xml'), '<ConfigDumpInfo changed="true"/>', 'utf-8');

      assert.deepStrictEqual(store.diffRootManifest(target).owners, [], 'Изменение ConfigDumpInfo.xml не должно порождать ложный owner.');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

/**
 * Раздел 10, Р8: манифест снимка v3 (`{version:3, files, hashes, depth,
 * subordinates?}`). `readSnapshotInfo` — новый экспорт (см. 10.3): в отличие от
 * `readSnapshotHashes` (только хеши, для обратной совместимости), возвращает
 * ещё и `depth`, и (для владельцев с подчинёнными единицами) список
 * `subordinates`, известных на момент захвата — нужен для «эталона empty без
 * Конфигуратора» (Р8, п.3: у ближайшего предка снимок v3 с `subordinates` БЕЗ
 * этой единицы → единица создана локально, эталон «пусто»).
 * Манифесты v1/v2 (без поля `depth`) читаются как `depth:'tree'`, без
 * `subordinates` — тест на реальном примере из `example/2.21/src/cf`
 * (Контрагенты) с уже существующей глубокой раскладкой.
 */
suite('RepositoryLockSnapshotStore — readSnapshotInfo и манифест v3 (issue #1, раздел 10, Р8)', () => {
  test('captureFromDirectory с явным depth:"unit" и subordinates — readSnapshotInfo возвращает их обратно', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-v3-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
      const scope = resolveObjectScope(EXAMPLE_CF, 'Справочник.Контрагенты', target, 'unit') as Extract<ObjectScope, { kind: 'object' }>;
      const subordinates = [
        'Справочник.Контрагенты.Форма.ФормаЭлемента',
        'Справочник.Контрагенты.Форма.ФормаСписка',
        'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла',
      ];
      store.captureFromDirectory(target, 'Справочник.Контрагенты', EXAMPLE_CF, scope, [], 'unit', subordinates);

      const info = store.readSnapshotInfo(target, 'Справочник.Контрагенты');
      assert.ok(info);
      assert.strictEqual(info.depth, 'unit');
      assert.deepStrictEqual([...(info.subordinates ?? [])].sort(), [...subordinates].sort());
      assert.strictEqual(info.hashes['Catalogs/Контрагенты.xml'], computeFileHash(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml')));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('captureFromDirectory БЕЗ явного depth — по умолчанию "unit" (единицы — обычный современный случай)', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-v3-default-'));
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-v3-default-dump-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const configRoot = path.join(workspaceRoot, 'src', 'cf');
      const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'Тест' };
      writeConfigurationXml(dumpDir, fixtureUuid('snap-v3-default-config'));
      writeObjectXml(dumpDir, 'Catalogs', 'Объект', 'Catalog', fixtureUuid('snap-v3-default-object'), 'flat');
      const scope = resolveObjectScope(dumpDir, 'Справочник.Объект', target) as Extract<ObjectScope, { kind: 'object' }>;

      store.captureFromDirectory(target, 'Справочник.Объект', dumpDir, scope);
      const info = store.readSnapshotInfo(target, 'Справочник.Объект');
      assert.ok(info);
      assert.strictEqual(info.depth, 'unit');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('манифест v1 (легаси, без depth) — readSnapshotInfo отдаёт depth:"tree", subordinates отсутствует', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-v3-legacy-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      const fullName = 'Справочник.Легаси';
      const snapshotDir = legacySnapshotDir(workspaceRoot, target, fullName);
      fs.mkdirSync(path.join(snapshotDir, 'files', 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(snapshotDir, 'files', 'Catalogs', 'Легаси.xml'), '<MetaDataObject legacy="true"/>', 'utf-8');
      fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), `${JSON.stringify({ files: ['Catalogs/Легаси.xml'] }, null, 2)}\n`, 'utf-8');

      const info = store.readSnapshotInfo(target, fullName);
      assert.ok(info);
      assert.strictEqual(info.depth, 'tree');
      assert.strictEqual(info.subordinates, undefined);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('нет снимка — readSnapshotInfo отдаёт undefined (как readSnapshotHashes)', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-v3-missing-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      assert.strictEqual(store.readSnapshotInfo(target, 'Справочник.Нет'), undefined);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Раздел 10, Р8: `restoreToProject` и сравнение отбрасывают файлы снимка вне
 * ТЕКУЩЕЙ (переданной вызывающим кодом) области — важно для старых глубоких
 * снимков (v1/v2, записанных до появления единиц: содержат файлы форм внутри
 * каталога владельца), которые при отмене захвата теперь сравниваются/
 * восстанавливаются С `unit`-областью (без форм) — иначе откат стал бы трогать
 * файлы форм, которые к этому моменту относятся к ДРУГИМ единицам со своими
 * снимками.
 */
suite('RepositoryLockSnapshotStore — restoreToProject отбрасывает файлы снимка вне текущей области (issue #1, раздел 10, Р8)', () => {
  test('старый (глубокий) снимок содержит файл формы — restoreToProject с unit-областью его игнорирует (не восстанавливает и не удаляет как лишний)', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-restore-scope-'));
    try {
      const store = new RepositoryLockSnapshotStore(workspaceRoot);
      const target: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
      // "Легаси"-снимок v2 — целиком копия каталога Контрагенты (включая Forms), как
      // было ДО раздела 10 (depth:'tree' по умолчанию у прежней реализации).
      const legacyScope = resolveObjectScope(EXAMPLE_CF, 'Справочник.Контрагенты', target, 'tree') as Extract<ObjectScope, { kind: 'object' }>;
      store.captureFromDirectory(target, 'Справочник.Контрагенты', EXAMPLE_CF, legacyScope, [], 'tree');

      // Проект — временная копия, где форма ФормаЭлемента изменена ЛОКАЛЬНО (владелец не тронут).
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-snap-restore-scope-project-'));
      try {
        fs.cpSync(EXAMPLE_CF, projectDir, { recursive: true });
        const formModulePath = path.join(projectDir, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl');
        fs.writeFileSync(formModulePath, `${fs.readFileSync(formModulePath, 'utf-8')}\n// локальная правка формы`, 'utf-8');

        const projectTarget: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'ТорговыйУчет' };
        // Восстанавливаем ТОЛЬКО область владельца (unit) — форма ей больше не принадлежит.
        const unitScope = resolveObjectScope(projectDir, 'Справочник.Контрагенты', projectTarget, 'unit') as Extract<ObjectScope, { kind: 'object' }>;
        const backupDir = path.join(workspaceRoot, '.v8vscedit', 'repository', 'merge', 'test', 'unlock');
        const result = store.restoreToProject(target, 'Справочник.Контрагенты', unitScope, backupDir);

        assert.ok(!result.restored.some((f: string) => path.resolve(f) === path.resolve(formModulePath)), 'Файл формы не должен восстанавливаться — он вне unit-области владельца.');
        assert.ok(!result.deleted.some((f: string) => path.resolve(f) === path.resolve(formModulePath)), 'Файл формы не должен считаться лишним — он вне unit-области владельца.');
        assert.ok(fs.readFileSync(formModulePath, 'utf-8').includes('локальная правка формы'), 'Локальная правка формы должна остаться нетронутой.');
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

/**
 * `diffOwnersAgainstBaseline` — раздел 10, Р8: теперь группирует изменения по
 * ЕДИНИЦЕ (`resolveLockUnitByRelativePath`), а не только по владельцу верхнего
 * уровня (`resolveOwnerFullNameByRelativePath`) — иначе изменение ОДНОЙ формы
 * при рекурсивном захвате корня заставило бы root-incremental перевыгружать
 * владельца целиком вместо одной формы (критерий приёмки 10.1.7/10.1.8).
 */
suite('RepositoryLockSnapshotStore — diffOwnersAgainstBaseline: группировка по единицам (issue #1, раздел 10, Р8)', () => {
  test('изменился файл ВНУТРИ формы — owners содержит fullName формы, а не только владельца', () => {
    const formModuleRel = 'Catalogs/Контрагенты/Forms/ФормаЭлемента/Ext/Form/Module.bsl';
    const baseline = { [formModuleRel]: 'старый-хеш' };
    const current = { [formModuleRel]: 'новый-хеш' };
    const diff = diffOwnersAgainstBaseline(cfTargetForDiff(), baseline, current);
    assert.deepStrictEqual(diff.owners, ['Справочник.Контрагенты.Форма.ФормаЭлемента']);
  });

  test('изменился файл владельца (не внутри подчинённой единицы) — owners содержит владельца, как раньше', () => {
    const ownerModuleRel = 'Catalogs/Контрагенты/Ext/ObjectModule.bsl';
    const baseline = { [ownerModuleRel]: 'старый-хеш' };
    const current = { [ownerModuleRel]: 'новый-хеш' };
    const diff = diffOwnersAgainstBaseline(cfTargetForDiff(), baseline, current);
    assert.deepStrictEqual(diff.owners, ['Справочник.Контрагенты']);
  });

  function cfTargetForDiff(): RepositoryTarget {
    return { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };
  }
});
