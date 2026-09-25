import { escapeRegExp, findChildElementsFullXmlInBlock, findNestingAwareElementRange } from './XmlUtils';

/**
 * Сборка XML заимствованного дочернего элемента (реквизит, ТЧ с колонками, измерение, ресурс,
 * значение перечисления, команда) из его XML в исходной конфигурации.
 *
 * Модуль чистый (строка на входе — строка на выходе), генерация UUID внедряется вызывающим.
 * Все подстановки — срезами по индексам или функцией-заменителем: исходный XML несёт синонимы,
 * комментарии и подсказки пользователя, и строка-шаблон `String.replace` превратила бы в них
 * `$&`, `` $` ``, `$'`, `$$` в фрагменты совпадения (issue #27).
 */

/**
 * Возвращает XML заимствованного элемента с отступом `baseIndent`: новый UUID элемента,
 * `<InternalInfo/>` при отсутствии, `<ObjectBelonging>Adopted</ObjectBelonging>` и
 * `<ExtendedConfigurationObject>` со ссылкой на исходный UUID. Колонки ТЧ заимствуются так же.
 */
export function buildBorrowedChildXml(
  sourceChildXml: string,
  childTag: string,
  baseIndent: string,
  newGuid: () => string
): string {
  const xml = normalizeIndent(sourceChildXml.replace(/^\uFEFF/, ''), baseIndent);
  const openTag = new RegExp(`<${escapeRegExp(childTag)}\\b[^>]*>`).exec(xml);
  if (!openTag) {
    throw new Error(`Не найден открывающий тег дочернего объекта: ${childTag}`);
  }
  // UUID берётся только из открывающего тега: первый `uuid=` в тексте ТЧ без собственного UUID
  // принадлежал бы колонке, и заимствованная ТЧ сослалась бы на чужой объект.
  const uuidAttr = /\suuid="([^"]+)"/.exec(openTag[0]);
  if (!uuidAttr) {
    throw new Error(`Не удалось извлечь UUID дочернего объекта: ${childTag}`);
  }
  const sourceUuid = uuidAttr[1];

  const openTagEnd = openTag.index + openTag[0].length;
  const afterOpenTag = xml.slice(openTagEnd);
  // Первая строка после нормализации — всегда `${baseIndent}<Tag …>`, поэтому отступ
  // вложенных узлов элемента выводится из baseIndent, а не ищется в тексте.
  const internalInfo = /^\s*<InternalInfo[\s/>]/.test(afterOpenTag) ? '' : `\n${baseIndent}\t<InternalInfo/>`;

  let result =
    xml.slice(0, openTag.index) +
    replaceRange(openTag[0], uuidAttr.index, uuidAttr.index + uuidAttr[0].length, ` uuid="${newGuid()}"`) +
    internalInfo +
    afterOpenTag;
  result = markPropertiesAsBorrowed(result, sourceUuid);

  if (childTag === 'TabularSection') {
    result = borrowTabularSectionColumns(result, baseIndent, newGuid);
  }
  return result;
}

function markPropertiesAsBorrowed(xml: string, sourceUuid: string): string {
  const properties = /<Properties>([\s\S]*?)<\/Properties>/.exec(xml);
  if (!properties) {
    return xml;
  }

  const innerStart = properties.index + '<Properties>'.length;
  const innerEnd = innerStart + properties[1].length;
  const propIndent = detectPropertiesIndent(properties[1]);
  let inner = properties[1]
    .replace(/\s*<ObjectBelonging>[\s\S]*?<\/ObjectBelonging>/, '')
    .replace(/\s*<ExtendedConfigurationObject>[\s\S]*?<\/ExtendedConfigurationObject>/, '');

  const belonging = `\n${propIndent}<ObjectBelonging>Adopted</ObjectBelonging>`;
  const hasName = /<Name>[\s\S]*?<\/Name>/.test(inner);
  inner = hasName ? inner.replace(/\s*<Name>/, (name) => `${belonging}${name}`) : `${belonging}${inner}`;

  const extended = `\n${propIndent}<ExtendedConfigurationObject>${sourceUuid}</ExtendedConfigurationObject>`;
  const commentRe = /<Comment\s*\/>|<Comment>[\s\S]*?<\/Comment>/;
  if (commentRe.test(inner)) {
    inner = inner.replace(commentRe, (comment) => `${comment}${extended}`);
  } else if (hasName) {
    inner = inner.replace(/<Name>[\s\S]*?<\/Name>/, (name) => `${name}${extended}`);
  } else {
    inner = `${inner}${extended}`;
  }

  return replaceRange(xml, innerStart, innerEnd, inner);
}

function borrowTabularSectionColumns(xml: string, baseIndent: string, newGuid: () => string): string {
  const childObjects = findNestingAwareElementRange(xml, 'ChildObjects');
  if (!childObjects) {
    return xml;
  }

  const block = xml.slice(childObjects.openEnd, childObjects.closeStart);
  let nextBlock = '';
  let cursor = 0;
  for (const column of findChildElementsFullXmlInBlock(block, 'Attribute')) {
    nextBlock +=
      block.slice(cursor, column.range.start) +
      buildBorrowedChildXml(column.xml, 'Attribute', `${baseIndent}\t\t`, newGuid);
    cursor = column.range.end;
  }
  nextBlock += block.slice(cursor);

  return replaceRange(xml, childObjects.openEnd, childObjects.closeStart, nextBlock);
}

function normalizeIndent(xml: string, baseIndent: string): string {
  const lines = xml.replace(/\r\n?/g, '\n').split('\n');
  const indents = lines
    .slice(1)
    .filter((line) => line.trim().length > 0)
    // Строка непуста после trim(), значит символ вне [ \t] в ней есть и search() не вернёт -1.
    .map((line) => line.search(/[^ \t]/));
  const removeCount = indents.length > 0 ? Math.min(...indents) : 0;

  return lines
    .map((line, index) => {
      if (line.trim().length === 0) {
        return '';
      }
      const normalized = index === 0 ? line.trimStart() : line.slice(removeCount);
      return `${baseIndent}${normalized}`;
    })
    .join('\n');
}

function detectPropertiesIndent(propsInner: string): string {
  const match = /\n([ \t]*)<[^/!]/.exec(propsInner);
  return match?.[1] ?? '\t\t\t\t';
}

function replaceRange(text: string, start: number, end: number, insert: string): string {
  return `${text.slice(0, start)}${insert}${text.slice(end)}`;
}
