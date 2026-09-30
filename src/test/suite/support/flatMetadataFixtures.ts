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
 * Синтезирует `Ext/ParentConfigurations.bin` в формате, который разбирает
 * `SupportInfoService.parseBinFile`: строки `<uuid>,<uuid>,<mode>`. Формат
 * заголовка `{6,0,1,...}` — образец из `metadataMutationServiceSupport.test.ts`.
 */
export function writeParentConfigurationsBin(configRoot: string, uuidToMode: ReadonlyMap<string, number>): string {
  const extDir = path.join(configRoot, 'Ext');
  fs.mkdirSync(extDir, { recursive: true });
  const rows = [...uuidToMode.entries()]
    .map(([uuid, mode]) => `${uuid},${uuid},${String(mode)}`)
    .join(',');
  const binPath = path.join(extDir, 'ParentConfigurations.bin');
  fs.writeFileSync(binPath, `{6,0,1,${rows}}`, 'latin1');
  return binPath;
}
