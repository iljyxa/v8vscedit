import {
  escapeXmlText,
  findChildElementRangeInBlock,
  findDirectElementRanges,
  findNestingAwareElementRange,
} from './XmlUtils';

/**
 * Регистрирует дочерний элемент (реквизит, форму, макет, команду, …) в ГЛАВНОМ блоке
 * `<ChildObjects>` XML-объекта метаданных — то есть в прямом `<ChildObjects>` корневого элемента
 * (`<Catalog>`, `<Document>`, …), а не во вложенном `<ChildObjects>` табличной части.
 *
 * Прежняя логика в `CfeBorrowService` искала ПЕРВОЕ по всему файлу вхождение
 * `<ChildObjects/>`/`</ChildObjects>` без учёта вложенности: как только в объекте появлялась
 * заимствованная табличная часть со своим `<ChildObjects>`, следующая регистрация попадала внутрь
 * ТЧ вместо главного блока объекта (issue #25).
 *
 * Модуль чистый (строка на входе — строка на выходе): чтение/запись файла и сохранение BOM/EOL
 * остаются у вызывающего. Результат собирается только через `slice`/конкатенацию: `childXml`
 * несёт синонимы и комментарии из исходного XML, и `String.replace` исказил бы в нём
 * последовательности `$&`, `` $` ``, `$'`.
 */

/**
 * Отступ записи в главном `<ChildObjects>`. Глубина блока задана схемой
 * (MetaDataObject → вид объекта → ChildObjects), поэтому константа, а не вычисление.
 */
export const MAIN_CHILD_OBJECTS_ENTRY_INDENT = '\t\t\t';

/**
 * Возвращает изменённый XML объекта с зарегистрированным дочерним элементом в ГЛАВНОМ
 * `<ChildObjects>`, либо `undefined`, если правка не нужна (элемент уже зарегистрирован) или
 * невозможна (в файле нет блока `<ChildObjects>`).
 *
 * `childXml` — готовый полный блок элемента с собственным отступом; без него регистрируется
 * текстовая ссылка `<Tag>Имя</Tag>`.
 */
export function registerChildInMainChildObjects(
  xml: string,
  childTag: string,
  childName: string,
  childXml?: string
): string | undefined {
  // Первый `<ChildObjects>` с учётом вложенности — это блок корневого объекта: блоки ТЧ лежат внутри него.
  const main = findNestingAwareElementRange(xml, 'ChildObjects');
  if (!main) {
    return undefined;
  }

  const textRef = `<${childTag}>${escapeXmlText(childName)}</${childTag}>`;
  const entry = childXml ?? `${MAIN_CHILD_OBJECTS_ENTRY_INDENT}${textRef}`;

  if (main.closeStart === main.openEnd) {
    return `${xml.slice(0, main.start)}<ChildObjects>\n${entry}\n\t\t</ChildObjects>${xml.slice(main.end)}`;
  }

  const block = xml.slice(main.openEnd, main.closeStart);
  if (findChildElementRangeInBlock(block, childTag, childName)) {
    return undefined;
  }

  // Текстовая ссылка засчитывается только как прямой ребёнок главного блока: такая же ссылка
  // внутри ТЧ относится к ТЧ и не означает регистрацию на уровне объекта.
  const ref = findDirectElementRanges(block, childTag)
    .find((range) => block.slice(range.start, range.end) === textRef);
  if (ref) {
    if (!childXml) {
      return undefined;
    }
    // Пробельный хвост перед ссылкой поглощается, а блок начинается с новой строки — те же байты,
    // что давала прежняя замена `\s*<Tag>Имя</Tag>` → `\n${childXml}` (совместимость с #23).
    let from = main.openEnd + ref.start;
    while (from > main.openEnd && /\s/.test(xml[from - 1])) {
      from--;
    }
    return `${xml.slice(0, from)}\n${childXml}${xml.slice(main.openEnd + ref.end)}`;
  }

  // Запись несёт собственный отступ, поэтому отступ закрывающего тега переносится на новую строку
  // после неё, а не остаётся перед записью.
  let insertAt = main.closeStart;
  while (insertAt > main.openEnd && (xml[insertAt - 1] === ' ' || xml[insertAt - 1] === '\t')) {
    insertAt--;
  }
  return `${xml.slice(0, insertAt)}${entry}\n${xml.slice(insertAt)}`;
}

/**
 * Гарантирует наличие главного `<ChildObjects>` в XML объекта: если блока нет, вставляет пустой
 * `<ChildObjects/>` сразу после `</Properties>` корневого элемента — там, где его располагает
 * платформа. Возвращает исходную строку, если блок уже есть, и `undefined`, если вставить некуда
 * (в XML нет `<Properties>`).
 *
 * Нужна для оболочек обработок/отчётов/журналов, заимствованных до issue #28: они создавались без
 * `<ChildObjects/>`, и регистрация формы/макета в них молча не выполнялась.
 */
export function ensureMainChildObjects(xml: string): string | undefined {
  if (findNestingAwareElementRange(xml, 'ChildObjects')) {
    return xml;
  }
  // Без `<ChildObjects>` первый `<Properties>` — блок корневого элемента: свойства дочерних
  // элементов лежат только внутри `<ChildObjects>`.
  const properties = findNestingAwareElementRange(xml, 'Properties');
  if (!properties) {
    return undefined;
  }
  return `${xml.slice(0, properties.end)}\n\t\t<ChildObjects/>${xml.slice(properties.end)}`;
}
