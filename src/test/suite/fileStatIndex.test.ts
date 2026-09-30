import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FILE_STAT_INDEX_SCHEMA_VERSION,
  FILE_STAT_RACY_WINDOW_MS,
  buildHashSnapshotWithStatIndex,
  createEmptyFileStatIndex,
  isFileStatEntryReusable,
  isRacyFileStat,
  loadFileStatIndex,
  saveFileStatIndex,
  type FileStatEntry,
  type FileStatIndex,
} from '../../infra/cache/FileStatIndex';
import {
  buildHashSnapshot,
  buildScopeKey,
  resolveHashCacheFileStem,
  saveHashCache,
} from '../../infra/cache/HashCache';

function mkTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Пишет сырой JSON-текст напрямую по пути `<stem>.stat.json`, минуя saveFileStatIndex —
 * нужен для сценариев с намеренно битым/чужим содержимым файла.
 */
function writeRawStatFile(tempRoot: string, scopeKey: string, rawJson: string): string {
  const stem = resolveHashCacheFileStem(tempRoot, scopeKey);
  fs.mkdirSync(path.dirname(stem), { recursive: true });
  const statPath = `${stem}.stat.json`;
  fs.writeFileSync(statPath, rawJson, 'utf-8');
  return statPath;
}

suite('FileStatIndex', () => {
  suite('isFileStatEntryReusable', () => {
    const baseStat = { size: 100, mtimeMs: 1000, ctimeMs: 1000 };
    const baseEntry: FileStatEntry = { size: 100, mtimeMs: 1000, ctimeMs: 1000, hash: 'h' };

    test('запись отсутствует -> false', () => {
      assert.strictEqual(isFileStatEntryReusable(undefined, baseStat), false);
    });

    test('все поля совпадают -> true', () => {
      assert.strictEqual(isFileStatEntryReusable(baseEntry, baseStat), true);
    });

    for (const field of ['size', 'mtimeMs', 'ctimeMs'] as const) {
      test(`отличие поля ${field} -> false`, () => {
        const stat = { ...baseStat, [field]: baseStat[field] + 1 };
        assert.strictEqual(isFileStatEntryReusable(baseEntry, stat), false);
      });
    }
  });

  suite('isRacyFileStat', () => {
    const W = FILE_STAT_RACY_WINDOW_MS;
    const nowMs = 1_000_000;
    // Возраст задаётся относительно nowMs: mtimeMs = nowMs - возраст.
    const cases: [string, number, number, boolean][] = [
      ['mtime свежее, оба в пределах окна', W - 1, W, true],
      ['ctime свежее, оба в пределах окна', W, W - 1, true],
      ['граница окна (возраст === W) -> не racy', W, W, false],
      ['оба далеко за окном -> не racy', W + 1000, W + 1000, false],
      ['mtime из будущего -> racy', -1000, W, true],
    ];

    for (const [title, mtimeAge, ctimeAge, expected] of cases) {
      test(title, () => {
        const stat = { mtimeMs: nowMs - mtimeAge, ctimeMs: nowMs - ctimeAge };
        assert.strictEqual(isRacyFileStat(stat, nowMs), expected);
      });
    }
  });

  test('save->load сохраняет дробные mtimeMs без потерь; файл лежит рядом с hash-кэшем того же scope', () => {
    const tempRoot = mkTempRoot('v8-stat-index-roundtrip-');
    try {
      const scopeKey = buildScopeKey('cf', path.join(tempRoot, 'src', 'cf'));
      const index: FileStatIndex = {
        schemaVersion: FILE_STAT_INDEX_SCHEMA_VERSION,
        scopeKey,
        files: {
          'Catalogs/Тест.xml': { size: 42, mtimeMs: 1700000000123.456, ctimeMs: 1700000000000.789, hash: 'abc' },
        },
      };
      saveFileStatIndex(tempRoot, index);

      const stem = resolveHashCacheFileStem(tempRoot, scopeKey);
      assert.ok(fs.existsSync(`${stem}.stat.json`));

      const loaded = loadFileStatIndex(tempRoot, scopeKey);
      assert.deepStrictEqual(loaded, index);

      // hash-кэш того же scope должен спокойно сосуществовать рядом со stat-индексом
      saveHashCache(tempRoot, { schemaVersion: 1, scopeKey, generatedAt: '', files: {} });
      assert.ok(fs.existsSync(`${stem}.json`));
      assert.ok(fs.existsSync(`${stem}.stat.json`));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('saveFileStatIndex бросает, если на месте файла каталог', () => {
    const tempRoot = mkTempRoot('v8-stat-index-save-fail-');
    try {
      const scopeKey = buildScopeKey('cf', path.join(tempRoot, 'src', 'cf'));
      const stem = resolveHashCacheFileStem(tempRoot, scopeKey);
      fs.mkdirSync(`${stem}.stat.json`, { recursive: true });

      assert.throws(() => saveFileStatIndex(tempRoot, createEmptyFileStatIndex(scopeKey)));

      const leftoverTmp = fs.readdirSync(path.dirname(stem)).filter((name) => name.endsWith('.tmp'));
      assert.deepStrictEqual(leftoverTmp, []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  suite('loadFileStatIndex — невалидные файлы индекса', () => {
    let tempRoot: string;
    let scopeKey: string;

    setup(() => {
      tempRoot = mkTempRoot('v8-stat-index-invalid-file-');
      scopeKey = buildScopeKey('cf', path.join(tempRoot, 'src', 'cf'));
    });

    teardown(() => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const invalidFileCases: [string, (() => void) | null][] = [
      ['файл отсутствует', null],
      ['битый JSON', () => writeRawStatFile(tempRoot, scopeKey, '{')],
      ['корень JSON — null', () => writeRawStatFile(tempRoot, scopeKey, 'null')],
      ['чужая schemaVersion', () => writeRawStatFile(tempRoot, scopeKey, JSON.stringify({ schemaVersion: 2, scopeKey, files: {} }))],
      ['чужой scopeKey', () => writeRawStatFile(tempRoot, scopeKey, JSON.stringify({ schemaVersion: 1, scopeKey: `${scopeKey}-other`, files: {} }))],
      ['нет поля files', () => writeRawStatFile(tempRoot, scopeKey, JSON.stringify({ schemaVersion: 1, scopeKey }))],
      ['files — массив', () => writeRawStatFile(tempRoot, scopeKey, JSON.stringify({ schemaVersion: 1, scopeKey, files: [] }))],
      ['files — строка', () => writeRawStatFile(tempRoot, scopeKey, JSON.stringify({ schemaVersion: 1, scopeKey, files: 'x' }))],
      ['каталог на месте файла', () => {
        const stem = resolveHashCacheFileStem(tempRoot, scopeKey);
        fs.mkdirSync(`${stem}.stat.json`, { recursive: true });
      }],
    ];

    for (const [title, prepare] of invalidFileCases) {
      test(`${title} -> пустой индекс`, () => {
        prepare?.();
        const loaded = loadFileStatIndex(tempRoot, scopeKey);
        assert.deepStrictEqual(loaded, createEmptyFileStatIndex(scopeKey));
      });
    }
  });

  suite('loadFileStatIndex — невалидные отдельные записи', () => {
    let tempRoot: string;
    let scopeKey: string;

    setup(() => {
      tempRoot = mkTempRoot('v8-stat-index-invalid-entry-');
      scopeKey = buildScopeKey('cf', path.join(tempRoot, 'src', 'cf'));
    });

    teardown(() => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    // NaN/Infinity не сериализуются JSON.stringify (превращаются в null), поэтому пишем
    // "сырой" JSON вручную: 1e999 при JSON.parse превращается в Infinity.
    const badEntryCases: [string, string][] = [
      ['null вместо записи', 'null'],
      ['строка вместо записи', '"str"'],
      ['нет size', '{"mtimeMs":1,"ctimeMs":1,"hash":"h"}'],
      ['size — строка', '{"size":"1","mtimeMs":1,"ctimeMs":1,"hash":"h"}'],
      ['mtimeMs — не конечное число (Infinity)', '{"size":1,"mtimeMs":1e999,"ctimeMs":1,"hash":"h"}'],
      ['ctimeMs — строка', '{"size":1,"mtimeMs":1,"ctimeMs":"1","hash":"h"}'],
      ['hash — число', '{"size":1,"mtimeMs":1,"ctimeMs":1,"hash":5}'],
      ['hash — пустая строка', '{"size":1,"mtimeMs":1,"ctimeMs":1,"hash":""}'],
    ];

    for (const [title, badEntryJson] of badEntryCases) {
      test(`${title} -> запись отброшена, валидный сосед сохранён`, () => {
        const raw = `{"schemaVersion":1,"scopeKey":${JSON.stringify(scopeKey)},"files":{"ok/File.xml":{"size":1,"mtimeMs":1,"ctimeMs":1,"hash":"h"},"bad/File.xml":${badEntryJson}}}`;
        writeRawStatFile(tempRoot, scopeKey, raw);

        const loaded = loadFileStatIndex(tempRoot, scopeKey);
        assert.deepStrictEqual(loaded.files['ok/File.xml'], { size: 1, mtimeMs: 1, ctimeMs: 1, hash: 'h' });
        assert.strictEqual(loaded.files['bad/File.xml'], undefined);
      });
    }
  });

  suite('buildHashSnapshotWithStatIndex', () => {
    let tempRoot: string;
    let configDir: string;
    let scopeKey: string;

    const SUPPORTED_RELATIVE_PATHS = [
      'Catalogs/Тест.xml',
      'CommonModules/М.bsl',
      'DataProcessors/Обработка/Templates/Текст/Ext/Template.txt',
    ];

    setup(() => {
      tempRoot = mkTempRoot('v8-stat-index-build-');
      configDir = path.join(tempRoot, 'data');
      scopeKey = buildScopeKey('cf', configDir);

      fs.mkdirSync(path.join(configDir, 'Catalogs'), { recursive: true });
      fs.mkdirSync(path.join(configDir, 'CommonModules'), { recursive: true });
      fs.mkdirSync(path.join(configDir, 'DataProcessors', 'Обработка', 'Templates', 'Текст', 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(configDir, 'Catalogs', 'Тест.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(path.join(configDir, 'CommonModules', 'М.bsl'), 'Процедура Тест() КонецПроцедуры', 'utf-8');
      fs.writeFileSync(path.join(configDir, 'ConfigDumpInfo.xml'), '<skip/>', 'utf-8');
      fs.writeFileSync(path.join(configDir, 'README.md'), '# skip', 'utf-8');
      fs.writeFileSync(
        path.join(configDir, 'DataProcessors', 'Обработка', 'Templates', 'Текст', 'Ext', 'Template.txt'),
        'текст',
        'utf-8'
      );
    });

    teardown(() => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('несуществующий каталог -> пустые snapshot/index, indexChanged false, hashedCount 0', () => {
      const missingDir = path.join(tempRoot, 'missing');
      const prev = createEmptyFileStatIndex(scopeKey);
      const result = buildHashSnapshotWithStatIndex(scopeKey, missingDir, prev, Date.now());

      assert.deepStrictEqual(result.snapshot.files, {});
      assert.deepStrictEqual(result.index.files, {});
      assert.strictEqual(result.indexChanged, false);
      assert.strictEqual(result.hashedCount, 0);
    });

    test('первый проход (пустой prev, время далеко в будущем) хеширует все поддерживаемые файлы', () => {
      const farFuture = Date.now() + 3_600_000;
      const prev = createEmptyFileStatIndex(scopeKey);
      const result = buildHashSnapshotWithStatIndex(scopeKey, configDir, prev, farFuture);
      const expected = buildHashSnapshot(scopeKey, configDir);

      assert.deepStrictEqual(result.snapshot.files, expected.files);
      assert.deepStrictEqual(Object.keys(result.index.files).sort(), SUPPORTED_RELATIVE_PATHS.slice().sort());

      for (const [rel, entry] of Object.entries(result.index.files)) {
        const stat = fs.statSync(path.join(configDir, rel));
        assert.strictEqual(entry.size, stat.size);
        assert.strictEqual(entry.mtimeMs, stat.mtimeMs);
        assert.strictEqual(entry.ctimeMs, stat.ctimeMs);
      }

      assert.strictEqual(result.indexChanged, true);
      assert.strictEqual(result.hashedCount, 3);
      assert.strictEqual('ConfigDumpInfo.xml' in result.snapshot.files, false);
      assert.strictEqual('README.md' in result.snapshot.files, false);
    });

    test('второй проход с сохранённым индексом переиспользует хеши без повторного чтения содержимого', () => {
      const farFuture = Date.now() + 3_600_000;
      const empty = createEmptyFileStatIndex(scopeKey);
      const first = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, farFuture);
      saveFileStatIndex(tempRoot, first.index);

      const loaded = loadFileStatIndex(tempRoot, scopeKey);
      const second = buildHashSnapshotWithStatIndex(scopeKey, configDir, loaded, farFuture + 1000);

      assert.strictEqual(second.hashedCount, 0);
      assert.strictEqual(second.indexChanged, false);
      assert.deepStrictEqual(second.snapshot.files, first.snapshot.files);
    });

    test('подделанный hash в индексе при совпадающем stat переиспользуется как есть', () => {
      const farFuture = Date.now() + 3_600_000;
      const empty = createEmptyFileStatIndex(scopeKey);
      const first = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, farFuture);
      const forged: FileStatIndex = {
        schemaVersion: FILE_STAT_INDEX_SCHEMA_VERSION,
        scopeKey,
        files: Object.fromEntries(
          Object.entries(first.index.files).map(([rel, entry]) => [rel, { ...entry, hash: 'forged' }])
        ),
      };

      const second = buildHashSnapshotWithStatIndex(scopeKey, configDir, forged, farFuture);
      for (const rel of Object.keys(forged.files)) {
        assert.strictEqual(second.snapshot.files[rel], 'forged');
      }
      assert.strictEqual(second.hashedCount, 0);
    });

    for (const field of ['size', 'mtimeMs', 'ctimeMs'] as const) {
      test(`несовпадение поля ${field} в индексе перехеширует файл`, () => {
        const farFuture = Date.now() + 3_600_000;
        const empty = createEmptyFileStatIndex(scopeKey);
        const first = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, farFuture);
        const targetRel = 'Catalogs/Тест.xml';
        const targetEntry = first.index.files[targetRel];
        assert.ok(targetEntry, 'первый проход обязан проиндексировать Catalogs/Тест.xml');

        const tampered: FileStatIndex = {
          schemaVersion: FILE_STAT_INDEX_SCHEMA_VERSION,
          scopeKey,
          files: {
            ...first.index.files,
            [targetRel]: { ...targetEntry, hash: 'forged', [field]: targetEntry[field] + 1 },
          },
        };

        const second = buildHashSnapshotWithStatIndex(scopeKey, configDir, tampered, farFuture);
        assert.strictEqual(second.hashedCount, 1);
        assert.strictEqual(second.indexChanged, true);
        assert.strictEqual(second.snapshot.files[targetRel], first.snapshot.files[targetRel]);
        assert.notStrictEqual(second.index.files[targetRel].hash, 'forged');
      });
    }

    test('изменение содержимого без изменения размера обнаруживается по сдвигу mtime', () => {
      const farFuture = Date.now() + 3_600_000;
      const empty = createEmptyFileStatIndex(scopeKey);
      const first = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, farFuture);

      const targetPath = path.join(configDir, 'Catalogs', 'Тест.xml');
      const originalContent = fs.readFileSync(targetPath, 'utf-8');
      const replacement = '<xm2/>';
      assert.strictEqual(replacement.length, originalContent.length, 'фикстура сценария должна сохранить размер файла');
      fs.writeFileSync(targetPath, replacement, 'utf-8');
      const statAfterWrite = fs.statSync(targetPath);
      fs.utimesSync(targetPath, statAfterWrite.atimeMs / 1000, statAfterWrite.mtimeMs / 1000 + 5);

      const second = buildHashSnapshotWithStatIndex(scopeKey, configDir, first.index, farFuture + 10_000);
      const expected = buildHashSnapshot(scopeKey, configDir);

      assert.strictEqual(second.snapshot.files['Catalogs/Тест.xml'], expected.files['Catalogs/Тест.xml']);
      assert.notStrictEqual(second.snapshot.files['Catalogs/Тест.xml'], first.snapshot.files['Catalogs/Тест.xml']);
    });

    test('racy nowMs при пустом prev не пишет записи в индекс, но хеш есть в snapshot', () => {
      const empty = createEmptyFileStatIndex(scopeKey);
      const oldestStampMs = Math.min(
        ...SUPPORTED_RELATIVE_PATHS.map((rel) => {
          const stat = fs.statSync(path.join(configDir, rel));
          return Math.max(stat.mtimeMs, stat.ctimeMs);
        })
      );
      const racyNowMs = oldestStampMs + FILE_STAT_RACY_WINDOW_MS - 1;

      const result = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, racyNowMs);
      assert.deepStrictEqual(result.index.files, {});
      assert.strictEqual(result.indexChanged, false);
      assert.strictEqual(result.hashedCount, 3);
      for (const rel of SUPPORTED_RELATIVE_PATHS) {
        assert.ok(result.snapshot.files[rel]);
      }
    });

    test('на границе racy-окна (возраст === W) запись уже сохраняется в индексе', () => {
      const empty = createEmptyFileStatIndex(scopeKey);
      const targetRel = 'Catalogs/Тест.xml';
      const stat = fs.statSync(path.join(configDir, targetRel));
      const nowMs = Math.max(stat.mtimeMs, stat.ctimeMs) + FILE_STAT_RACY_WINDOW_MS;

      const result = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, nowMs);
      assert.strictEqual(targetRel in result.index.files, true);
    });

    test('racy nowMs исключает файлы из свежего индекса даже когда хеш валиден и переиспользован', () => {
      const farFuture = Date.now() + 3_600_000;
      const empty = createEmptyFileStatIndex(scopeKey);
      const first = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, farFuture);

      const oldestStampMs = Math.min(
        ...Object.keys(first.index.files).map((rel) => {
          const stat = fs.statSync(path.join(configDir, rel));
          return Math.max(stat.mtimeMs, stat.ctimeMs);
        })
      );
      const racyNowMs = oldestStampMs + FILE_STAT_RACY_WINDOW_MS - 1;

      const second = buildHashSnapshotWithStatIndex(scopeKey, configDir, first.index, racyNowMs);
      assert.deepStrictEqual(second.index.files, {});
      assert.strictEqual(second.indexChanged, true);
      assert.strictEqual(second.hashedCount, 0);
      assert.deepStrictEqual(second.snapshot.files, first.snapshot.files);
    });

    test('удаление файла убирает его из snapshot и индекса, indexChanged true', () => {
      const farFuture = Date.now() + 3_600_000;
      const empty = createEmptyFileStatIndex(scopeKey);
      const first = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, farFuture);

      fs.rmSync(path.join(configDir, 'Catalogs', 'Тест.xml'));
      const second = buildHashSnapshotWithStatIndex(scopeKey, configDir, first.index, farFuture + 1000);

      assert.strictEqual('Catalogs/Тест.xml' in second.snapshot.files, false);
      assert.strictEqual('Catalogs/Тест.xml' in second.index.files, false);
      assert.strictEqual(second.indexChanged, true);
    });

    test('добавление нового файла хеширует только его, indexChanged true', () => {
      const farFuture = Date.now() + 3_600_000;
      const empty = createEmptyFileStatIndex(scopeKey);
      const first = buildHashSnapshotWithStatIndex(scopeKey, configDir, empty, farFuture);

      fs.writeFileSync(path.join(configDir, 'CommonModules', 'Новый.bsl'), 'Процедура Новый() КонецПроцедуры', 'utf-8');
      const second = buildHashSnapshotWithStatIndex(scopeKey, configDir, first.index, farFuture + 1000);

      assert.ok(second.snapshot.files['CommonModules/Новый.bsl']);
      assert.strictEqual(second.hashedCount, 1);
      assert.strictEqual(second.indexChanged, true);
    });
  });
});
