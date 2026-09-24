import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Фикстуры выгрузки 1С для проверки плоской и глубокой раскладки XML объекта:
 * минимальные XML конфигурации/объекта и синтетический `ParentConfigurations.bin`.
 * Не зависят от `example/`, чтобы проверка поиска XML не требовала полного
 * эталона выгрузки.
 */

/**
 * Детерминированный псевдо-uuid по строке-seed (не криптографический, только
 * для тестов — чтобы разные объекты фикстуры гарантированно не совпадали).
 * Формат совпадает с `UUID_ATTR_RE` в `SupportInfoService`.
 */
export function fixtureUuid(seed: string): string {
  const hash = crypto.createHash('md5').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function minimalConfigurationXml(uuid: string, name: string): string {
  // BOM через \uFEFF-экранирование (не литеральным символом), как в
  // существующих фикстурах (metadataMutationServiceSupport.test.ts) — чтобы
  // не триггерить no-irregular-whitespace, но сохранить реальный BOM 1С.
  return `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xs="http://www.w3.org/2001/XMLSchema" version="2.21">
  <Configuration uuid="${uuid}">
    <Properties>
      <Name>${name}</Name>
      <Synonym/>
    </Properties>
    <ChildObjects/>
  </Configuration>
</MetaDataObject>`;
}

function minimalObjectXml(tag: string, name: string, uuid: string): string {
  return `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xs="http://www.w3.org/2001/XMLSchema" version="2.21">
  <${tag} uuid="${uuid}">
    <Properties>
      <Name>${name}</Name>
      <Synonym/>
    </Properties>
    <ChildObjects/>
  </${tag}>
</MetaDataObject>`;
}

/** Пишет минимальный `Configuration.xml` в `configRoot` (создаёт каталог при необходимости). */
export function writeConfigurationXml(configRoot: string, uuid: string, name = 'ТестоваяКонфигурация'): string {
  fs.mkdirSync(configRoot, { recursive: true });
  const xmlPath = path.join(configRoot, 'Configuration.xml');
  fs.writeFileSync(xmlPath, minimalConfigurationXml(uuid, name), 'utf-8');
  return xmlPath;
}

export type ObjectXmlLayout = 'flat' | 'deep';

/**
 * Пишет XML объекта метаданных в плоской (`<root>/<folder>/<name>.xml`) или
 * глубокой (`<root>/<folder>/<name>/<name>.xml`) раскладке выгрузки.
 */
export function writeObjectXml(
  configRoot: string,
  folder: string,
  name: string,
  tag: string,
  uuid: string,
  layout: ObjectXmlLayout
): string {
  const dir = layout === 'deep' ? path.join(configRoot, folder, name) : path.join(configRoot, folder);
  fs.mkdirSync(dir, { recursive: true });
  const xmlPath = path.join(dir, `${name}.xml`);
  fs.writeFileSync(xmlPath, minimalObjectXml(tag, name, uuid), 'utf-8');
  return xmlPath;
}

/** Пишет пустой BSL-файл по указанному пути (создаёт промежуточные каталоги). */
export function writeBslFile(bslPath: string, content = ''): string {
  fs.mkdirSync(path.dirname(bslPath), { recursive: true });
  fs.writeFileSync(bslPath, content, 'utf-8');
  return bslPath;
}

/**
 * Коды режима поддержки объекта («a» — первое число в записи `a,b,uuid,uuid`
 * реального `Ext/ParentConfigurations.bin`, см. шапку
 * `example/tools/build-supported-cf.mjs`): 0 — объект поставщика не
 * редактируется, 1 — редактируется с сохранением поддержки, 2 — снят с
 * поддержки. Это НЕ значения `SupportMode` — трактовку кода в домен делает
 * `SupportInfoService` (0→Locked, 1→Editable, 2→None).
 */
export const SUPPORT_BIN_CODE = { locked: 0, editable: 1, removed: 2 } as const;

/**
 * Шапка поставщика и числовой хвост записей — взяты буквально из реального
 * `example/2.21/src/cf/Ext/ParentConfigurations.bin` (та же поставка, что и в
 * `example/2.20`): `{6,<флаг>,<vendorCount>,<uuid1>,<copyMatches>,<uuid2>,
 * "<версия>","<поставщик>","<имя>",<declaredCount>,<записи>,<хвост>}`. Смысл
 * `<uuid1>`/`<uuid2>`/хвоста для тестов не важен — они лишь должны сохранять
 * реальную форму, чтобы `parseParentConfigurations` не отбивал файл как
 * нераспознанный.
 */
const VENDOR_UUID_1 = 'd373e051-3ee4-4d72-8f88-e47ab1df50aa';
const VENDOR_UUID_2 = '13aef131-d246-42a7-9f3c-b3ccaf6f386f';
const VENDOR_VERSION = '0.0.0.1';
const VENDOR_NAME = 'Example';
const VENDOR_CONFIG_NAME = 'ТорговыйУчет';
const TAIL_NUMBERS = '0,0,0,1,0,0,0,1,0,1,0,1,1,1,1';

/**
 * Синтезирует `Ext/ParentConfigurations.bin` в реальном формате платформы
 * (`{6,<флаг>,<vendorCount>,…,<declaredCount>,a,b,uuid,uuid,…,<хвост>}`,
 * см. `parseParentConfigurations`). `records` — карта uuid объекта → код `a`
 * (см. {@link SUPPORT_BIN_CODE}); `extraRecords` добавляет записи с
 * ПОВТОРЯЮЩИМСЯ uuid (несколько поставщиков одного объекта) — `ReadonlyMap` не
 * допускает дублей ключей, поэтому такие записи передаются отдельным списком.
 */
export function writeParentConfigurationsBin(
  configRoot: string,
  records: ReadonlyMap<string, number>,
  options?: {
    changesForbidden?: boolean;
    vendorCount?: number;
    declaredCount?: number;
    bom?: boolean;
    extraRecords?: readonly [number, string][];
  }
): string {
  const extDir = path.join(configRoot, 'Ext');
  fs.mkdirSync(extDir, { recursive: true });

  const allRecords: [number, string][] = [...records.entries()].map(([uuid, code]) => [code, uuid]);
  if (options?.extraRecords) {
    allRecords.push(...options.extraRecords);
  }
  const declaredCount = options?.declaredCount ?? allRecords.length;
  const recordsBody = allRecords.map(([code, uuid]) => `${String(code)},0,${uuid},${uuid}`).join(',');

  const header =
    `{6,${options?.changesForbidden ? '1' : '0'},${String(options?.vendorCount ?? 1)},` +
    `${VENDOR_UUID_1},0,${VENDOR_UUID_2},"${VENDOR_VERSION}","${VENDOR_NAME}","${VENDOR_CONFIG_NAME}",` +
    String(declaredCount);
  const body = recordsBody ? `,${recordsBody}` : '';
  const content = `${header}${body},${TAIL_NUMBERS}}`;

  const binPath = path.join(extDir, 'ParentConfigurations.bin');
  // BOM через String.fromCharCode (не литеральным невидимым символом в
  // исходнике) — см. те же соображения в minimalConfigurationXml выше.
  const bom = options?.bom ? String.fromCharCode(0xfeff) : '';
  fs.writeFileSync(binPath, bom + content, 'utf-8');
  return binPath;
}
