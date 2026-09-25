import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  planRepositoryMerge,
  collectMergeFileStates,
  isTextMergeFile,
  diffScopeAgainstEtalon,
  type MergeFileState,
  type MergeAction,
} from '../../infra/repository/RepositoryMergePlanner';
import { resolveObjectScope, type ObjectScope } from '../../infra/repository/RepositoryObjectScope';
import { computeFileHash } from '../../infra/cache/HashCache';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { fixtureUuid, writeConfigurationXml, writeObjectXml } from './support/flatMetadataFixtures';

/**
 * `planRepositoryMerge` — чистая функция трёхстороннего сравнения R (хранилище/
 * temp-выгрузка) / L (локальный файл проекта) / B (последняя известная база из
 * хеш-кэша либо снапшота захвата), issue #1, «План тестов» п.5 и раздел
 * «Поток «захват / получение»» плана архитектора, пп. A.1–A.2:
 *   при наличии R: L===R → noop; L===B (файл не менялся с базы) → write молча;
 *     нет L и нет B (совсем новый файл) → write молча; иначе (расхождение) → conflict-write;
 *   при отсутствии R (файл — «сирота» относительно новой выгрузки): L===B → delete молча,
 *     иначе → conflict-delete.
 * Дополнительные, не связанные с R/L/B флаги СОСТОЯНИЯ имеют приоритет над этой
 * таблицей: `incomplete` (защита от неполной частичной выгрузки, см. дефект №4
 * плана) → всегда `skip-incomplete`; `forceConflict` (несохранённый редактор,
 * раздел A.1) → всегда конфликт (write/delete в зависимости от наличия R).
 */

function state(overrides: Partial<MergeFileState> & { rel: string }): MergeFileState {
  return {
    repositoryHash: null,
    localHash: null,
    baseHash: null,
    ...overrides,
  };
}

function actionOf(s: MergeFileState): MergeAction {
  const plan = planRepositoryMerge([s]);
  const entry = plan.entries.find((e: { rel: string; action: MergeAction }) => e.rel === s.rel);
  assert.ok(entry, `Не найдена запись плана для "${s.rel}".`);
  return entry.action;
}

suite('RepositoryMergePlanner — planRepositoryMerge: таблица R/L/B', () => {
  test('R присутствует, L===R → noop', () => {
    assert.strictEqual(actionOf(state({ rel: 'a', repositoryHash: 'h1', localHash: 'h1', baseHash: 'h0' })), 'noop');
  });

  test('R присутствует, L!==R, но L===B (локально не менялся с базы) → write (молча)', () => {
    assert.strictEqual(actionOf(state({ rel: 'a', repositoryHash: 'h1', localHash: 'h0', baseHash: 'h0' })), 'write');
  });

  test('R присутствует, нет L и нет B (совсем новый файл) → write (молча)', () => {
    assert.strictEqual(actionOf(state({ rel: 'a', repositoryHash: 'h1', localHash: null, baseHash: null })), 'write');
  });

  test('R присутствует, есть B, но нет L (локально удалён, но был известен) → conflict-write', () => {
    assert.strictEqual(actionOf(state({ rel: 'a', repositoryHash: 'h1', localHash: null, baseHash: 'h0' })), 'conflict-write');
  });

  test('R присутствует, L расходится и с R, и с B → conflict-write', () => {
    assert.strictEqual(
      actionOf(state({ rel: 'a', repositoryHash: 'h1', localHash: 'h-local', baseHash: 'h0' })),
      'conflict-write'
    );
  });

  test('R отсутствует (сирота), L===B → delete (молча)', () => {
    assert.strictEqual(actionOf(state({ rel: 'a', repositoryHash: null, localHash: 'h0', baseHash: 'h0' })), 'delete');
  });

  test('R отсутствует (сирота), L расходится с B → conflict-delete', () => {
    assert.strictEqual(
      actionOf(state({ rel: 'a', repositoryHash: null, localHash: 'h-local', baseHash: 'h0' })),
      'conflict-delete'
    );
  });

  test('R отсутствует, B отсутствует, но локальный файл есть (никогда не был в кэше) → conflict-delete', () => {
    assert.strictEqual(actionOf(state({ rel: 'a', repositoryHash: null, localHash: 'h-local', baseHash: null })), 'conflict-delete');
  });

  test('нигде нет файла (R, L и B все отсутствуют) — защитная ветка: noop, а не удаление несуществующего', () => {
    assert.strictEqual(actionOf(state({ rel: 'a', repositoryHash: null, localHash: null, baseHash: null })), 'noop');
  });

  test('incomplete=true имеет приоритет над таблицей R/L/B → всегда skip-incomplete', () => {
    assert.strictEqual(
      actionOf(state({ rel: 'a', repositoryHash: null, localHash: 'h-local', baseHash: 'h0', incomplete: true })),
      'skip-incomplete'
    );
    assert.strictEqual(
      actionOf(state({ rel: 'a', repositoryHash: 'h1', localHash: 'h1', baseHash: 'h1', incomplete: true })),
      'skip-incomplete'
    );
  });

  test('forceConflict=true (несохранённый редактор) переопределяет write/delete на conflict, при R — conflict-write', () => {
    assert.strictEqual(
      actionOf(state({ rel: 'a', repositoryHash: 'h1', localHash: 'h1', baseHash: 'h1', forceConflict: true })),
      'conflict-write'
    );
  });

  test('forceConflict=true без R → conflict-delete', () => {
    assert.strictEqual(
      actionOf(state({ rel: 'a', repositoryHash: null, localHash: 'h0', baseHash: 'h0', forceConflict: true })),
      'conflict-delete'
    );
  });
});

suite('RepositoryMergePlanner — planRepositoryMerge: агрегация MergePlan', () => {
  test('conflicts/silent/skipped корректно разложены, hasConflicts=true при наличии конфликтов', () => {
    const states: MergeFileState[] = [
      state({ rel: 'noop.xml', repositoryHash: 'h1', localHash: 'h1', baseHash: 'h1' }),
      state({ rel: 'write.xml', repositoryHash: 'h1', localHash: 'h0', baseHash: 'h0' }),
      state({ rel: 'delete.xml', repositoryHash: null, localHash: 'h0', baseHash: 'h0' }),
      state({ rel: 'conflict-write.xml', repositoryHash: 'h1', localHash: 'h-local', baseHash: 'h0' }),
      state({ rel: 'conflict-delete.xml', repositoryHash: null, localHash: 'h-local', baseHash: 'h0' }),
      state({ rel: 'skip.xml', repositoryHash: null, localHash: 'h-local', baseHash: 'h0', incomplete: true }),
    ];

    const plan = planRepositoryMerge(states);

    assert.strictEqual(plan.hasConflicts, true);
    assert.deepStrictEqual(plan.silent.map((s: MergeFileState) => s.rel).sort(), ['delete.xml', 'write.xml']);
    assert.deepStrictEqual(plan.conflicts.map((s: MergeFileState) => s.rel).sort(), ['conflict-delete.xml', 'conflict-write.xml']);
    assert.deepStrictEqual(plan.skipped.map((s: MergeFileState) => s.rel), ['skip.xml']);
    assert.strictEqual(plan.entries.length, states.length);
  });

  test('без конфликтов — hasConflicts=false, conflicts пуст', () => {
    const states: MergeFileState[] = [
      state({ rel: 'noop.xml', repositoryHash: 'h1', localHash: 'h1', baseHash: 'h1' }),
      state({ rel: 'write.xml', repositoryHash: 'h1', localHash: null, baseHash: null }),
    ];
    const plan = planRepositoryMerge(states);
    assert.strictEqual(plan.hasConflicts, false);
    assert.deepStrictEqual(plan.conflicts, []);
  });

  test('пустой список состояний → пустой план без конфликтов', () => {
    const plan = planRepositoryMerge([]);
    assert.deepStrictEqual(plan, { entries: [], conflicts: [], silent: [], skipped: [], hasConflicts: false });
  });
});

suite('RepositoryMergePlanner — isTextMergeFile', () => {
  const CASES: readonly [string, boolean][] = [
    ['Module.bsl', true],
    ['Object.xml', true],
    ['README.txt', true],
    ['ru.html', true],
    ['manifest.json', true],
    ['Template.bin', false],
    ['Значок.png', false],
    ['Архив.zip', false],
    ['БезРасширения', false],
  ];

  CASES.forEach(([rel, expected]) => {
    test(`"${rel}" → ${expected ? 'текстовый' : 'бинарный/неизвестный'}`, () => {
      assert.strictEqual(isTextMergeFile(rel), expected);
    });
  });

  test('регистр расширения не важен (.BSL, .XML)', () => {
    assert.strictEqual(isTextMergeFile('Module.BSL'), true);
    assert.strictEqual(isTextMergeFile('Object.XML'), true);
  });
});

suite('RepositoryMergePlanner — diffScopeAgainstEtalon', () => {
  test('изменённые/отсутствующие/лишние файлы относительно эталона', () => {
    const etalon = { 'a.xml': 'h1', 'b.xml': 'h2', 'c.xml': 'h3' };
    const current = { 'a.xml': 'h1', 'b.xml': 'h2-changed', 'd.xml': 'h4' };
    const diff = diffScopeAgainstEtalon(etalon, current);
    assert.deepStrictEqual(diff.changed, ['b.xml']);
    assert.deepStrictEqual(diff.missing, ['c.xml']);
    assert.deepStrictEqual(diff.extra, ['d.xml']);
  });

  test('идентичные карты → пустой diff', () => {
    const map = { 'a.xml': 'h1' };
    assert.deepStrictEqual(diffScopeAgainstEtalon(map, map), { changed: [], missing: [], extra: [] });
  });

  test('пустой эталон и пустое текущее состояние → пустой diff', () => {
    assert.deepStrictEqual(diffScopeAgainstEtalon({}, {}), { changed: [], missing: [], extra: [] });
  });
});

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const cfTarget: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };

suite('RepositoryMergePlanner — collectMergeFileStates (реальная ФС)', () => {
  test('файл только в выгрузке (новый объект) — repositoryHash задан, localHash/baseHash отсутствуют', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-new-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-project-'));
    try {
      writeConfigurationXml(tempDir, fixtureUuid('merge-new-dump'));
      writeConfigurationXml(projectDir, fixtureUuid('merge-new-project'));
      const dumpXmlPath = writeObjectXml(tempDir, 'Catalogs', 'Новый', 'Catalog', fixtureUuid('merge-new-object'), 'flat');

      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(tempDir, 'Справочник.Новый', target) as Extract<ObjectScope, { kind: 'object' }>;
      assert.ok(scope);

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir: tempDir,
        scopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });

      const xmlState = states.find((s: MergeFileState) => s.rel.replace(/\\/g, '/') === 'Catalogs/Новый.xml');
      assert.ok(xmlState, 'Должно быть состояние для нового XML-файла из выгрузки.');
      assert.strictEqual(xmlState.repositoryHash, computeFileHash(dumpXmlPath));
      assert.strictEqual(xmlState.localHash, null);
      assert.strictEqual(xmlState.baseHash, null);
      assert.strictEqual(xmlState.forceConflict ?? false, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('файл есть и в проекте, и в выгрузке — localHash/repositoryHash из реального содержимого, baseHash из переданной карты', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-both-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-project2-'));
    try {
      writeConfigurationXml(tempDir, fixtureUuid('merge-both-dump'));
      writeConfigurationXml(projectDir, fixtureUuid('merge-both-project'));
      writeObjectXml(tempDir, 'Catalogs', 'Общий', 'Catalog', fixtureUuid('merge-both-object-dump'), 'flat');
      const projectXmlPath = writeObjectXml(projectDir, 'Catalogs', 'Общий', 'Catalog', fixtureUuid('merge-both-object-project'), 'flat');

      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(projectDir, 'Справочник.Общий', target) as Extract<ObjectScope, { kind: 'object' }>;

      const localHash = computeFileHash(projectXmlPath);
      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir: tempDir,
        scopes: [scope],
        baseHashes: { 'Catalogs/Общий.xml': localHash },
        dirtyRelativePaths: [],
      });

      const xmlState = states.find((s: MergeFileState) => s.rel.replace(/\\/g, '/') === 'Catalogs/Общий.xml');
      assert.ok(xmlState);
      assert.strictEqual(xmlState.localHash, localHash);
      assert.strictEqual(xmlState.baseHash, localHash);
      assert.notStrictEqual(xmlState.repositoryHash, null);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('файл только в проекте (сирота относительно области выгрузки) — repositoryHash=null', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-orphan-dump-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-orphan-project-'));
    try {
      writeConfigurationXml(tempDir, fixtureUuid('merge-orphan-dump'));
      writeConfigurationXml(projectDir, fixtureUuid('merge-orphan-project'));
      // В выгрузке (temp) объекта нет вовсе — только XML-файл (без каталога Ext) в проекте.
      writeObjectXml(tempDir, 'Catalogs', 'Сирота', 'Catalog', fixtureUuid('merge-orphan-object-empty'), 'flat');
      fs.unlinkSync(path.join(tempDir, 'Catalogs', 'Сирота.xml'));
      const projectXmlPath = writeObjectXml(projectDir, 'Catalogs', 'Сирота', 'Catalog', fixtureUuid('merge-orphan-object'), 'flat');

      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(projectDir, 'Справочник.Сирота', target) as Extract<ObjectScope, { kind: 'object' }>;

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir: tempDir,
        scopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });

      const xmlState = states.find((s: MergeFileState) => s.rel.replace(/\\/g, '/') === 'Catalogs/Сирота.xml');
      assert.ok(xmlState);
      assert.strictEqual(xmlState.repositoryHash, null);
      assert.strictEqual(xmlState.localHash, computeFileHash(projectXmlPath));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('dirtyRelativePaths помечает состояние forceConflict=true', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-dirty-dump-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-dirty-project-'));
    try {
      writeConfigurationXml(tempDir, fixtureUuid('merge-dirty-dump'));
      writeConfigurationXml(projectDir, fixtureUuid('merge-dirty-project'));
      writeObjectXml(tempDir, 'Catalogs', 'Грязный', 'Catalog', fixtureUuid('merge-dirty-object-dump'), 'flat');
      writeObjectXml(projectDir, 'Catalogs', 'Грязный', 'Catalog', fixtureUuid('merge-dirty-object-project'), 'flat');

      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(projectDir, 'Справочник.Грязный', target) as Extract<ObjectScope, { kind: 'object' }>;

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir: tempDir,
        scopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: ['Catalogs/Грязный.xml'],
      });

      const xmlState = states.find((s: MergeFileState) => s.rel.replace(/\\/g, '/') === 'Catalogs/Грязный.xml');
      assert.ok(xmlState);
      assert.strictEqual(xmlState.forceConflict, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('snapshotHashes используется как fallback базы для файлов вне хеш-кэша', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-snap-dump-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-snap-project-'));
    try {
      writeConfigurationXml(tempDir, fixtureUuid('merge-snap-dump'));
      writeConfigurationXml(projectDir, fixtureUuid('merge-snap-project'));
      writeObjectXml(tempDir, 'Catalogs', 'Снапшот', 'Catalog', fixtureUuid('merge-snap-object-dump'), 'flat');
      const projectXmlPath = writeObjectXml(projectDir, 'Catalogs', 'Снапшот', 'Catalog', fixtureUuid('merge-snap-object-project'), 'flat');

      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(projectDir, 'Справочник.Снапшот', target) as Extract<ObjectScope, { kind: 'object' }>;
      const localHash = computeFileHash(projectXmlPath);

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir: tempDir,
        scopes: [scope],
        baseHashes: {},
        snapshotHashes: { 'Catalogs/Снапшот.xml': localHash },
        dirtyRelativePaths: [],
      });

      const xmlState = states.find((s: MergeFileState) => s.rel.replace(/\\/g, '/') === 'Catalogs/Снапшот.xml');
      assert.ok(xmlState);
      assert.strictEqual(xmlState.baseHash, localHash, 'При отсутствии файла в хеш-кэше должна использоваться база из снапшота захвата.');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  /**
   * Регресс D2b (раздел 10 плана, критерий приёмки 10.1.4): раньше
   * `collectIncompleteChildDirs`/`CHILD_ELEMENT_DIRS` защищали от удаления
   * только Forms/Templates/Commands/Subsystems — файлы Recalculations/Tables/
   * Cubes/DimensionTables считались сиротами и получали `conflict-delete`/
   * `delete`. Раздел 10 чинит это НЕ добавлением новых тегов в старый механизм
   * (он целиком удалён вместе с `parseObjectXml`-импортом из планировщика — Р6),
   * а тем, что при `depth:'unit'` эти файлы вообще не входят в область владельца
   * (см. `repositoryObjectScope.test.ts`) — соответственно, здесь проверяется,
   * что `collectMergeFileStates` с `unit`-областью владельца не порождает для
   * них НИКАКИХ состояний (не noop, не write, не delete — их там попросту нет).
   */
  test('Регресс D2b: Начисления (РегистрРасчета), depth:"unit" — Recalculations НЕ входит в состояния владельца (не удаляется как сирота)', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-d2b-calc-'));
    try {
      fs.cpSync(EXAMPLE_CF, projectDir, { recursive: true });
      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'ТорговыйУчет' };
      const scope = resolveObjectScope(projectDir, 'РегистрРасчета.Начисления', target, 'unit') as Extract<ObjectScope, { kind: 'object' }>;
      assert.ok(scope);
      // «Выгрузка» — тот же проект БЕЗ Recalculations (имитация частичной выгрузки
      // владельца, которая по факту платформы (10.12) никогда не содержит подчинённые).
      const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-d2b-calc-dump-'));
      fs.mkdirSync(path.join(dumpDir, 'CalculationRegisters'), { recursive: true });
      fs.copyFileSync(path.join(EXAMPLE_CF, 'CalculationRegisters', 'Начисления.xml'), path.join(dumpDir, 'CalculationRegisters', 'Начисления.xml'));

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir,
        scopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });
      const rels = states.map((s: MergeFileState) => s.rel.replace(/\\/g, '/'));
      assert.ok(!rels.some((rel) => rel.includes('Recalculations')), 'Recalculations не должен входить в область владельца при depth:"unit" — файлы не тронуты, потому что их там вообще нет в списке.');
      fs.rmSync(dumpDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('Регресс D2b: ИнтернетМагазин (ВнешнийИсточникДанных), depth:"unit" — Tables/Cubes НЕ входят в состояния владельца', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-d2b-eds-'));
    try {
      fs.cpSync(EXAMPLE_CF, projectDir, { recursive: true });
      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'ТорговыйУчет' };
      const scope = resolveObjectScope(projectDir, 'ВнешнийИсточникДанных.ИнтернетМагазин', target, 'unit') as Extract<ObjectScope, { kind: 'object' }>;
      assert.ok(scope);
      const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-d2b-eds-dump-'));
      fs.mkdirSync(path.join(dumpDir, 'ExternalDataSources'), { recursive: true });
      fs.copyFileSync(
        path.join(EXAMPLE_CF, 'ExternalDataSources', 'ИнтернетМагазин.xml'),
        path.join(dumpDir, 'ExternalDataSources', 'ИнтернетМагазин.xml')
      );

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir,
        scopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });
      const rels = states.map((s: MergeFileState) => s.rel.replace(/\\/g, '/'));
      assert.ok(!rels.some((rel) => rel.includes('/Tables/') || rel.includes('/Cubes/')));
      fs.rmSync(dumpDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('одна и та же область дважды в scopes — состояние берётся только один раз (дедупликация по states.has)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-dedup-dump-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-dedup-project-'));
    try {
      writeConfigurationXml(tempDir, fixtureUuid('merge-dedup-dump'));
      writeConfigurationXml(projectDir, fixtureUuid('merge-dedup-project'));
      writeObjectXml(tempDir, 'Catalogs', 'Дубль', 'Catalog', fixtureUuid('merge-dedup-object-dump'), 'flat');
      writeObjectXml(projectDir, 'Catalogs', 'Дубль', 'Catalog', fixtureUuid('merge-dedup-object-project'), 'flat');

      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(projectDir, 'Справочник.Дубль', target) as Extract<ObjectScope, { kind: 'object' }>;

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir: tempDir,
        scopes: [scope, scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });

      const matching = states.filter((s: MergeFileState) => s.rel.replace(/\\/g, '/') === 'Catalogs/Дубль.xml');
      assert.strictEqual(matching.length, 1, 'Повторная область не должна порождать дублирующее состояние для того же файла.');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('removedScopes: файл, уже покрытый обычной scopes, НЕ переопределяется удалённой областью (дедупликация states.has)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-removed-dedup-dump-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-removed-dedup-project-'));
    try {
      writeConfigurationXml(tempDir, fixtureUuid('merge-removed-dedup-dump'));
      writeConfigurationXml(projectDir, fixtureUuid('merge-removed-dedup-project'));
      writeObjectXml(tempDir, 'Catalogs', 'Общий', 'Catalog', fixtureUuid('merge-removed-dedup-object-dump'), 'flat');
      writeObjectXml(projectDir, 'Catalogs', 'Общий', 'Catalog', fixtureUuid('merge-removed-dedup-object-project'), 'flat');

      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(projectDir, 'Справочник.Общий', target) as Extract<ObjectScope, { kind: 'object' }>;

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir: tempDir,
        scopes: [scope],
        removedScopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });

      const matching = states.filter((s: MergeFileState) => s.rel.replace(/\\/g, '/') === 'Catalogs/Общий.xml');
      assert.strictEqual(matching.length, 1, 'Файл из scopes не должен дублироваться/переопределяться removedScopes.');
      assert.notStrictEqual(matching[0].repositoryHash, null, 'Состояние взято из scopes (файл реально есть в выгрузке), а не из removedScopes (там был бы repositoryHash:null).');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('removedScopes: dirtyRelativePaths помечает состояние удалённого объекта forceConflict=true', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-removed-dirty-project-'));
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-removed-dirty-dump-'));
    try {
      writeConfigurationXml(projectDir, fixtureUuid('merge-removed-dirty-project'));
      writeConfigurationXml(dumpDir, fixtureUuid('merge-removed-dirty-dump'));
      writeObjectXml(projectDir, 'Catalogs', 'УдалённыйИзХранилища', 'Catalog', fixtureUuid('merge-removed-dirty-object'), 'flat');

      const target: RepositoryTarget = { configRoot: projectDir, configKind: 'cf', displayName: 'Тест' };
      const scope = resolveObjectScope(projectDir, 'Справочник.УдалённыйИзХранилища', target) as Extract<ObjectScope, { kind: 'object' }>;

      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir,
        scopes: [],
        removedScopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: ['Catalogs/УдалённыйИзХранилища.xml'],
      });

      const xmlState = states.find((s: MergeFileState) => s.rel.replace(/\\/g, '/') === 'Catalogs/УдалённыйИзХранилища.xml');
      assert.ok(xmlState);
      assert.strictEqual(xmlState.repositoryHash, null);
      assert.strictEqual(xmlState.forceConflict, true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('реальный объект из example/ (Валюты, Ext/Help) — область собирается без ошибок, ConfigDumpInfo.xml не участвует', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-merge-states-real-'));
    try {
      fs.cpSync(EXAMPLE_CF, projectDir, { recursive: true });
      const scope = resolveObjectScope(EXAMPLE_CF, 'Справочник.Валюты', cfTarget) as Extract<ObjectScope, { kind: 'object' }>;
      const states = collectMergeFileStates({
        configRoot: projectDir,
        dumpDir: EXAMPLE_CF,
        scopes: [scope],
        baseHashes: {},
        dirtyRelativePaths: [],
      });
      const rels = states.map((s: MergeFileState) => s.rel.replace(/\\/g, '/'));
      assert.ok(rels.includes('Catalogs/Валюты.xml'));
      assert.ok(rels.includes('Catalogs/Валюты/Ext/Help/ru.html'));
      assert.ok(!rels.includes('ConfigDumpInfo.xml'));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
