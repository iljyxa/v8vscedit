import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfeBorrowService } from '../../infra/cfe/CfeBorrowService';
import { extractNestingAwareBlock, findChildMetaElementRange } from '../../infra/xml/XmlUtils';

/**
 * Оболочка заимствованного объекта получала `<ChildObjects/>` только по параллельному списку типов,
 * в котором не было обработок, отчётов и журналов документов (issue #28). `borrowForm`/`borrowChild`
 * для них не находили `<ChildObjects>` и молча ничего не регистрировали, возвращая
 * `alreadyBorrowed: false`. Состав теперь берётся из `META_TYPES[kind].childTags`, а невозможность
 * регистрации — исключение до записи файлов.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example/2.21/src');
const CF_DIR = path.join(EXAMPLE_ROOT, 'cf');
const EVOLC_DIR = path.join(EXAMPLE_ROOT, 'cfe', 'EVOLC');
const BOM = '﻿';

const XMLNS_DECL =
  'xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' +
  'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" ' +
  'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' +
  'xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" ' +
  'xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" ' +
  'xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" ' +
  'xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" ' +
  'xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" ' +
  'xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Сгенерированные при заимствовании UUID случайны — в эталоне они заменены плейсхолдером. */
function maskGeneratedUuids(xml: string, keep: string): string {
  return xml.replace(UUID_RE, (uuid) => (uuid === keep ? uuid : '<uuid>'));
}

interface ShellCase {
  typeName: string;
  folder: string;
  objectName: string;
  /** UUID объекта в исходной конфигурации — попадает в ExtendedConfigurationObject */
  sourceUuid: string;
  generated: [string, string][];
}

const SHELL_CASES: ShellCase[] = [
  {
    typeName: 'DataProcessor', folder: 'DataProcessors', objectName: 'Обработка1',
    sourceUuid: 'f6508410-4ef7-4ea3-936a-f925d05ab6c8',
    generated: [['DataProcessorObject', 'Object'], ['DataProcessorManager', 'Manager']],
  },
  {
    typeName: 'Report', folder: 'Reports', objectName: 'Запасы',
    sourceUuid: '204be15f-a2e1-4112-88b1-143f43bd5a92',
    generated: [['ReportObject', 'Object'], ['ReportManager', 'Manager']],
  },
  {
    typeName: 'DocumentJournal', folder: 'DocumentJournals', objectName: 'ДокументыСклада',
    sourceUuid: 'deef0098-8734-451d-94ee-74c7f41cb0bc',
    generated: [
      ['DocumentJournalSelection', 'Selection'],
      ['DocumentJournalList', 'List'],
      ['DocumentJournalManager', 'Manager'],
    ],
  },
];

function expectedShell(c: ShellCase): string {
  const generatedLines = c.generated.flatMap(([prefix, category]) => [
    `\t\t\t<xr:GeneratedType name="${prefix}.${c.objectName}" category="${category}">`,
    '\t\t\t\t<xr:TypeId><uuid></xr:TypeId>',
    '\t\t\t\t<xr:ValueId><uuid></xr:ValueId>',
    '\t\t\t</xr:GeneratedType>',
  ]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MetaDataObject ${XMLNS_DECL} version="2.21">`,
    `\t<${c.typeName} uuid="<uuid>">`,
    '\t\t<InternalInfo>',
    ...generatedLines,
    '\t\t</InternalInfo>',
    '\t\t<Properties>',
    '\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>',
    `\t\t\t<Name>${c.objectName}</Name>`,
    '\t\t\t<Comment/>',
    `\t\t\t<ExtendedConfigurationObject>${c.sourceUuid}</ExtendedConfigurationObject>`,
    '\t\t</Properties>',
    '\t\t<ChildObjects/>',
    `\t</${c.typeName}>`,
    '</MetaDataObject>',
  ].join('\n');
}

/** Оболочка в формате до исправления: без `<ChildObjects/>`, BOM + CRLF, как после Конфигуратора. */
function legacyShellWithoutChildObjects(c: ShellCase): string {
  const shell = expectedShell(c)
    .replace('\t\t<ChildObjects/>\n', '')
    .replace(/<uuid>/g, '00000000-0000-4000-8000-000000000000');
  return BOM + shell.replace(/\n/g, '\r\n');
}

/**
 * Зарегистрирован ли дочерний элемент в главном `<ChildObjects>`: структурные (реквизит, команда)
 * пишутся полным блоком с `<Name>`, остальные (макет, форма) — текстовой ссылкой.
 */
function isRegisteredInMainChildObjects(xml: string, childTag: string, childName: string): boolean {
  if (findChildMetaElementRange(xml, childTag, childName)) {
    return true;
  }
  return (extractNestingAwareBlock(xml, 'ChildObjects') ?? '').includes(`<${childTag}>${childName}</${childTag}>`);
}

suite('CfeBorrowService — ChildObjects оболочки по META_TYPES (issue #28)', () => {
  let extDir: string;
  let service: CfeBorrowService;

  setup(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-cfe-child-objects-'));
    fs.cpSync(EVOLC_DIR, extDir, { recursive: true });
    service = new CfeBorrowService();
  });

  teardown(() => {
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  const objFileOf = (c: ShellCase): string => path.join(extDir, c.folder, `${c.objectName}.xml`);
  const caseOf = (typeName: string): ShellCase => {
    const found = SHELL_CASES.find((c) => c.typeName === typeName);
    assert.ok(found);
    return found;
  };

  for (const c of SHELL_CASES) {
    test(`${c.typeName}: оболочка побайтно совпадает с эталоном и содержит <ChildObjects/>`, () => {
      const result = service.borrowObject(CF_DIR, extDir, c.typeName, c.objectName);

      const objFile = objFileOf(c);
      assert.deepStrictEqual(result, {
        alreadyBorrowed: false,
        files: [objFile, path.join(extDir, 'Configuration.xml')],
      });
      const actual = fs.readFileSync(objFile, 'utf-8');
      assert.strictEqual(maskGeneratedUuids(actual, c.sourceUuid), expectedShell(c));
    });
  }

  const registrations: { typeName: string; childTag: string; childName: string }[] = [
    { typeName: 'DataProcessor', childTag: 'Template', childName: 'Макет' },
    { typeName: 'DataProcessor', childTag: 'Attribute', childName: 'Реквизит1' },
    { typeName: 'DataProcessor', childTag: 'Command', childName: 'Команда1' },
    { typeName: 'Report', childTag: 'Template', childName: 'ОсновнаяСхемаКомпоновкиДанных' },
    { typeName: 'DocumentJournal', childTag: 'Template', childName: 'Макет' },
    { typeName: 'DocumentJournal', childTag: 'Command', childName: 'Команда1' },
  ];

  for (const r of registrations) {
    test(`${r.typeName}: borrowChild ${r.childTag}.${r.childName} регистрирует элемент в <ChildObjects>`, () => {
      const c = caseOf(r.typeName);
      const result = service.borrowChild(CF_DIR, extDir, r.typeName, c.objectName, r.childTag, r.childName);

      const objFile = objFileOf(c);
      assert.deepStrictEqual(result, {
        alreadyBorrowed: false,
        files: [objFile, path.join(extDir, 'Configuration.xml')],
      });
      const xml = fs.readFileSync(objFile, 'utf-8');
      assert.ok(
        isRegisteredInMainChildObjects(xml, r.childTag, r.childName),
        `в XML объекта должен быть зарегистрирован ${r.childTag}.${r.childName}`
      );

      const repeat = service.borrowChild(CF_DIR, extDir, r.typeName, c.objectName, r.childTag, r.childName);
      assert.deepStrictEqual(repeat, { alreadyBorrowed: true, files: [] });
      assert.strictEqual(fs.readFileSync(objFile, 'utf-8'), xml);
    });
  }

  test('DataProcessor: borrowForm регистрирует форму в XML обработки', () => {
    // Форм у обработок в example/ нет — во временную копию выгрузки переносится реальная форма
    // справочника: для заимствования важна только структура Forms/<Имя>.xml + Ext/Form.xml.
    const cfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-cfe-child-objects-cf-'));
    try {
      const sourceForms = path.join(CF_DIR, 'Catalogs', 'ПричиныВозврата', 'Forms');
      const targetForms = path.join(cfDir, 'DataProcessors', 'Обработка1', 'Forms');
      fs.cpSync(path.join(CF_DIR, 'DataProcessors'), path.join(cfDir, 'DataProcessors'), { recursive: true });
      fs.cpSync(sourceForms, targetForms, { recursive: true });

      const result = service.borrowForm(cfDir, extDir, 'DataProcessor', 'Обработка1', 'ФормаЭлемента');

      const c = caseOf('DataProcessor');
      const objFile = objFileOf(c);
      const formsDir = path.join(extDir, 'DataProcessors', 'Обработка1', 'Forms');
      assert.deepStrictEqual(result, {
        alreadyBorrowed: false,
        files: [
          objFile,
          path.join(extDir, 'Configuration.xml'),
          path.join(formsDir, 'ФормаЭлемента.xml'),
          path.join(formsDir, 'ФормаЭлемента', 'Ext', 'Form.xml'),
          path.join(formsDir, 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl'),
        ],
      });
      const xml = maskGeneratedUuids(fs.readFileSync(objFile, 'utf-8'), c.sourceUuid);
      assert.strictEqual(
        xml,
        expectedShell(c).replace(
          '\t\t<ChildObjects/>',
          '\t\t<ChildObjects>\n\t\t\t<Form>ФормаЭлемента</Form>\n\t\t</ChildObjects>'
        )
      );
    } finally {
      fs.rmSync(cfDir, { recursive: true, force: true });
    }
  });

  for (const c of SHELL_CASES) {
    test(`${c.typeName}: оболочке, заимствованной до исправления, <ChildObjects> дописывается с сохранением BOM/CRLF`, () => {
      const objFile = objFileOf(c);
      fs.mkdirSync(path.dirname(objFile), { recursive: true });
      const legacy = legacyShellWithoutChildObjects(c);
      fs.writeFileSync(objFile, legacy, 'utf-8');

      const result = service.borrowChild(CF_DIR, extDir, c.typeName, c.objectName, 'Template', 'Макет');

      assert.deepStrictEqual(result, { alreadyBorrowed: false, files: [objFile] });
      const expected = legacy.replace(
        '\t\t</Properties>\r\n',
        '\t\t</Properties>\r\n\t\t<ChildObjects>\r\n\t\t\t<Template>Макет</Template>\r\n\t\t</ChildObjects>\r\n'
      );
      assert.strictEqual(fs.readFileSync(objFile, 'utf-8'), expected);
    });
  }

  suite('borrowForm: файлы формы уже есть, а запись в XML объекта не попала', () => {
    /** Имитирует формы, оставленные borrowForm до исправления: файл формы есть, регистрации нет. */
    const placeFormFiles = (): void => {
      const formsDir = path.join(extDir, 'DataProcessors', 'Обработка1', 'Forms');
      fs.mkdirSync(formsDir, { recursive: true });
      fs.copyFileSync(
        path.join(CF_DIR, 'Catalogs', 'ПричиныВозврата', 'Forms', 'ФормаЭлемента.xml'),
        path.join(formsDir, 'ФормаЭлемента.xml')
      );
    };

    test('старая оболочка без <ChildObjects>: форма регистрируется, BOM/CRLF сохраняются', () => {
      const c = caseOf('DataProcessor');
      const objFile = objFileOf(c);
      fs.mkdirSync(path.dirname(objFile), { recursive: true });
      const legacy = legacyShellWithoutChildObjects(c);
      fs.writeFileSync(objFile, legacy, 'utf-8');
      placeFormFiles();

      const result = service.borrowForm(CF_DIR, extDir, 'DataProcessor', 'Обработка1', 'ФормаЭлемента');

      assert.deepStrictEqual(result, { alreadyBorrowed: false, files: [objFile] });
      assert.strictEqual(
        fs.readFileSync(objFile, 'utf-8'),
        legacy.replace(
          '\t\t</Properties>\r\n',
          '\t\t</Properties>\r\n\t\t<ChildObjects>\r\n\t\t\t<Form>ФормаЭлемента</Form>\r\n\t\t</ChildObjects>\r\n'
        )
      );

      const repeat = service.borrowForm(CF_DIR, extDir, 'DataProcessor', 'Обработка1', 'ФормаЭлемента');
      assert.deepStrictEqual(repeat, { alreadyBorrowed: true, files: [] });
    });

    test('оболочки объекта нет: она создаётся, форма регистрируется, XML объекта в files один раз', () => {
      placeFormFiles();

      const result = service.borrowForm(CF_DIR, extDir, 'DataProcessor', 'Обработка1', 'ФормаЭлемента');

      const objFile = objFileOf(caseOf('DataProcessor'));
      assert.deepStrictEqual(result, {
        alreadyBorrowed: false,
        files: [objFile, path.join(extDir, 'Configuration.xml')],
      });
      assert.ok(isRegisteredInMainChildObjects(fs.readFileSync(objFile, 'utf-8'), 'Form', 'ФормаЭлемента'));
    });
  });

  test('XML объекта без <Properties> и <ChildObjects> — явная ошибка, файл не меняется', () => {
    const c = caseOf('Report');
    const objFile = objFileOf(c);
    fs.mkdirSync(path.dirname(objFile), { recursive: true });
    const broken = `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject>\n\t<Report uuid="x"/>\n</MetaDataObject>`;
    fs.writeFileSync(objFile, broken, 'utf-8');

    assert.throws(
      () => service.borrowChild(CF_DIR, extDir, 'Report', c.objectName, 'Template', 'ОсновнаяСхемаКомпоновкиДанных'),
      /Не удалось зарегистрировать Template\.ОсновнаяСхемаКомпоновкиДанных: в XML объекта нет блока <Properties>/
    );
    assert.strictEqual(fs.readFileSync(objFile, 'utf-8'), broken);
  });

  suite('тип без дочерних объектов — ошибка до записи файлов', () => {
    const snapshotExtension = (): Record<string, string> => {
      const files: Record<string, string> = {};
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else {
            files[path.relative(extDir, full)] = fs.readFileSync(full, 'utf-8');
          }
        }
      };
      walk(extDir);
      return files;
    };

    test('borrowChild у общего модуля отбивается, расширение не меняется', () => {
      const before = snapshotExtension();
      assert.throws(
        () => service.borrowChild(CF_DIR, extDir, 'CommonModule', 'ОбщийМодуль1', 'Template', 'Макет'),
        /Тип "CommonModule" не содержит дочерних объектов: заимствование Template\.Макет невозможно/
      );
      assert.deepStrictEqual(snapshotExtension(), before);
    });

    test('borrowForm у константы отбивается, расширение не меняется', () => {
      const before = snapshotExtension();
      assert.throws(
        () => service.borrowForm(CF_DIR, extDir, 'Constant', 'Константа1', 'Форма'),
        /Тип "Constant" не содержит дочерних объектов: заимствование формы Форма невозможно/
      );
      assert.deepStrictEqual(snapshotExtension(), before);
    });

    test('URL-шаблон HTTP-сервиса (контейнер с методами) отбивается, расширение не меняется', () => {
      // Оболочка HTTP-сервиса теперь несёт <ChildObjects/>, но текстовая ссылка <URLTemplate>Имя</URLTemplate>
      // была бы невалидным XML для платформы.
      const before = snapshotExtension();
      assert.throws(
        () => service.borrowChild(CF_DIR, extDir, 'HTTPService', 'Chatbot', 'URLTemplate', 'Шаблон'),
        /Заимствование URLTemplate\.Шаблон не поддерживается: элемент содержит вложенные объекты/
      );
      assert.deepStrictEqual(snapshotExtension(), before);
    });

    test('неизвестный тип по-прежнему отбивается сообщением borrowObject', () => {
      assert.throws(
        () => service.borrowChild(CF_DIR, extDir, 'constructor', 'X', 'Template', 'Макет'),
        /Неизвестный тип метаданных для заимствования: "constructor"/
      );
    });
  });
});
