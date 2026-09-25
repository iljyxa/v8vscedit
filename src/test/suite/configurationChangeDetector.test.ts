import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConfigEntry } from '../../domain/Configuration';
import { parseConfigXml } from '../../infra/xml';
import {
  buildHashSnapshot,
  loadHashCache,
  resolveHashCacheFileStem,
  saveHashCache,
} from '../../infra/cache/HashCache';
import { buildMetadataCacheScopeKey, loadMetadataCache } from '../../infra/cache/MetadataCache';
import { loadFileStatIndex, saveFileStatIndex } from '../../infra/cache/FileStatIndex';
import { ConfigurationChangeDetector } from '../../infra/fs/ConfigurationChangeDetector';

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.20/src/cf');
const EXAMPLE_CFE = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

function scopeKeyFor(entry: ConfigEntry): string {
  const info = parseConfigXml(path.join(entry.rootPath, 'Configuration.xml'));
  return buildMetadataCacheScopeKey(entry, info);
}

function mkTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildMiniConfigXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MetaDataObject>
  <Configuration>
    <Properties>
      <Name>ТестоваяКонфигурация</Name>
      <Synonym/>
    </Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;
}

/** Минимальная выгрузка: Configuration.xml + пара реальных файлов метаданных. */
function buildMiniConfig(configDir: string): void {
  fs.mkdirSync(path.join(configDir, 'Catalogs'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'CommonModules'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'Configuration.xml'), buildMiniConfigXml(), 'utf-8');
  fs.writeFileSync(path.join(configDir, 'Catalogs', 'Тест.xml'), '<xml/>', 'utf-8');
  fs.writeFileSync(path.join(configDir, 'CommonModules', 'Модуль.bsl'), 'Процедура Тест() КонецПроцедуры', 'utf-8');
}

suite('ConfigurationChangeDetector — реальные фикстуры (cf/cfe)', () => {
  const scenarios: { title: string; entry: ConfigEntry }[] = [
    { title: 'cf', entry: { rootPath: EXAMPLE_CF, kind: 'cf' } },
    { title: 'cfe', entry: { rootPath: EXAMPLE_CFE, kind: 'cfe' } },
  ];

  for (const { title, entry } of scenarios) {
    test(`${title}: первый ensureCaches создаёт хеш-кэш и stat-индекс, detect не находит изменений`, function () {
      this.timeout(60000);
      const tempRoot = mkTempRoot(`v8-detector-${title}-first-`);
      try {
        const farFuture = Date.now() + 3_600_000;
        const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
        detector.ensureCaches([entry]);

        const scopeKey = scopeKeyFor(entry);
        const stem = resolveHashCacheFileStem(tempRoot, scopeKey);
        assert.ok(fs.existsSync(`${stem}.json`));
        assert.ok(fs.existsSync(`${stem}.stat.json`));

        const hashCache = loadHashCache(tempRoot, scopeKey);
        const statIndex = loadFileStatIndex(tempRoot, scopeKey);
        assert.strictEqual(Object.keys(statIndex.files).length, Object.keys(hashCache.files).length);
        assert.ok(Object.keys(hashCache.files).length > 0);

        assert.deepStrictEqual(detector.detect([entry]), []);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    test(`${title}: detect берёт хеши из stat-индекса, а не пересчитывает их заново`, function () {
      this.timeout(60000);
      const tempRoot = mkTempRoot(`v8-detector-${title}-forged-`);
      try {
        const farFuture = Date.now() + 3_600_000;
        const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
        detector.ensureCaches([entry]);

        const scopeKey = scopeKeyFor(entry);
        const statIndex = loadFileStatIndex(tempRoot, scopeKey);
        const forgedEntries = Object.fromEntries(
          Object.entries(statIndex.files).map(([rel, statEntry]) => [rel, { ...statEntry, hash: 'forged' }])
        );
        saveFileStatIndex(tempRoot, { ...statIndex, files: forgedEntries });

        const changed = detector.detect([entry]);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0]?.changedFilesCount, Object.keys(statIndex.files).length);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }

  test('cf и cfe используют разные файлы .stat.json', function () {
    this.timeout(60000);
    const tempRoot = mkTempRoot('v8-detector-scopes-');
    try {
      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      const cfEntry: ConfigEntry = { rootPath: EXAMPLE_CF, kind: 'cf' };
      const cfeEntry: ConfigEntry = { rootPath: EXAMPLE_CFE, kind: 'cfe' };
      detector.ensureCaches([cfEntry, cfeEntry]);

      const cfStem = resolveHashCacheFileStem(tempRoot, scopeKeyFor(cfEntry));
      const cfeStem = resolveHashCacheFileStem(tempRoot, scopeKeyFor(cfeEntry));
      assert.notStrictEqual(cfStem, cfeStem);
      assert.ok(fs.existsSync(`${cfStem}.stat.json`));
      assert.ok(fs.existsSync(`${cfeStem}.stat.json`));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('загрузка индекса с чужим scopeKey возвращает пустой индекс', function () {
    this.timeout(60000);
    const tempRoot = mkTempRoot('v8-detector-foreign-scope-');
    try {
      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      const cfEntry: ConfigEntry = { rootPath: EXAMPLE_CF, kind: 'cf' };
      detector.ensureCaches([cfEntry]);

      const loaded = loadFileStatIndex(tempRoot, 'совершенно другой scopeKey');
      assert.deepStrictEqual(loaded.files, {});
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

suite('ConfigurationChangeDetector — минимальная временная выгрузка', () => {
  test('detect не переписывает stat-индекс без изменений выгрузки (байт-в-байт)', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-nochange-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      detector.ensureCaches([entry]);
      assert.deepStrictEqual(detector.detect([entry]), []);

      const scopeKey = scopeKeyFor(entry);
      const stem = resolveHashCacheFileStem(tempRoot, scopeKey);
      const statPath = `${stem}.stat.json`;
      const indexBefore = loadFileStatIndex(tempRoot, scopeKey);
      // Переписываем файл в другом (pretty-print) форматировании, чтобы отличить
      // «detect не тронул файл» от «detect записал байт-в-байт то же содержимое».
      fs.writeFileSync(statPath, JSON.stringify(indexBefore, null, 2), 'utf-8');
      const beforeBytes = fs.readFileSync(statPath, 'utf-8');

      assert.deepStrictEqual(detector.detect([entry]), []);
      const afterBytes = fs.readFileSync(statPath, 'utf-8');
      assert.strictEqual(afterBytes, beforeBytes);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('изменение файла (сдвиг mtime) фиксируется детектором и обновляет stat-индекс', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-modify-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      detector.ensureCaches([entry]);

      const target = path.join(configDir, 'Catalogs', 'Тест.xml');
      fs.writeFileSync(target, '<xm2/>', 'utf-8'); // тот же размер, другое содержимое
      const statAfterWrite = fs.statSync(target);
      fs.utimesSync(target, statAfterWrite.atimeMs / 1000, statAfterWrite.mtimeMs / 1000 + 5);

      const changed = detector.detect([entry]);
      assert.strictEqual(changed.length, 1);
      assert.strictEqual(changed[0]?.changedFilesCount, 1);

      const scopeKey = scopeKeyFor(entry);
      const index = loadFileStatIndex(tempRoot, scopeKey);
      const refreshedStat = fs.statSync(target);
      assert.strictEqual(index.files['Catalogs/Тест.xml'].mtimeMs, refreshedStat.mtimeMs);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('добавление нового файла фиксируется детектором', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-add-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      detector.ensureCaches([entry]);

      fs.writeFileSync(path.join(configDir, 'CommonModules', 'Новый.bsl'), 'Процедура Новый() КонецПроцедуры', 'utf-8');
      const changed = detector.detect([entry]);
      assert.strictEqual(changed.length, 1);
      assert.strictEqual(changed[0]?.changedFilesCount, 1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('удаление файла фиксируется детектором', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-delete-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      detector.ensureCaches([entry]);

      fs.rmSync(path.join(configDir, 'CommonModules', 'Модуль.bsl'));
      const changed = detector.detect([entry]);
      assert.strictEqual(changed.length, 1);
      assert.strictEqual(changed[0]?.changedFilesCount, 1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('racy now на момент ensureCaches не создаёт stat-индекс; последующий detect с неracy now создаёт его', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-racy-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const scopeKey = scopeKeyFor(entry);
      const stem = resolveHashCacheFileStem(tempRoot, scopeKey);

      // Configuration.xml тоже подпадает под SUPPORTED_FILE_RE (только ConfigDumpInfo.xml
      // исключён по имени), поэтому его stat учитывается наравне с остальными файлами.
      const relativePaths = ['Configuration.xml', 'Catalogs/Тест.xml', 'CommonModules/Модуль.bsl'];
      const oldestStampMs = Math.min(
        ...relativePaths.map((rel) => {
          const stat = fs.statSync(path.join(configDir, rel));
          return Math.max(stat.mtimeMs, stat.ctimeMs);
        })
      );
      const racyNowMs = oldestStampMs + 500;

      const racyDetector = new ConfigurationChangeDetector(tempRoot, () => racyNowMs);
      racyDetector.ensureCaches([entry]);
      assert.ok(fs.existsSync(`${stem}.json`));
      assert.ok(!fs.existsSync(`${stem}.stat.json`));

      const farFuture = Date.now() + 3_600_000;
      const laterDetector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      assert.deepStrictEqual(laterDetector.detect([entry]), []);
      assert.ok(fs.existsSync(`${stem}.stat.json`));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('каталог на месте .stat.json не приводит к падению ensureCaches/detect', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-dirblock-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const scopeKey = scopeKeyFor(entry);
      const stem = resolveHashCacheFileStem(tempRoot, scopeKey);
      fs.mkdirSync(`${stem}.stat.json`, { recursive: true });

      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      assert.doesNotThrow(() => detector.ensureCaches([entry]));
      assert.ok(fs.existsSync(`${stem}.json`));
      assert.ok(fs.statSync(`${stem}.stat.json`).isDirectory());

      assert.deepStrictEqual(detector.detect([entry]), []);

      const leftoverTmp = fs.readdirSync(path.dirname(stem)).filter((name) => name.endsWith('.tmp'));
      assert.deepStrictEqual(leftoverTmp, []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('битый .stat.json не мешает detect и перезаписывается валидным индексом', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-corrupt-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const scopeKey = scopeKeyFor(entry);
      const stem = resolveHashCacheFileStem(tempRoot, scopeKey);

      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      detector.ensureCaches([entry]);

      fs.writeFileSync(`${stem}.stat.json`, '{', 'utf-8');
      assert.deepStrictEqual(detector.detect([entry]), []);

      const restored = loadFileStatIndex(tempRoot, scopeKey);
      assert.ok(Object.keys(restored.files).length > 0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('хеш-кэш есть, meta-кэша нет: ensureCaches достраивает только метаданные, .stat.json не появляется', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-metaonly-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const scopeKey = scopeKeyFor(entry);
      const stem = resolveHashCacheFileStem(tempRoot, scopeKey);

      // Имитация состояния «до появления stat-индекса»: только hash-кэш, без .stat.json и meta-кэша.
      saveHashCache(tempRoot, buildHashSnapshot(scopeKey, configDir));
      assert.ok(fs.existsSync(`${stem}.json`));
      assert.ok(!fs.existsSync(`${stem}.stat.json`));
      assert.strictEqual(loadMetadataCache(tempRoot, scopeKey), null);

      const farFuture = Date.now() + 3_600_000;
      const detector = new ConfigurationChangeDetector(tempRoot, () => farFuture);
      detector.ensureCaches([entry]);

      assert.notStrictEqual(loadMetadataCache(tempRoot, scopeKey), null);
      assert.ok(!fs.existsSync(`${stem}.stat.json`));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('конструктор без явного now работает корректно на мини-выгрузке', () => {
    const tempRoot = mkTempRoot('v8-detector-mini-defaultnow-');
    try {
      const configDir = path.join(tempRoot, 'src', 'cf');
      buildMiniConfig(configDir);
      const entry: ConfigEntry = { rootPath: configDir, kind: 'cf' };
      const detector = new ConfigurationChangeDetector(tempRoot);
      detector.ensureCaches([entry]);
      assert.deepStrictEqual(detector.detect([entry]), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
