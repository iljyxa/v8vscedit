import * as fs from 'fs';
import { extractMainChildObjectsInnerXml, unescapeXml } from './XmlUtils';

/** Текстовая ссылка на подчинённый объект в `<ChildObjects>` корня: `<Form>Имя</Form>`. */
export interface ChildObjectRef {
  tag: string;
  name: string;
}

const TAG_RE = /<(\/?)([A-Za-z_][\w.-]*)((?:\s[^<>]*)?)\/?>/g;
const METADATA_OBJECT_ROOT_RE = /<MetaDataObject[\s/>]/;

interface OpenElement {
  name: string;
  textStart: number;
  hasAttributes: boolean;
  hasChildren: boolean;
}

/**
 * Узкий ридер ссылок на подчинённые объекты с собственным XML (формы, макеты,
 * перерасчёты, таблицы и т.п.). `ObjectXmlReader.parseChildren` намеренно не
 * расширяется: его вывод потребляет валидатор метаданных, и новые теги дали бы
 * ложные `disallowed-child`/`unexpected-child`.
 *
 * Берутся только прямые дети `<ChildObjects>` корня с чисто текстовым содержимым —
 * структурные элементы (`<Command uuid="…">…</Command>`, реквизиты) отсекаются.
 * `null` — файла нет или в нём нет корня `<MetaDataObject>`.
 */
export function readChildObjectRefs(xmlPath: string, tags: ReadonlySet<string>): ChildObjectRef[] | null {
  let xml: string;
  try {
    xml = fs.readFileSync(xmlPath, 'utf-8');
  } catch {
    return null;
  }
  if (!METADATA_OBJECT_ROOT_RE.test(xml)) {
    return null;
  }
  const inner = extractMainChildObjectsInnerXml(xml);
  return inner === null || tags.size === 0 ? [] : collectTextChildren(inner, tags);
}

function collectTextChildren(inner: string, tags: ReadonlySet<string>): ChildObjectRef[] {
  const result: ChildObjectRef[] = [];
  let depth = 0;
  let open: OpenElement = { name: '', textStart: 0, hasAttributes: false, hasChildren: false };
  for (const match of inner.matchAll(TAG_RE)) {
    const [text, closing, name, attributes] = match;
    if (closing) {
      depth -= 1;
      if (depth === 0 && open.name === name && tags.has(name) && !open.hasAttributes && !open.hasChildren) {
        result.push({ tag: name, name: unescapeXml(inner.slice(open.textStart, match.index).trim()) });
      }
      continue;
    }
    if (depth > 0) {
      open.hasChildren = true;
    }
    if (text.endsWith('/>')) {
      continue;
    }
    if (depth === 0) {
      open = { name, textStart: match.index + text.length, hasAttributes: attributes.trim() !== '', hasChildren: false };
    }
    depth += 1;
  }
  return result;
}
