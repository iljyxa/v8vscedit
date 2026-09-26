import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseConfigDumpInfo,
  parseConfigDumpInfoEntries,
  readConfigDumpInfoFile,
} from '../../infra/xml/ConfigDumpInfoReader';

/**
 * `ConfigDumpInfoReader` разбирает `ConfigDumpInfo.xml` (эталон хранилища/базы после
 * `-Mode UpdateInfo`/полной выгрузки) в карту `name → configVersion`. Только записи
 * С атрибутом `configVersion` значимы для инкрементальной стратегии корня
 * (issue #1, RepositoryDumpPlan/ConfigDumpInfoDiff) — вложенные ссылки на
 * реквизиты/колонки без `configVersion` не участвуют в сравнении версий.
 */

const EXAMPLE_2_21_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_2_20_CF = path.resolve(__dirname, '../../../example/2.20/src/cf');
const EXAMPLE_EVOLC = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

suite('ConfigDumpInfoReader — parseConfigDumpInfo/readConfigDumpInfoFile', () => {
  test('2.21 cf: 154 записи с configVersion, Catalog.Валюты и Configuration.*.SessionModule присутствуют', () => {
    const map = readConfigDumpInfoFile(path.join(EXAMPLE_2_21_CF, 'ConfigDumpInfo.xml'));
    assert.ok(map, 'Файл фикстуры должен разбираться.');
    assert.strictEqual(map.size, 154);
    assert.strictEqual(map.get('Catalog.Валюты'), 'bb71d1cc90d8644484433b5f58f0efb600000000');
    assert.strictEqual(map.get('Configuration.ТорговыйУчет.SessionModule'), 'a65cae10b6c5a14282c7261c2b557fd900000000');
    // Вложенная ссылка на реквизит без атрибута configVersion не должна попасть в карту.
    assert.strictEqual(map.has('AccumulationRegister.БонусныеБаллы.Attribute.ВидОперации'), false);
  });

  test('2.20 cf: тот же состав (154 записи с configVersion), Catalog.Валюты сохраняет значение', () => {
    const map = readConfigDumpInfoFile(path.join(EXAMPLE_2_20_CF, 'ConfigDumpInfo.xml'));
    assert.ok(map);
    assert.strictEqual(map.size, 154);
    assert.strictEqual(map.get('Catalog.Валюты'), 'bb71d1cc90d8644484433b5f58f0efb600000000');
  });

  test('EVOLC (cfe): 7 записей с configVersion из 8 объявленных, Configuration.EVOLC присутствует', () => {
    const map = readConfigDumpInfoFile(path.join(EXAMPLE_EVOLC, 'ConfigDumpInfo.xml'));
    assert.ok(map);
    assert.strictEqual(map.size, 7);
    assert.strictEqual(map.get('Configuration.EVOLC'), '280193fe57dd703aff873ea89d10d9aa491c58b3');
    assert.strictEqual(map.get('Catalog.Контрагенты'), '47d663148923196572eaf4aa94cb8209e26fc289');
    // У Catalog.Контрагенты есть дочерний Attribute.КПП без configVersion — не должен попасть в карту.
    assert.strictEqual(map.has('Catalog.Контрагенты.Attribute.КПП'), false);
  });

  test('readConfigDumpInfoFile — несуществующий файл даёт null', () => {
    assert.strictEqual(readConfigDumpInfoFile(path.join(EXAMPLE_EVOLC, 'НетТакогоФайла.xml')), null);
  });

  test('parseConfigDumpInfo снимает BOM перед разбором', () => {
    const xml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo">
  <ConfigVersions>
    <Metadata name="Catalog.Тест" id="11111111-1111-1111-1111-111111111111" configVersion="abc123"/>
  </ConfigVersions>
</ConfigDumpInfo>`;
    const map = parseConfigDumpInfo(xml);
    assert.strictEqual(map.get('Catalog.Тест'), 'abc123');
  });

  test('parseConfigDumpInfoEntries: запись без атрибута id получает id="" (fallback ??)', () => {
    const xml = `<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo">
  <ConfigVersions>
    <Metadata name="Catalog.БезId" configVersion="abc123"/>
  </ConfigVersions>
</ConfigDumpInfo>`;
    const entries = parseConfigDumpInfoEntries(xml);
    assert.deepStrictEqual(entries, [{ name: 'Catalog.БезId', id: '', configVersion: 'abc123' }]);
  });

  test('parseConfigDumpInfo на пустой строке отдаёт пустую карту (не бросает)', () => {
    const map = parseConfigDumpInfo('');
    assert.strictEqual(map.size, 0);
  });

  test('parseConfigDumpInfo на нераспознаваемом тексте отдаёт пустую карту (не бросает)', () => {
    const map = parseConfigDumpInfo('это не xml вообще');
    assert.strictEqual(map.size, 0);
  });

  test('readConfigDumpInfoFile на существующем, но пустом файле отдаёт пустую (не null) карту', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-configdumpinfo-empty-'));
    try {
      const filePath = path.join(tempDir, 'ConfigDumpInfo.xml');
      fs.writeFileSync(filePath, '', 'utf-8');
      const map = readConfigDumpInfoFile(filePath);
      assert.ok(map, 'Существующий (пусть и пустой) файл не должен трактоваться как отсутствующий.');
      assert.strictEqual(map.size, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('вложенные записи с configVersion учитываются наравне с корневыми (иерархический формат)', () => {
    const xml = `<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo">
  <ConfigVersions>
    <Metadata name="Catalog.Товары" id="uuid-1" configVersion="root-hash">
      <Metadata name="Catalog.Товары.Attribute.Артикул" id="uuid-2"/>
    </Metadata>
    <Metadata name="Catalog.Товары.ObjectModule" id="uuid-3" configVersion="module-hash"/>
  </ConfigVersions>
</ConfigDumpInfo>`;
    const map = parseConfigDumpInfo(xml);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get('Catalog.Товары'), 'root-hash');
    assert.strictEqual(map.get('Catalog.Товары.ObjectModule'), 'module-hash');
    assert.strictEqual(map.has('Catalog.Товары.Attribute.Артикул'), false);
  });
});
