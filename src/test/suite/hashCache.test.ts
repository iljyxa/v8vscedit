import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildHashSnapshot,
  buildScopeKey,
  computeFileHash,
  diffHashSnapshots,
  loadHashCache,
  patchHashCacheEntries,
  patchHashCacheForFiles,
  saveHashCache,
} from '../../infra/cache/HashCache';
import { collectConfigFilesForLoad, detectPotentialRename } from '../../infra/agent/ConfigLoadFileCollector';

suite('HashCache', () => {
  test('diffHashSnapshots корректно определяет added/modified/deleted', () => {
    const previous = {
      schemaVersion: 1 as const,
      scopeKey: 'cf::test',
      generatedAt: '',
      files: {
        'Catalogs/Тест.xml': 'hash-old',
        'Documents/Удален.xml': 'hash-removed',
      },
    };
    const current = {
      schemaVersion: 1 as const,
      scopeKey: 'cf::test',
      generatedAt: '',
      files: {
        'Catalogs/Тест.xml': 'hash-new',
        'CommonModules/Новый.bsl': 'hash-added',
      },
    };
    const diff = diffHashSnapshots(previous, current);
    assert.deepStrictEqual(diff.added, ['CommonModules/Новый.bsl']);
    assert.deepStrictEqual(diff.modified, ['Catalogs/Тест.xml']);
    assert.deepStrictEqual(diff.deleted, ['Documents/Удален.xml']);
  });

  test('save/load кэша сохраняет snapshot', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-cache-'));
    try {
      const scopeKey = buildScopeKey('cf', path.join(tempRoot, 'src', 'cf'));
      const snapshot = {
        schemaVersion: 1 as const,
        scopeKey,
        generatedAt: new Date().toISOString(),
        files: { 'Catalogs/Тест.xml': 'hash-1' },
      };
      saveHashCache(tempRoot, snapshot);
      const loaded = loadHashCache(tempRoot, scopeKey);
      assert.strictEqual(loaded.scopeKey, snapshot.scopeKey);
      assert.strictEqual(loaded.files['Catalogs/Тест.xml'], 'hash-1');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('buildHashSnapshot учитывает только xml/bsl без ConfigDumpInfo.xml', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-snapshot-'));
    try {
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, 'CommonModules'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'Тест.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(path.join(tempRoot, 'CommonModules', 'Тест.bsl'), 'Процедура Тест() КонецПроцедуры', 'utf-8');
      fs.writeFileSync(path.join(tempRoot, 'ConfigDumpInfo.xml'), '<skip/>', 'utf-8');
      fs.writeFileSync(path.join(tempRoot, 'README.md'), '# skip', 'utf-8');

      const snapshot = buildHashSnapshot('cf::tmp', tempRoot);
      assert.ok(snapshot.files['Catalogs/Тест.xml']);
      assert.ok(snapshot.files['CommonModules/Тест.bsl']);
      assert.ok(!snapshot.files['ConfigDumpInfo.xml']);
      assert.ok(!snapshot.files['README.md']);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('buildHashSnapshot учитывает файлы содержимого макетов', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-template-content-'));
    try {
      const textDir = path.join(tempRoot, 'DataProcessors', 'Обработка', 'Templates', 'Текст', 'Ext');
      const htmlDir = path.join(tempRoot, 'CommonTemplates', 'Описание', 'Ext', 'Template');
      fs.mkdirSync(textDir, { recursive: true });
      fs.mkdirSync(htmlDir, { recursive: true });
      fs.writeFileSync(path.join(textDir, 'Template.txt'), 'текст', 'utf-8');
      fs.writeFileSync(path.join(textDir, 'Template.bin'), 'bin', 'utf-8');
      fs.writeFileSync(path.join(htmlDir, 'ru.html'), '<html></html>', 'utf-8');
      fs.writeFileSync(path.join(tempRoot, 'README.txt'), 'skip', 'utf-8');

      const snapshot = buildHashSnapshot('cf::tmp', tempRoot);
      assert.ok(snapshot.files['DataProcessors/Обработка/Templates/Текст/Ext/Template.txt']);
      assert.ok(snapshot.files['DataProcessors/Обработка/Templates/Текст/Ext/Template.bin']);
      assert.ok(snapshot.files['CommonTemplates/Описание/Ext/Template/ru.html']);
      assert.ok(!snapshot.files['README.txt']);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('patchHashCacheForFiles точечно обновляет только переданные поддерживаемые файлы, не трогая остальной кэш', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-patch-'));
    try {
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'Тест.xml'), '<xml v="1"/>', 'utf-8');
      fs.writeFileSync(path.join(tempRoot, 'ConfigDumpInfo.xml'), '<skip/>', 'utf-8');

      const scopeKey = buildScopeKey('cf', tempRoot);
      saveHashCache(tempRoot, {
        schemaVersion: 1,
        scopeKey,
        generatedAt: '',
        files: {
          'Catalogs/Тест.xml': 'устаревший-хеш',
          'Documents/НеЗатронутый.xml': 'хеш-остаётся',
        },
      });

      // ConfigDumpInfo.xml — неподдерживаемый файл (isSupportedConfigFile), должен
      // быть отфильтрован и не попасть в кэш, несмотря на явную передачу в списке.
      patchHashCacheForFiles(tempRoot, 'cf', tempRoot, '', ['Catalogs/Тест.xml', 'ConfigDumpInfo.xml']);

      const patched = loadHashCache(tempRoot, scopeKey);
      assert.notStrictEqual(patched.files['Catalogs/Тест.xml'], 'устаревший-хеш', 'Хеш изменённого файла должен обновиться.');
      assert.strictEqual(patched.files['Documents/НеЗатронутый.xml'], 'хеш-остаётся', 'Файлы вне списка не трогаются.');
      assert.ok(!patched.files['ConfigDumpInfo.xml'], 'Неподдерживаемый файл не должен попасть в кэш.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('patchHashCacheForFiles с deletedFiles удаляет записи из кэша, не пересчитывая остальные', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-patch-deleted-'));
    try {
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'Остаётся.xml'), '<xml/>', 'utf-8');

      const scopeKey = buildScopeKey('cf', tempRoot);
      saveHashCache(tempRoot, {
        schemaVersion: 1,
        scopeKey,
        generatedAt: '',
        files: {
          'Catalogs/Остаётся.xml': 'хеш-остаётся',
          'Catalogs/Удалён.xml': 'хеш-удалённого',
        },
      });

      // Файл реально удалён с диска — patchHashCacheForFiles должен убрать его из
      // кэша через параметр deletedFiles, а не оставить устаревшую запись.
      patchHashCacheForFiles(tempRoot, 'cf', tempRoot, '', [], ['Catalogs/Удалён.xml']);

      const patched = loadHashCache(tempRoot, scopeKey);
      assert.strictEqual(patched.files['Catalogs/Остаётся.xml'], 'хеш-остаётся', 'Не затронутые файлы должны остаться.');
      assert.ok(!patched.files['Catalogs/Удалён.xml'], 'Удалённый файл должен исчезнуть из кэша.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('patchHashCacheForFiles без deletedFiles (значение по умолчанию — пустой список) не удаляет ничего', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-patch-default-'));
    try {
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'А.xml'), '<xml/>', 'utf-8');
      const scopeKey = buildScopeKey('cf', tempRoot);
      saveHashCache(tempRoot, { schemaVersion: 1, scopeKey, generatedAt: '', files: { 'Catalogs/Б.xml': 'хеш-б' } });

      patchHashCacheForFiles(tempRoot, 'cf', tempRoot, '', ['Catalogs/А.xml']);

      const patched = loadHashCache(tempRoot, scopeKey);
      assert.ok(patched.files['Catalogs/А.xml']);
      assert.strictEqual(patched.files['Catalogs/Б.xml'], 'хеш-б', 'Без deletedFiles ничего не должно удаляться.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('computeFileHash — детерминированный sha1 от содержимого файла, экспортирован для внешних вызовов (RepositoryMergeApplier)', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-compute-'));
    try {
      const filePath = path.join(tempRoot, 'файл.txt');
      fs.writeFileSync(filePath, 'содержимое', 'utf-8');
      const first = computeFileHash(filePath);
      const second = computeFileHash(filePath);
      assert.strictEqual(first, second);
      assert.match(first, /^[0-9a-f]{40}$/, 'sha1 в hex должен быть 40 символами.');

      fs.writeFileSync(filePath, 'другое содержимое', 'utf-8');
      assert.notStrictEqual(computeFileHash(filePath), first);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('patchHashCacheEntries — пишет готовые хеши без чтения файлов с диска, фильтрует неподдерживаемые и удаляет deletedFiles', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-entries-'));
    try {
      const scopeKey = buildScopeKey('cf', tempRoot);
      saveHashCache(tempRoot, {
        schemaVersion: 1,
        scopeKey,
        generatedAt: '',
        files: { 'Catalogs/Старый.xml': 'старый-хеш', 'Catalogs/БудетУдалён.xml': 'хеш-к-удалению' },
      });

      // Хеши переданы напрямую (например, уже посчитанные в RepositoryMergeApplier
      // при копировании файла) — файлы на диске может не существовать вовсе, важно,
      // что patchHashCacheEntries не пытается их читать сам.
      patchHashCacheEntries(
        tempRoot,
        'cf',
        tempRoot,
        '',
        {
          'Catalogs/Старый.xml': 'новый-хеш-без-чтения-файла',
          'ConfigDumpInfo.xml': 'должен-быть-отфильтрован',
        },
        ['Catalogs/БудетУдалён.xml']
      );

      const patched = loadHashCache(tempRoot, scopeKey);
      assert.strictEqual(patched.files['Catalogs/Старый.xml'], 'новый-хеш-без-чтения-файла');
      assert.ok(!patched.files['ConfigDumpInfo.xml'], 'ConfigDumpInfo.xml не должен попадать в кэш даже при явной передаче.');
      assert.ok(!patched.files['Catalogs/БудетУдалён.xml']);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('patchHashCacheEntries для расширения использует scope cfe::extensionName::configDir', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-entries-cfe-'));
    try {
      const configDir = path.join(tempRoot, 'src', 'cfe', 'EVOLC');
      const scopeKey = buildScopeKey('cfe', configDir, 'EVOLC');

      patchHashCacheEntries(tempRoot, 'cfe', configDir, 'EVOLC', { 'Catalogs/Товары.xml': 'хеш-1' }, []);

      const patched = loadHashCache(tempRoot, scopeKey);
      assert.strictEqual(patched.files['Catalogs/Товары.xml'], 'хеш-1');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

suite('PartialLoadList', () => {
  test('collectConfigFiles возвращает пустой список без изменений', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-load-empty-'));
    try {
      assert.deepStrictEqual(collectConfigFilesForLoad(tempRoot, [], false), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('detectPotentialRename распознаёт переименование по совпадающему хешу', () => {
    assert.strictEqual(
      detectPotentialRename(
        { 'Catalogs/Старое.xml': 'same-hash' },
        { 'Documents/Новое.xml': 'same-hash' },
        ['Documents/Новое.xml'],
        ['Catalogs/Старое.xml']
      ),
      true
    );
  });

  test('collectConfigFiles для BSL возвращает только сам модуль', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-load-list-'));
    try {
      const objectDir = path.join(tempRoot, 'Documents', 'Заказ');
      const extDir = path.join(objectDir, 'Ext');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Documents', 'Заказ.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(path.join(extDir, 'ObjectModule.bsl'), 'Процедура Тест() КонецПроцедуры', 'utf-8');
      fs.writeFileSync(path.join(extDir, 'ManagerModule.bsl'), 'Процедура Менеджер() КонецПроцедуры', 'utf-8');

      const list = collectConfigFilesForLoad(tempRoot, ['Documents/Заказ/Ext/ObjectModule.bsl'], false);
      assert.deepStrictEqual(list, [
        'Documents/Заказ/Ext/ObjectModule.bsl',
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('collectConfigFiles для модуля формы возвращает только сам модуль', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-load-form-module-'));
    try {
      const formDir = path.join(tempRoot, 'Documents', 'Заказ', 'Forms', 'ФормаДокумента');
      fs.mkdirSync(path.join(formDir, 'Ext', 'Form'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Documents', 'Заказ.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(path.join(tempRoot, 'Documents', 'Заказ', 'Forms', 'ФормаДокумента.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(path.join(formDir, 'Ext', 'Form.xml'), '<form/>', 'utf-8');
      fs.writeFileSync(path.join(formDir, 'Ext', 'Form', 'Module.bsl'), 'Процедура Тест() КонецПроцедуры', 'utf-8');

      const list = collectConfigFilesForLoad(tempRoot, ['Documents/Заказ/Forms/ФормаДокумента/Ext/Form/Module.bsl'], false);
      assert.deepStrictEqual(list, [
        'Documents/Заказ/Forms/ФормаДокумента/Ext/Form/Module.bsl',
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('collectConfigFiles добавляет XML макета и содержимое для текстового макета', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-load-template-list-'));
    try {
      const objectDir = path.join(tempRoot, 'DataProcessors', 'Обработка');
      const templateDir = path.join(objectDir, 'Templates', 'Текст');
      fs.mkdirSync(path.join(templateDir, 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'DataProcessors', 'Обработка.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(path.join(objectDir, 'Templates', 'Текст.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(path.join(templateDir, 'Ext', 'Template.txt'), 'текст', 'utf-8');

      const list = collectConfigFilesForLoad(
        tempRoot,
        ['DataProcessors/Обработка/Templates/Текст/Ext/Template.txt'],
        false
      );
      assert.ok(list.includes('DataProcessors/Обработка/Templates/Текст.xml'));
      assert.ok(list.includes('DataProcessors/Обработка.xml'));
      assert.ok(list.includes('DataProcessors/Обработка/Templates/Текст/Ext/Template.txt'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
