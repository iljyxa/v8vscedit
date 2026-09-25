import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveSubsystemMemberFullNames,
  resolveXmlPathByFullName,
  resolveNewSubsystemMembers,
} from '../../infra/repository/RepositoryDumpPlan';

/**
 * `RepositoryDumpPlan` — перенос (issue #1, план архитектора, раздел 3
 * «infra/repository») трёх ранее приватных методов `RepositoryService` в чистые
 * функции без изменения их прежнего поведения: `resolveXmlPathByFullName`,
 * `resolveSubsystemMemberFullNames` (были покрыты в `repositoryService.test.ts`
 * до переноса — тесты перенесены сюда буквально). `buildPartialDumpPlan` в новой
 * форме (`RepositoryDumpPlan = {kind:'objects'|'root-object'|'root-incremental'}`)
 * и точная сигнатура `resolveNewSubsystemMembers` (недостающие участники
 * рекурсивной подсистемы, довыгружаемые до неподвижной точки — план, раздел 2.7)
 * — намеренно НЕ фиксируются здесь отдельным юнит-тестом: они целиком
 * прогоняются через наблюдаемое поведение `RepositoryLockSync`
 * (`repositoryLockSync.test.ts`, сценарии корня и рекурсивной подсистемы),
 * поэтому дублирующий здесь тест рисковал бы зафиксировать неверно угаданную
 * внутреннюю форму раньше, чем реальный вызывающий код.
 */

suite('RepositoryDumpPlan — resolveXmlPathByFullName', () => {
  test('находит файл объекта в hierarchical- и flat-структуре, null для неизвестного', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-resolve-'));
    try {
      fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Номенклатура.xml'), '<MetaDataObject/>', 'utf-8');

      fs.mkdirSync(path.join(configRoot, 'Documents', 'ЗаказПокупателя'), { recursive: true });
      fs.writeFileSync(
        path.join(configRoot, 'Documents', 'ЗаказПокупателя', 'ЗаказПокупателя.xml'),
        '<MetaDataObject/>',
        'utf-8'
      );

      assert.strictEqual(
        resolveXmlPathByFullName(configRoot, 'Справочник.Номенклатура'),
        path.join(configRoot, 'Catalogs', 'Номенклатура.xml')
      );
      assert.strictEqual(
        resolveXmlPathByFullName(configRoot, 'Документ.ЗаказПокупателя'),
        path.join(configRoot, 'Documents', 'ЗаказПокупателя', 'ЗаказПокупателя.xml')
      );
      assert.strictEqual(resolveXmlPathByFullName(configRoot, 'Справочник.НеСуществует'), null);
      assert.strictEqual(resolveXmlPathByFullName(configRoot, 'НеизвестныйТип.Что-то'), null);
      assert.strictEqual(resolveXmlPathByFullName(configRoot, 'БезТочки'), null);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });
});

function buildSubsystemXml(name: string, refs: string[], childSubsystems: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MetaDataObject>
  <Subsystem>
    <Properties>
      <Name>${name}</Name>
      <Synonym/>
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

suite('RepositoryDumpPlan — resolveSubsystemMemberFullNames', () => {
  test('раскрывает Content с переводом типа в русский fullName, рекурсивно по дочерним подсистемам', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-subsystem-'));
    try {
      fs.mkdirSync(path.join(configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница'), { recursive: true });

      fs.writeFileSync(
        path.join(configRoot, 'Subsystems', 'Продажи.xml'),
        buildSubsystemXml('Продажи', ['Catalog.Товары'], ['Розница']),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница', 'Розница.xml'),
        buildSubsystemXml('Розница', ['Document.ЗаказПокупателя'], []),
        'utf-8'
      );

      const subsystemXmlPath = path.join(configRoot, 'Subsystems', 'Продажи.xml');

      const nonRecursive = resolveSubsystemMemberFullNames(subsystemXmlPath, false);
      assert.deepStrictEqual([...nonRecursive].sort(), ['Подсистема.Продажи', 'Справочник.Товары'].sort());

      const recursive = resolveSubsystemMemberFullNames(subsystemXmlPath, true);
      assert.deepStrictEqual(
        [...recursive].sort(),
        ['Подсистема.Продажи', 'Справочник.Товары', 'Подсистема.Розница', 'Документ.ЗаказПокупателя'].sort()
      );
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test('несуществующий XML подсистемы — пустой результат, без исключения', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-subsystem-missing-'));
    try {
      const missingPath = path.join(configRoot, 'Subsystems', 'НетТакой.xml');
      assert.deepStrictEqual(resolveSubsystemMemberFullNames(missingPath, true), []);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });
});

suite('RepositoryDumpPlan — resolveNewSubsystemMembers (issue #1, п.2.7 — довыгрузка недостающих участников)', () => {
  test('владелец из Content подсистемы, ещё не выгруженный локально, попадает в результат', () => {
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-newmembers-'));
    try {
      fs.mkdirSync(path.join(dumpDir, 'Subsystems'), { recursive: true });
      fs.writeFileSync(
        path.join(dumpDir, 'Subsystems', 'Продажи.xml'),
        buildSubsystemXml('Продажи', ['Catalog.Товары', 'Document.Заказ'], []),
        'utf-8'
      );

      const newMembers = resolveNewSubsystemMembers(dumpDir, ['Подсистема.Продажи'], new Set(['Справочник.Товары']));
      assert.deepStrictEqual(newMembers, ['Документ.Заказ']);
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('все участники уже известны — пустой результат', () => {
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-newmembers-empty-'));
    try {
      fs.mkdirSync(path.join(dumpDir, 'Subsystems'), { recursive: true });
      fs.writeFileSync(
        path.join(dumpDir, 'Subsystems', 'Продажи.xml'),
        buildSubsystemXml('Продажи', ['Catalog.Товары'], []),
        'utf-8'
      );

      const newMembers = resolveNewSubsystemMembers(dumpDir, ['Подсистема.Продажи'], new Set(['Справочник.Товары', 'Подсистема.Продажи']));
      assert.deepStrictEqual(newMembers, []);
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('подсистема из списка ещё не выгружена в dumpDir (будет довыгружена в следующем раунде) — пропускается без исключения', () => {
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-newmembers-notyet-'));
    try {
      assert.deepStrictEqual(resolveNewSubsystemMembers(dumpDir, ['Подсистема.ЕщёНеВыгружена'], new Set()), []);
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });
});
