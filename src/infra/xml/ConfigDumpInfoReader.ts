import * as fs from 'fs';

/** Запись `ConfigDumpInfo.xml` с версией объекта/модуля. */
export interface ConfigDumpInfoEntry {
  name: string;
  id: string;
  configVersion: string;
}

/**
 * Разбор ведётся по отдельным тегам `<Metadata …>`, а не по дереву: формат бывает
 * иерархическим (вложенные ссылки на реквизиты внутри объекта), но значимы только
 * записи с `configVersion` — именно по ним сравниваются версии владельцев при
 * инкрементальной выгрузке корня. Вложенность при этом не важна.
 */
const METADATA_TAG_RE = /<Metadata\b([^>]*?)\/?>/g;
const ATTRIBUTE_RE = /\b(name|id|configVersion)="([^"]*)"/g;

/** Все записи с `configVersion` в порядке следования в файле. */
export function parseConfigDumpInfoEntries(xmlText: string): ConfigDumpInfoEntry[] {
  const text = xmlText.charCodeAt(0) === 0xfeff ? xmlText.slice(1) : xmlText;
  const entries: ConfigDumpInfoEntry[] = [];
  for (const match of text.matchAll(METADATA_TAG_RE)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[1].matchAll(ATTRIBUTE_RE)) {
      attributes.set(attribute[1], attribute[2]);
    }
    const name = attributes.get('name');
    const configVersion = attributes.get('configVersion');
    if (!name || !configVersion) {
      continue;
    }
    entries.push({ name, id: attributes.get('id') ?? '', configVersion });
  }
  return entries;
}

/** Карта `name → configVersion` для записей с версией; нераспознанный текст — пустая карта. */
export function parseConfigDumpInfo(xmlText: string): ReadonlyMap<string, string> {
  return new Map(parseConfigDumpInfoEntries(xmlText).map((entry) => [entry.name, entry.configVersion]));
}

/**
 * Читает `ConfigDumpInfo.xml` с диска. `null` означает «сравнивать не с чем» (файла нет
 * или он не читается) — вызывающая сторона в этом случае выбирает полную выгрузку,
 * а не считает, что изменений нет.
 */
export function readConfigDumpInfoFile(filePath: string): ReadonlyMap<string, string> | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  return parseConfigDumpInfo(text);
}
