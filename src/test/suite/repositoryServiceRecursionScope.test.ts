import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import { REPOSITORY_SUBORDINATE_LAYOUT, REPOSITORY_SUBORDINATE_TAGS } from '../../infra/repository/RepositoryObjectNames';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/**
 * Issue #61: вопрос о рекурсивном режиме операции хранилища задаётся, только если
 * у единицы узла есть подчинённые объекты хранилища (формы, макеты, перерасчёты,
 * таблицы/кубы источника данных, вложенные подсистемы). Состав берётся из РЕАЛЬНЫХ
 * фикстур `example/2.21/src/cf` и `example/2.21/src/cfe/EVOLC` (сверен по XML):
 * у Контрагентов есть формы и макет, у Начислений — перерасчёт, у ИнтернетМагазин —
 * таблица и куб; у общего модуля, роли, справочника Банки и объектов EVOLC
 * подчинённых единиц нет.
 */

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

const EXAMPLE_CF_21 = path.resolve(__dirname, '../../../example/2.21/src/cf');
const EXAMPLE_EVOLC_21 = path.resolve(__dirname, '../../../example/2.21/src/cfe/EVOLC');

type Root = 'cf' | 'cfe';

interface Harness {
  roots: Record<Root, string>;
  service: RepositoryService;
  dispose(): void;
}

function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-recursion-'));
  const roots: Record<Root, string> = {
    cf: path.join(workspaceRoot, 'src', 'cf'),
    cfe: path.join(workspaceRoot, 'src', 'cfe', 'EVOLC'),
  };
  fs.cpSync(EXAMPLE_CF_21, roots.cf, { recursive: true });
  fs.cpSync(EXAMPLE_EVOLC_21, roots.cfe, { recursive: true });
  const service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  return { roots, service, dispose: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }) };
}

/** Путь к реальному XML фикстуры; `mustExist: false` — заведомо отсутствующий файл. */
function xml(harness: Harness, root: Root, rel: string, mustExist = true): string {
  const filePath = path.join(harness.roots[root], rel);
  assert.strictEqual(fs.existsSync(filePath), mustExist, `${root}/${rel}: ожидалось существование = ${String(mustExist)}`);
  return filePath;
}

/** Дочерний узел дерева: xmlPath у него — XML владельца, как строит MetadataTreeProvider. */
function childNode(harness: Harness, nodeKind: string, label: string | undefined, ownerRel: string, extra: Partial<NonNullable<RepositoryNodeRef['metaContext']>> = {}): RepositoryNodeRef {
  const ownerXml = xml(harness, 'cf', ownerRel);
  return {
    nodeKind,
    ...(label === undefined ? {} : { label }),
    xmlPath: ownerXml,
    metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXml, ...extra },
  };
}

suite('RepositoryService.canApplyRecursively — есть ли у единицы подчинённые объекты хранилища (issue #61)', () => {
  let harness: Harness;

  setup(() => { harness = createHarness(); });
  teardown(() => { harness.dispose(); });

  const cases: readonly { readonly name: string; readonly node: (h: Harness) => RepositoryNodeRef; readonly expected: boolean }[] = [
    { name: 'корень основной конфигурации', expected: true, node: (h) => ({ nodeKind: 'configuration', xmlPath: xml(h, 'cf', 'Configuration.xml') }) },
    { name: 'корень расширения EVOLC', expected: true, node: (h) => ({ nodeKind: 'extension', xmlPath: xml(h, 'cfe', 'Configuration.xml') }) },
    { name: 'подсистема Продажи', expected: true, node: (h) => ({ nodeKind: 'Subsystem', label: 'Продажи', xmlPath: xml(h, 'cf', 'Subsystems/Продажи.xml') }) },
    { name: 'подсистема с несуществующим XML', expected: true, node: (h) => ({ nodeKind: 'Subsystem', label: 'НетТакой', xmlPath: xml(h, 'cf', 'Subsystems/НетТакой.xml', false) }) },
    { name: 'общий модуль ОбщегоНазначения', expected: false, node: (h) => ({ nodeKind: 'CommonModule', label: 'ОбщегоНазначения', xmlPath: xml(h, 'cf', 'CommonModules/ОбщегоНазначения.xml') }) },
    { name: 'роль Администратор', expected: false, node: (h) => ({ nodeKind: 'Role', label: 'Администратор', xmlPath: xml(h, 'cf', 'Roles/Администратор.xml') }) },
    { name: 'справочник Банки (без форм и макетов)', expected: false, node: (h) => ({ nodeKind: 'Catalog', label: 'Банки', xmlPath: xml(h, 'cf', 'Catalogs/Банки.xml') }) },
    { name: 'справочник Контрагенты (формы, макет)', expected: true, node: (h) => ({ nodeKind: 'Catalog', label: 'Контрагенты', xmlPath: xml(h, 'cf', 'Catalogs/Контрагенты.xml') }) },
    { name: 'регистр расчёта Начисления (перерасчёт)', expected: true, node: (h) => ({ nodeKind: 'CalculationRegister', label: 'Начисления', xmlPath: xml(h, 'cf', 'CalculationRegisters/Начисления.xml') }) },
    { name: 'внешний источник ИнтернетМагазин (таблица, куб)', expected: true, node: (h) => ({ nodeKind: 'ExternalDataSource', label: 'ИнтернетМагазин', xmlPath: xml(h, 'cf', 'ExternalDataSources/ИнтернетМагазин.xml') }) },
    { name: 'EVOLC: справочник Контрагенты', expected: false, node: (h) => ({ nodeKind: 'Catalog', label: 'Контрагенты', xmlPath: xml(h, 'cfe', 'Catalogs/Контрагенты.xml') }) },
    { name: 'EVOLC: роль ев_ОсновнаяРоль', expected: false, node: (h) => ({ nodeKind: 'Role', label: 'ев_ОсновнаяРоль', xmlPath: xml(h, 'cfe', 'Roles/ев_ОсновнаяРоль.xml') }) },
    { name: 'форма ФормаЭлемента (xmlPath — XML владельца)', expected: false, node: (h) => childNode(h, 'Form', 'ФормаЭлемента', 'Catalogs/Контрагенты.xml') },
    { name: 'макет ЗагрузкаИзФайла', expected: false, node: (h) => childNode(h, 'Template', 'ЗагрузкаИзФайла', 'Catalogs/Контрагенты.xml') },
    { name: 'форма с несуществующим именем', expected: true, node: (h) => childNode(h, 'Form', 'НетТакойФормы', 'Catalogs/Контрагенты.xml') },
    { name: 'форма без метки (полного имени нет)', expected: true, node: (h) => childNode(h, 'Form', undefined, 'Catalogs/Контрагенты.xml') },
    { name: 'реквизит владельца Контрагенты', expected: true, node: (h) => childNode(h, 'Attribute', 'ИНН', 'Catalogs/Контрагенты.xml') },
    { name: 'реквизит владельца Банки', expected: false, node: (h) => childNode(h, 'Attribute', 'КоррСчет', 'Catalogs/Банки.xml') },
    { name: 'колонка ТЧ владельца Контрагенты', expected: true, node: (h) => childNode(h, 'Column', 'Контакт', 'Catalogs/Контрагенты.xml', { tabularSectionName: 'КонтактныеЛица' }) },
    { name: 'справочник с несуществующим XML', expected: true, node: (h) => ({ nodeKind: 'Catalog', label: 'НетТакого', xmlPath: xml(h, 'cf', 'Catalogs/НетТакого.xml', false) }) },
    { name: 'узел без xmlPath и metaContext', expected: true, node: () => ({ nodeKind: 'Catalog' }) },
  ];

  cases.forEach(({ name, node, expected }) => {
    test(`${name} → ${String(expected)}`, () => {
      assert.strictEqual(harness.service.canApplyRecursively(node(harness)), expected);
    });
  });

  test('теги подчинённых единиц производны от REPOSITORY_SUBORDINATE_LAYOUT', () => {
    assert.deepStrictEqual([...REPOSITORY_SUBORDINATE_TAGS].sort(), Object.keys(REPOSITORY_SUBORDINATE_LAYOUT).sort());
  });
});
