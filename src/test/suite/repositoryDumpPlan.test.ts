import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRepositoryDumpPlan,
  resolveSubsystemMemberFullNames,
  resolveXmlPathByFullName,
} from '../../infra/repository/RepositoryDumpPlan';
import { CONFIGURATION_ROOT_LOCK_NAME, EXTENSION_ROOT_LOCK_NAME } from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryNodeRef } from '../../infra/repository/RepositoryService';

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
 * Раздел 10 (Р2/Р4/Р10), уточнение по факту реализации: решение test-writer
 * (10.13.13) откладывало юнит-тест `buildRepositoryDumpPlan` до наблюдения через
 * потоки `RepositoryLockSync`/`RepositoryUnlockSync`. Флоу-тесты покрывают лишь
 * часть веток диспетчера (root/root-incremental, Subsystem с xmlPath, объект без
 * recursive), поэтому ветка `kind:'objects'`/`expansion:'subordinates'` для
 * РЕКУРСИВНОГО объекта БЕЗ `Subsystem`-узла (включая Subsystem-узел без
 * `xmlPath`, который проваливается в ту же ветку) оставалась непокрытой —
 * добавлен прямой юнит-тест диспетчера ниже (не дублирует форму `fullNames` для
 * Subsystem-веток, которая по-прежнему фиксируется только через
 * `RepositoryLockSync`).
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

  test('повреждённый (нечитаемый) XML подсистемы — пустой результат, ветка пропускается без исключения', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-subsystem-broken-'));
    try {
      // fs.existsSync() для каталога тоже true — readFileSync внутри readSubsystem
      // бросит EISDIR, попав ровно в защитную ветку catch (не связано с содержимым XML).
      const brokenPath = path.join(configRoot, 'Subsystems', 'Сломанная.xml');
      fs.mkdirSync(brokenPath, { recursive: true });
      assert.deepStrictEqual(resolveSubsystemMemberFullNames(brokenPath, true), []);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test('дочерняя подсистема во ПЛОСКОЙ раскладке (Subsystems/Родитель/Subsystems/Ребёнок.xml, без вложенного каталога)', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-subsystem-flat-child-'));
    try {
      fs.mkdirSync(path.join(configRoot, 'Subsystems', 'Опт', 'Subsystems'), { recursive: true });
      fs.writeFileSync(
        path.join(configRoot, 'Subsystems', 'Опт.xml'),
        buildSubsystemXml('Опт', [], ['Партнеры']),
        'utf-8'
      );
      // Плоская раскладка ребёнка — нет каталога Subsystems/Опт/Subsystems/Партнеры/.
      fs.writeFileSync(
        path.join(configRoot, 'Subsystems', 'Опт', 'Subsystems', 'Партнеры.xml'),
        buildSubsystemXml('Партнеры', ['Catalog.Контрагенты'], []),
        'utf-8'
      );

      const result = resolveSubsystemMemberFullNames(path.join(configRoot, 'Subsystems', 'Опт.xml'), true);

      assert.deepStrictEqual(
        [...result].sort(),
        ['Подсистема.Опт', 'Подсистема.Опт.Подсистема.Партнеры', 'Справочник.Контрагенты'].sort()
      );
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });
});

suite('RepositoryDumpPlan — buildRepositoryDumpPlan (issue #1, раздел 10)', () => {
  const configRoot = path.resolve(__dirname, '../../../example/2.21/src/cf');

  function objectNode(xmlPath: string): RepositoryNodeRef {
    return { nodeKind: 'Catalog', label: 'Контрагенты', xmlPath };
  }

  test('anchors[0] — сентинел корня конфигурации, recursive=true → {kind:"root-incremental"}', () => {
    const plan = buildRepositoryDumpPlan({ nodeKind: 'configuration' }, { fullNames: [CONFIGURATION_ROOT_LOCK_NAME] }, true, configRoot);
    assert.deepStrictEqual(plan, { kind: 'root-incremental' });
  });

  test('anchors[0] — сентинел корня конфигурации, recursive=false → {kind:"root-object"}', () => {
    const plan = buildRepositoryDumpPlan({ nodeKind: 'configuration' }, { fullNames: [CONFIGURATION_ROOT_LOCK_NAME] }, false, configRoot);
    assert.deepStrictEqual(plan, { kind: 'root-object' });
  });

  test('anchors[0] — сентинел корня расширения, recursive=true → {kind:"root-incremental"} (та же ветка isRootLockName)', () => {
    const plan = buildRepositoryDumpPlan({ nodeKind: 'extension' }, { fullNames: [EXTENSION_ROOT_LOCK_NAME] }, true, configRoot);
    assert.deepStrictEqual(plan, { kind: 'root-incremental' });
  });

  test('нерекурсивная операция над объектом → {kind:"objects", fullNames===anchors, expansion:"new-subordinates"}', () => {
    const xmlPath = path.join(configRoot, 'Catalogs', 'Контрагенты.xml');
    const plan = buildRepositoryDumpPlan(objectNode(xmlPath), { fullNames: ['Справочник.Контрагенты'] }, false, configRoot);
    assert.deepStrictEqual(plan, {
      kind: 'objects',
      anchors: ['Справочник.Контрагенты'],
      fullNames: ['Справочник.Контрагенты'],
      expansion: 'new-subordinates',
    });
  });

  test('рекурсивный узел Subsystem С xmlPath → expansion:"subsystem", fullNames раскрыты по составу подсистемы', () => {
    const configRootSubsystem = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-dumpplan-buildplan-subsystem-'));
    try {
      fs.mkdirSync(path.join(configRootSubsystem, 'Subsystems'), { recursive: true });
      fs.writeFileSync(
        path.join(configRootSubsystem, 'Subsystems', 'Продажи.xml'),
        buildSubsystemXml('Продажи', ['Catalog.Товары'], []),
        'utf-8'
      );
      fs.mkdirSync(path.join(configRootSubsystem, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(configRootSubsystem, 'Catalogs', 'Товары.xml'), '<MetaDataObject/>', 'utf-8');
      const node: RepositoryNodeRef = { nodeKind: 'Subsystem', label: 'Продажи', xmlPath: path.join(configRootSubsystem, 'Subsystems', 'Продажи.xml') };

      const plan = buildRepositoryDumpPlan(node, { fullNames: ['Подсистема.Продажи'] }, true, configRootSubsystem);

      assert.strictEqual(plan.kind, 'objects');
      assert.strictEqual(plan.expansion, 'subsystem');
      assert.strictEqual(plan.anchors[0], 'Подсистема.Продажи');
      assert.deepStrictEqual([...plan.fullNames].sort(), ['Подсистема.Продажи', 'Справочник.Товары'].sort());
    } finally {
      fs.rmSync(configRootSubsystem, { recursive: true, force: true });
    }
  });

  test('рекурсивный узел Subsystem БЕЗ xmlPath → падает в общую ветку "subordinates" (состав подсистемы не резолвится)', () => {
    const plan = buildRepositoryDumpPlan({ nodeKind: 'Subsystem', label: 'Продажи' }, { fullNames: ['Подсистема.Продажи'] }, true, configRoot);
    assert.strictEqual(plan.kind, 'objects');
    assert.strictEqual(plan.expansion, 'subordinates');
  });

  test('рекурсивный НЕ-Subsystem объект (Catalog) → {expansion:"subordinates"}, fullNames раскрыты по проектным подчинённым', () => {
    const xmlPath = path.join(configRoot, 'Catalogs', 'Контрагенты.xml');
    const plan = buildRepositoryDumpPlan(objectNode(xmlPath), { fullNames: ['Справочник.Контрагенты'] }, true, configRoot);
    assert.strictEqual(plan.kind, 'objects');
    assert.strictEqual(plan.expansion, 'subordinates');
    assert.deepStrictEqual(
      [...plan.fullNames].sort(),
      [
        'Справочник.Контрагенты',
        'Справочник.Контрагенты.Форма.ФормаЭлемента',
        'Справочник.Контрагенты.Форма.ФормаСписка',
        'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла',
      ].sort()
    );
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
