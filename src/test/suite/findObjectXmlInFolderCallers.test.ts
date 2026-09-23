/**
 * Характеризация поиска XML объекта в местах, которые раньше держали свои копии
 * логики «глубокая форма → плоская форма», а теперь вызывают общую
 * `findObjectXmlInFolder` (`infra/fs/ObjectLocation.ts`):
 *   - `MetadataCache` — корневые и вложенные подсистемы дерева;
 *   - `SubsystemXmlService` — дерево принадлежности объекта к подсистемам;
 *   - `ConfigurationValidationService` — наличие XML объектов из ChildObjects.
 * Фиксирует наблюдаемый результат на обеих раскладках, приоритет глубокой при
 * наличии обеих и пропуск/ошибку при отсутствии файла. Фикстуры — временные
 * каталоги, без `example/`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMetadataCacheSnapshot, type MetadataCacheNode } from '../../infra/cache/MetadataCache';
import { ConfigurationValidationService } from '../../infra/xml/ConfigurationValidationService';
import { SubsystemXmlService } from '../../infra/xml/SubsystemXmlService';

type Layout = 'deep' | 'flat';
const LAYOUTS: readonly Layout[] = ['deep', 'flat'];

function writeFile(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Путь XML объекта в папке `<root>/<folder>` для заданной раскладки. */
function objectXmlPath(root: string, folder: string, name: string, layout: Layout): string {
  return layout === 'deep'
    ? path.join(root, folder, name, `${name}.xml`)
    : path.join(root, folder, `${name}.xml`);
}

function buildConfigXml(childObjects: readonly string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MetaDataObject>
  <Configuration uuid="11111111-2222-3333-4444-555555555555">
    <Properties>
      <Name>ТестоваяКонфигурация</Name>
      <Synonym/>
    </Properties>
    <ChildObjects>
      ${childObjects.join('\n      ')}
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;
}

function buildSubsystemXml(name: string, childSubsystems: readonly string[] = []): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MetaDataObject>
  <Subsystem>
    <Properties>
      <Name>${name}</Name>
      <Synonym/>
      <Content/>
    </Properties>
    ${childSubsystems.length > 0
      ? `<ChildObjects>${childSubsystems.map((child) => `<Subsystem>${child}</Subsystem>`).join('')}</ChildObjects>`
      : '<ChildObjects/>'}
  </Subsystem>
</MetaDataObject>`;
}

/** Узлы подсистем с XML; группа «Подсистемы» тоже имеет тип `Subsystem`, но без `xmlPath`. */
function isSubsystemObject(node: MetadataCacheNode): boolean {
  return node.type === 'Subsystem' && node.xmlPath !== undefined;
}

function collectNodes(node: MetadataCacheNode, predicate: (item: MetadataCacheNode) => boolean): MetadataCacheNode[] {
  const own = predicate(node) ? [node] : [];
  return own.concat(...node.children.map((child) => collectNodes(child, predicate)));
}

suite('findObjectXmlInFolder: переиспользование в MetadataCache/SubsystemXmlService/ConfigurationValidationService', () => {
  let configRoot: string;

  setup(() => {
    configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-find-object-xml-callers-'));
  });

  teardown(() => {
    fs.rmSync(configRoot, { recursive: true, force: true });
  });

  /**
   * Корневая подсистема в раскладке `rootLayout` с одной дочерней в `childLayout`
   * и одной объявленной, но отсутствующей дочерней. Дом корневой — всегда
   * `Subsystems/<Имя>`, независимо от раскладки её XML.
   */
  function writeSubsystemTree(rootLayout: Layout, childLayout: Layout): { rootXml: string; childXml: string } {
    writeFile(
      path.join(configRoot, 'Configuration.xml'),
      buildConfigXml(['<Subsystem>Продажи</Subsystem>', '<Subsystem>Отсутствует</Subsystem>'])
    );
    const rootXml = writeFile(
      objectXmlPath(configRoot, 'Subsystems', 'Продажи', rootLayout),
      buildSubsystemXml('Продажи', ['Розница', 'НеСуществует'])
    );
    const childXml = writeFile(
      objectXmlPath(path.join(configRoot, 'Subsystems', 'Продажи'), 'Subsystems', 'Розница', childLayout),
      buildSubsystemXml('Розница')
    );
    return { rootXml, childXml };
  }

  function writeBothLayouts(): { deepXml: string; flatXml: string } {
    writeFile(path.join(configRoot, 'Configuration.xml'), buildConfigXml(['<Subsystem>Продажи</Subsystem>']));
    const deepXml = writeFile(objectXmlPath(configRoot, 'Subsystems', 'Продажи', 'deep'), buildSubsystemXml('Продажи'));
    const flatXml = writeFile(objectXmlPath(configRoot, 'Subsystems', 'Продажи', 'flat'), buildSubsystemXml('Продажи'));
    return { deepXml, flatXml };
  }

  for (const rootLayout of LAYOUTS) {
    for (const childLayout of LAYOUTS) {
      const caseName = `корень ${rootLayout}, дочерняя ${childLayout}`;

      test(`MetadataCache находит корневую и дочернюю подсистемы (${caseName}), отсутствующие пропускает`, () => {
        const { rootXml, childXml } = writeSubsystemTree(rootLayout, childLayout);

        const snapshot = buildMetadataCacheSnapshot('test-find-object-xml-subsystems', { rootPath: configRoot, kind: 'cf' });
        const subsystems = collectNodes(snapshot.root, isSubsystemObject);

        assert.deepStrictEqual(
          subsystems.map((item) => [item.name, item.xmlPath]),
          [['Продажи', rootXml], ['Розница', childXml]]
        );
        assert.deepStrictEqual(subsystems[0].children.filter(isSubsystemObject), [subsystems[1]]);
      });

      test(`SubsystemXmlService строит дерево принадлежности (${caseName}), отсутствующие пропускает`, () => {
        const { rootXml, childXml } = writeSubsystemTree(rootLayout, childLayout);

        const snapshot = new SubsystemXmlService().readMembershipSnapshot(configRoot, 'Catalog.Товары');

        assert.deepStrictEqual(snapshot.tree.map((item) => item.xmlPath), [rootXml]);
        assert.deepStrictEqual(snapshot.tree[0].children.map((item) => item.xmlPath), [childXml]);
      });
    }
  }

  test('MetadataCache при наличии обеих раскладок подсистемы берёт глубокую', () => {
    const { deepXml } = writeBothLayouts();

    const snapshot = buildMetadataCacheSnapshot('test-find-object-xml-subsystems-both', { rootPath: configRoot, kind: 'cf' });

    assert.deepStrictEqual(
      collectNodes(snapshot.root, isSubsystemObject).map((item) => item.xmlPath),
      [deepXml]
    );
  });

  test('SubsystemXmlService при наличии обеих раскладок подсистемы берёт глубокую', () => {
    const { deepXml } = writeBothLayouts();

    const snapshot = new SubsystemXmlService().readMembershipSnapshot(configRoot, 'Catalog.Товары');

    assert.deepStrictEqual(snapshot.tree.map((item) => item.xmlPath), [deepXml]);
  });

  test('ConfigurationValidationService находит XML объекта в глубокой, плоской и обеих раскладках, отсутствующий — ошибка', () => {
    writeFile(
      path.join(configRoot, 'Configuration.xml'),
      buildConfigXml([
        '<Catalog>Глубокий</Catalog>',
        '<Catalog>Плоский</Catalog>',
        '<Catalog>Оба</Catalog>',
        '<Catalog>Нет</Catalog>',
      ])
    );
    writeFile(objectXmlPath(configRoot, 'Catalogs', 'Глубокий', 'deep'), '<MetaDataObject/>');
    writeFile(objectXmlPath(configRoot, 'Catalogs', 'Плоский', 'flat'), '<MetaDataObject/>');
    writeFile(objectXmlPath(configRoot, 'Catalogs', 'Оба', 'deep'), '<MetaDataObject/>');
    writeFile(objectXmlPath(configRoot, 'Catalogs', 'Оба', 'flat'), '<MetaDataObject/>');

    const result = new ConfigurationValidationService().validate({ configPath: configRoot, detailed: true });
    const childObjectIssues = result.issues.filter((issue) => issue.message.startsWith('Catalog.'));

    assert.deepStrictEqual(childObjectIssues, [
      { severity: 'ok', message: 'Catalog.Глубокий: XML найден.' },
      { severity: 'ok', message: 'Catalog.Плоский: XML найден.' },
      { severity: 'ok', message: 'Catalog.Оба: XML найден.' },
      { severity: 'error', message: 'Catalog.Нет: XML-файл не найден в Catalogs.' },
    ]);
  });
});
