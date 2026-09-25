import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveSubsystemMemberFullNames,
  resolveXmlPathByFullName,
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
 *
 * Раздел 10 (Р2/Р4/Р10): по той же причине здесь НЕ фиксируется новая форма
 * `{kind:'objects'; anchors; fullNames; expansion}` и новая сигнатура
 * `buildRepositoryDumpPlan(node, objects, recursive, configRoot)` — поле
 * `expansion` целиком зависит от контракта `RepositoryDumpRounds.UnitExpansion`
 * (см. `repositoryDumpRounds.test.ts`, где раскрытие подчинённых единиц уже
 * покрыто параметризованно), а `anchors`/`fullNames` наблюдаемы только через
 * реальный вызов `RepositoryLockSync`/`RepositoryUnlockSync`. Синтетический тест
 * здесь заранее угадывал бы, ЧТО именно `buildRepositoryDumpPlan` кладёт в
 * `fullNames` для рекурсивного/нерекурсивного захвата верхнеуровневого объекта
 * (список полностью раскрытых подчинённых по проекту? только якорь? частично?)
 * — эта развилка прямо влияет на число вызовов `dumpToTemp` в
 * `RepositoryLockSync`, поэтому решается и фиксируется тестами ТАМ, а не тут.
 * D3 (см. `resolveSubsystemMemberFullNames` выше) — фиксируется здесь, так как
 * это точечное исправление уже существующей, наблюдаемой в этом файле функции.
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

      // D3 (раздел 10, Р10): вложенная подсистема называется "Подсистема.Продажи.Подсистема.Розница",
      // а НЕ просто "Подсистема.Розница" — платформа отклоняет короткое имя (10.12 «Имена подчинённых»).
      const recursive = resolveSubsystemMemberFullNames(subsystemXmlPath, true);
      assert.deepStrictEqual(
        [...recursive].sort(),
        ['Подсистема.Продажи', 'Справочник.Товары', 'Подсистема.Продажи.Подсистема.Розница', 'Документ.ЗаказПокупателя'].sort()
      );
      assert.ok(!recursive.includes('Подсистема.Розница'), 'Регресс D3: короткое имя вложенной подсистемы платформа отклоняет.');
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

/*
 * `resolveNewSubsystemMembers` УДАЛЁН этой задачей (раздел 10, Р10:
 * «resolveNewSubsystemMembers, isNestedSubsystemMember, includeNestedSubsystems
 * удаляются») — довыгрузка недостающих участников рекурсивной подсистемы
 * теперь ведётся раундами через `RepositoryDumpRounds.runDumpRounds` с
 * `createSubsystemExpansion`, см. `repositoryDumpRounds.test.ts`
 * (`createSubsystemExpansion`, `runDumpRounds: раунд 0 успешен`). Прежние три
 * теста этого suite дублировали бы то же поведение через удалённую функцию —
 * не переносятся, а заменяются эквивалентными сценариями там.
 */
