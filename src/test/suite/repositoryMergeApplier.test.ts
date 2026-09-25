import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyRepositoryMerge, buildMergeBackupDir } from '../../infra/repository/RepositoryMergeApplier';
import { planRepositoryMerge, collectMergeFileStates } from '../../infra/repository/RepositoryMergePlanner';
import { resolveObjectScope, type ObjectScope } from '../../infra/repository/RepositoryObjectScope';
import { buildScopeKey, computeFileHash, loadHashCache } from '../../infra/cache/HashCache';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { fixtureUuid, writeConfigurationXml, writeObjectXml } from './support/flatMetadataFixtures';

/**
 * `applyRepositoryMerge` — исполнитель уже готового `MergePlan`
 * (`RepositoryMergePlanner`): побайтовое копирование/удаление, бэкап
 * перезаписываемых/удаляемых локальных версий, патч хеш-кэша и — только для
 * `choice:'keep-local'` — сохранение версии хранилища отдельной копией (issue #1,
 * раздел «Поток «захват / получение»» плана архитектора, пп. A.4, A.8 и
 * «Esc/закрытие = keep-local»).
 */

function posix(p: string): string {
  return p.split(path.sep).join('/');
}

interface Fixture {
  dumpDir: string;
  projectDir: string;
  target: RepositoryTarget;
}

function createFixture(seed: string): Fixture {
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), `v8-merge-apply-dump-${seed}-`));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `v8-merge-apply-project-${seed}-`));
  writeConfigurationXml(dumpDir, fixtureUuid(`${seed}-dump-config`));
  writeConfigurationXml(projectDir, fixtureUuid(`${seed}-project-config`));
  return { dumpDir, projectDir, target: { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' } };
}

function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.dumpDir, { recursive: true, force: true });
  fs.rmSync(fixture.projectDir, { recursive: true, force: true });
}

suite('RepositoryMergeApplier — buildMergeBackupDir', () => {
  test('детерминирован для одинаковых аргументов и содержит workspaceRoot/scopeKey/label', () => {
    const now = new Date('2024-01-02T03:04:05.000Z');
    const a = buildMergeBackupDir('/ws', 'scope-1', 'lock', now);
    const b = buildMergeBackupDir('/ws', 'scope-1', 'lock', now);
    assert.strictEqual(a, b);
    assert.ok(posix(a).includes('scope-1'));
    assert.ok(posix(a).includes('lock'));
    assert.ok(posix(a).startsWith(posix(path.join('/ws', '.v8vscedit', 'repository', 'merge'))));
  });

  test('разные моменты времени дают разные каталоги (не коллизируют между операциями)', () => {
    const a = buildMergeBackupDir('/ws', 'scope-1', 'lock', new Date('2024-01-02T03:04:05.000Z'));
    const b = buildMergeBackupDir('/ws', 'scope-1', 'lock', new Date('2024-01-02T03:04:06.000Z'));
    assert.notStrictEqual(a, b);
  });

  test('разные scopeKey дают разные каталоги при одинаковых label/now', () => {
    const now = new Date('2024-01-02T03:04:05.000Z');
    const a = buildMergeBackupDir('/ws', 'scope-1', 'lock', now);
    const b = buildMergeBackupDir('/ws', 'scope-2', 'lock', now);
    assert.notStrictEqual(a, b);
  });
});

suite('RepositoryMergeApplier — applyRepositoryMerge: choice="replace"', () => {
  test('silent write копирует байты выгрузки поверх проекта (BOM+CRLF) и патчит хеш-кэш', () => {
    const fixture = createFixture('replace-write');
    try {
      const contentWithBomAndCrlf = `\uFEFF<MetaDataObject>\r\n<Catalog/>\r\n</MetaDataObject>`;
      fs.mkdirSync(path.join(fixture.dumpDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.dumpDir, 'Catalogs', 'Объект.xml'), contentWithBomAndCrlf, 'utf-8');

      const scope = resolveObjectScope(fixture.dumpDir, 'Справочник.Объект', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;
      const states = collectMergeFileStates({
        configRoot: fixture.projectDir,
        dumpDir: fixture.dumpDir,
        scopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });
      const plan = planRepositoryMerge(states);
      assert.strictEqual(plan.hasConflicts, false);

      const backupDir = buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date());
      const beforeWriteCalls: string[][] = [];
      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'replace',
        backupDir,
        beforeWrite: (filePaths: string[]) => beforeWriteCalls.push(filePaths),
      });

      const projectXmlPath = path.join(fixture.projectDir, 'Catalogs', 'Объект.xml');
      const writtenBytes = fs.readFileSync(projectXmlPath);
      assert.deepStrictEqual(writtenBytes, fs.readFileSync(path.join(fixture.dumpDir, 'Catalogs', 'Объект.xml')));
      assert.ok(writtenBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM должен сохраниться при побайтовом копировании.');
      assert.ok(result.writtenFiles.some((f: string) => path.resolve(f) === path.resolve(projectXmlPath)));
      assert.strictEqual(result.deletedFiles.length, 0);
      assert.strictEqual(result.keptLocalFiles.length, 0);
      assert.ok(beforeWriteCalls.length >= 1, 'beforeWrite должен вызываться до записи (suppressConfigurationReloadForFiles).');

      const scopeKey = buildScopeKey('cf', fixture.projectDir, '');
      const cache = loadHashCache(fixture.projectDir, scopeKey);
      assert.strictEqual(cache.files['Catalogs/Объект.xml'], computeFileHash(projectXmlPath));
    } finally {
      cleanup(fixture);
    }
  });

  test('silent delete удаляет файл и пустые каталоги в области, не трогая соседние объекты', () => {
    const fixture = createFixture('replace-delete');
    try {
      // Объект существует только в проекте — выгрузка (dump) его не содержит (сирота).
      writeObjectXml(fixture.projectDir, 'Catalogs', 'Удаляемый', 'Catalog', fixtureUuid('replace-delete-object'), 'deep');
      fs.mkdirSync(path.join(fixture.dumpDir, 'Catalogs'), { recursive: true });

      const scope = resolveObjectScope(fixture.projectDir, 'Справочник.Удаляемый', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;
      const localHash = computeFileHash(path.join(fixture.projectDir, 'Catalogs', 'Удаляемый', 'Удаляемый.xml'));
      const states = collectMergeFileStates({
        configRoot: fixture.projectDir,
        dumpDir: fixture.dumpDir,
        scopes: [scope],
        baseHashes: { 'Catalogs/Удаляемый/Удаляемый.xml': localHash },
        dirtyRelativePaths: [],
      });
      const plan = planRepositoryMerge(states);
      assert.strictEqual(plan.hasConflicts, false);

      const backupDir = buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date());
      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'replace',
        backupDir,
        beforeWrite: () => undefined,
      });

      assert.strictEqual(fs.existsSync(path.join(fixture.projectDir, 'Catalogs', 'Удаляемый')), false, 'Пустой каталог объекта должен быть удалён.');
      assert.ok(result.deletedFiles.length >= 1);

      const scopeKey = buildScopeKey('cf', fixture.projectDir, '');
      const cache = loadHashCache(fixture.projectDir, scopeKey);
      assert.ok(!cache.files['Catalogs/Удаляемый/Удаляемый.xml'], 'Удалённый файл должен исчезнуть из хеш-кэша.');
    } finally {
      cleanup(fixture);
    }
  });

  test('conflict-write: локальная версия бэкапится ДО перезаписи версией хранилища', () => {
    const fixture = createFixture('replace-conflict-write');
    try {
      fs.mkdirSync(path.join(fixture.dumpDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.dumpDir, 'Catalogs', 'Конфликт.xml'), 'версия хранилища', 'utf-8');
      fs.mkdirSync(path.join(fixture.projectDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.projectDir, 'Catalogs', 'Конфликт.xml'), 'локальная правка', 'utf-8');

      const scope = resolveObjectScope(fixture.projectDir, 'Справочник.Конфликт', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;
      const states = collectMergeFileStates({
        configRoot: fixture.projectDir,
        dumpDir: fixture.dumpDir,
        scopes: [scope],
        // baseHash отличается от текущего локального — гарантированный конфликт.
        baseHashes: { 'Catalogs/Конфликт.xml': 'какой-то-другой-хеш-базы' },
        dirtyRelativePaths: [],
      });
      const plan = planRepositoryMerge(states);
      assert.strictEqual(plan.hasConflicts, true);

      const backupDir = buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date());
      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'replace',
        backupDir,
        beforeWrite: () => undefined,
      });

      const projectXmlPath = path.join(fixture.projectDir, 'Catalogs', 'Конфликт.xml');
      assert.strictEqual(fs.readFileSync(projectXmlPath, 'utf-8'), 'версия хранилища');
      assert.strictEqual(result.backups.length, 1);
      const backupEntry = result.backups[0];
      assert.strictEqual(posix(backupEntry.rel), 'Catalogs/Конфликт.xml');
      assert.strictEqual(fs.readFileSync(backupEntry.backupPath, 'utf-8'), 'локальная правка', 'Бэкап должен содержать локальную версию ДО перезаписи.');
      assert.strictEqual(path.resolve(backupEntry.projectPath), path.resolve(projectXmlPath));
    } finally {
      cleanup(fixture);
    }
  });

  test('изменение хеша между планированием и применением всё равно приводит к бэкапу (защита от гонки)', () => {
    const fixture = createFixture('replace-race');
    try {
      fs.mkdirSync(path.join(fixture.dumpDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.dumpDir, 'Catalogs', 'Гонка.xml'), 'версия хранилища', 'utf-8');
      fs.mkdirSync(path.join(fixture.projectDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.projectDir, 'Catalogs', 'Гонка.xml'), 'версия на момент планирования', 'utf-8');

      const scope = resolveObjectScope(fixture.projectDir, 'Справочник.Гонка', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;
      const planTimeHash = computeFileHash(path.join(fixture.projectDir, 'Catalogs', 'Гонка.xml'));
      const states = collectMergeFileStates({
        configRoot: fixture.projectDir,
        dumpDir: fixture.dumpDir,
        scopes: [scope],
        baseHashes: { 'Catalogs/Гонка.xml': planTimeHash },
        dirtyRelativePaths: [],
      });
      const plan = planRepositoryMerge(states);
      assert.strictEqual(plan.hasConflicts, false, 'На момент планирования это тихая запись (L===B).');

      // Файл изменился ПОСЛЕ построения плана, но ДО применения — гонка вне аренды guard'а.
      fs.writeFileSync(path.join(fixture.projectDir, 'Catalogs', 'Гонка.xml'), 'правка во время гонки', 'utf-8');

      const backupDir = buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date());
      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'replace',
        backupDir,
        beforeWrite: () => undefined,
      });

      assert.strictEqual(result.backups.length, 1, 'Файл, чей хеш разошёлся с планом, должен быть забэкаплен даже при "тихом" действии.');
      assert.strictEqual(fs.readFileSync(result.backups[0].backupPath, 'utf-8'), 'правка во время гонки');
      assert.strictEqual(fs.readFileSync(path.join(fixture.projectDir, 'Catalogs', 'Гонка.xml'), 'utf-8'), 'версия хранилища');
    } finally {
      cleanup(fixture);
    }
  });

  test('ConfigDumpInfo.xml из выгрузки не копируется в проект', () => {
    const fixture = createFixture('replace-no-dumpinfo');
    try {
      fs.writeFileSync(path.join(fixture.dumpDir, 'ConfigDumpInfo.xml'), '<ConfigDumpInfo/>', 'utf-8');
      writeObjectXml(fixture.dumpDir, 'Catalogs', 'Обычный', 'Catalog', fixtureUuid('replace-no-dumpinfo-object'), 'flat');

      const scope = resolveObjectScope(fixture.dumpDir, 'Справочник.Обычный', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;
      const states = collectMergeFileStates({
        configRoot: fixture.projectDir,
        dumpDir: fixture.dumpDir,
        scopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });
      const rels = states.map((s: { rel: string }) => posix(s.rel));
      assert.ok(!rels.includes('ConfigDumpInfo.xml'), 'ConfigDumpInfo.xml не должен появляться в состояниях области объекта.');

      const plan = planRepositoryMerge(states);
      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'replace',
        backupDir: buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date()),
        beforeWrite: () => undefined,
      });

      assert.strictEqual(fs.existsSync(path.join(fixture.projectDir, 'ConfigDumpInfo.xml')), false);
      assert.ok(!result.writtenFiles.some((f: string) => f.includes('ConfigDumpInfo')));
    } finally {
      cleanup(fixture);
    }
  });
});

suite('RepositoryMergeApplier — applyRepositoryMerge: choice="keep-local"', () => {
  test('конфликтные файлы не перезаписываются, версия хранилища сохраняется отдельной копией, хеш-кэш = хеш хранилища', () => {
    const fixture = createFixture('keep-local');
    try {
      fs.mkdirSync(path.join(fixture.dumpDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.dumpDir, 'Catalogs', 'Оставляем.xml'), 'версия хранилища', 'utf-8');
      fs.mkdirSync(path.join(fixture.projectDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.projectDir, 'Catalogs', 'Оставляем.xml'), 'локальная правка', 'utf-8');

      const scope = resolveObjectScope(fixture.projectDir, 'Справочник.Оставляем', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;
      const states = collectMergeFileStates({
        configRoot: fixture.projectDir,
        dumpDir: fixture.dumpDir,
        scopes: [scope],
        baseHashes: { 'Catalogs/Оставляем.xml': 'другой-хеш-базы' },
        dirtyRelativePaths: [],
      });
      const plan = planRepositoryMerge(states);
      assert.strictEqual(plan.hasConflicts, true);

      const backupDir = buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date());
      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'keep-local',
        backupDir,
        beforeWrite: () => undefined,
      });

      const projectXmlPath = path.join(fixture.projectDir, 'Catalogs', 'Оставляем.xml');
      assert.strictEqual(fs.readFileSync(projectXmlPath, 'utf-8'), 'локальная правка', 'Локальный файл не должен трогаться при keep-local.');
      assert.strictEqual(result.writtenFiles.length, 0);
      assert.strictEqual(result.deletedFiles.length, 0);
      assert.ok(result.keptLocalFiles.some((f: string) => path.resolve(f) === path.resolve(projectXmlPath)));

      assert.strictEqual(result.repositoryCopies.length, 1);
      const repoCopy = result.repositoryCopies[0];
      assert.strictEqual(posix(repoCopy.rel), 'Catalogs/Оставляем.xml');
      assert.strictEqual(fs.readFileSync(repoCopy.repositoryPath, 'utf-8'), 'версия хранилища');

      const scopeKey = buildScopeKey('cf', fixture.projectDir, '');
      const cache = loadHashCache(fixture.projectDir, scopeKey);
      assert.strictEqual(cache.files['Catalogs/Оставляем.xml'], computeFileHash(path.join(fixture.dumpDir, 'Catalogs', 'Оставляем.xml')), 'При keep-local хеш-кэш обязан отражать хеш версии хранилища, а не локального файла.');
    } finally {
      cleanup(fixture);
    }
  });

  test('несвязанные с конфликтом silent-записи всё равно применяются при keep-local', () => {
    const fixture = createFixture('keep-local-mixed');
    try {
      fs.mkdirSync(path.join(fixture.dumpDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.dumpDir, 'Catalogs', 'Конфликтный.xml'), 'версия хранилища', 'utf-8');
      fs.writeFileSync(path.join(fixture.dumpDir, 'Catalogs', 'Новый.xml'), 'новый объект из хранилища', 'utf-8');
      fs.mkdirSync(path.join(fixture.projectDir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(fixture.projectDir, 'Catalogs', 'Конфликтный.xml'), 'локальная правка', 'utf-8');

      const conflictScope = resolveObjectScope(fixture.projectDir, 'Справочник.Конфликтный', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;
      const newScope = resolveObjectScope(fixture.dumpDir, 'Справочник.Новый', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;

      const states = collectMergeFileStates({
        configRoot: fixture.projectDir,
        dumpDir: fixture.dumpDir,
        scopes: [conflictScope, newScope],
        baseHashes: { 'Catalogs/Конфликтный.xml': 'другой-хеш-базы' },
        dirtyRelativePaths: [],
      });
      const plan = planRepositoryMerge(states);
      assert.strictEqual(plan.hasConflicts, true);
      assert.ok(plan.silent.some((s: { rel: string }) => posix(s.rel) === 'Catalogs/Новый.xml'));

      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'keep-local',
        backupDir: buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date()),
        beforeWrite: () => undefined,
      });

      assert.ok(fs.existsSync(path.join(fixture.projectDir, 'Catalogs', 'Новый.xml')), 'Несвязанный с конфликтом новый файл должен быть записан независимо от choice.');
      assert.strictEqual(fs.readFileSync(path.join(fixture.projectDir, 'Catalogs', 'Конфликтный.xml'), 'utf-8'), 'локальная правка');
      assert.ok(result.writtenFiles.some((f: string) => f.includes('Новый.xml')));
    } finally {
      cleanup(fixture);
    }
  });

  test('conflict-delete (сирота, отсутствует в хранилище) при keep-local: файл остаётся, из хеш-кэша убирается (repositoryHash===null)', () => {
    const fixture = createFixture('keep-local-conflict-delete');
    try {
      fs.mkdirSync(path.join(fixture.projectDir, 'Catalogs'), { recursive: true });
      const orphanPath = path.join(fixture.projectDir, 'Catalogs', 'Сирота.xml');
      fs.writeFileSync(orphanPath, 'локальная правка сироты', 'utf-8');

      // Сирота есть только в проекте (removedScopes) — версии хранилища для неё нет.
      const orphanScope = resolveObjectScope(fixture.projectDir, 'Справочник.Сирота', fixture.target) as Extract<ObjectScope, { kind: 'object' }>;
      const states = collectMergeFileStates({
        configRoot: fixture.projectDir,
        dumpDir: fixture.dumpDir,
        scopes: [],
        removedScopes: [orphanScope],
        baseHashes: { 'Catalogs/Сирота.xml': 'другой-хеш-базы' },
        dirtyRelativePaths: [],
      });
      const plan = planRepositoryMerge(states);
      assert.strictEqual(plan.conflicts[0]?.action, 'conflict-delete');

      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'keep-local',
        backupDir: buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date()),
        beforeWrite: () => undefined,
      });

      assert.strictEqual(fs.readFileSync(orphanPath, 'utf-8'), 'локальная правка сироты', 'Файл при keep-local не трогается.');
      assert.deepStrictEqual(result.keptLocalFiles.map((f: string) => path.resolve(f)), [path.resolve(orphanPath)]);
      assert.strictEqual(result.repositoryCopies.length, 0, 'Версии хранилища нет — копировать нечего.');

      const scopeKey = buildScopeKey('cf', fixture.projectDir, '');
      const cache = loadHashCache(fixture.projectDir, scopeKey);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(cache.files, 'Catalogs/Сирота.xml'), false, 'Запись без версии хранилища должна быть убрана из хеш-кэша.');
    } finally {
      cleanup(fixture);
    }
  });

  test('delete-запись без scope (fallback ?? ALL_SCOPE в removeEmptyParentDirs) — файл удаляется без ошибки', () => {
    const fixture = createFixture('delete-no-scope');
    try {
      fs.mkdirSync(path.join(fixture.projectDir, 'Catalogs'), { recursive: true });
      const filePath = path.join(fixture.projectDir, 'Catalogs', 'БезОбласти.xml');
      fs.writeFileSync(filePath, 'удаляемое содержимое', 'utf-8');

      const plan = {
        entries: [{ rel: 'Catalogs/БезОбласти.xml', repositoryHash: null, localHash: computeFileHash(filePath), baseHash: computeFileHash(filePath), action: 'delete' as const }],
        conflicts: [],
        silent: [],
        skipped: [],
        hasConflicts: false,
      };

      const result = applyRepositoryMerge({
        projectRoot: fixture.projectDir,
        target: fixture.target,
        dumpDir: fixture.dumpDir,
        plan,
        choice: 'replace',
        backupDir: buildMergeBackupDir(fixture.projectDir, 'scope', 'lock', new Date()),
        beforeWrite: () => undefined,
      });

      assert.strictEqual(fs.existsSync(filePath), false);
      assert.deepStrictEqual(result.deletedFiles.map((f: string) => path.resolve(f)), [path.resolve(filePath)]);
    } finally {
      cleanup(fixture);
    }
  });
});
