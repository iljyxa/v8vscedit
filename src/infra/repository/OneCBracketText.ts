/**
 * Скобочный формат 1С (`{"текст",1,{…}}`) — внутренний формат платформы: в нём записаны
 * описания таблиц файла 1CD и полезная нагрузка исключений сервера хранилища. Общий
 * токенизатор для обоих, чтобы разбор строк с удвоенными кавычками жил в одном месте.
 */

/** Узел скобочного формата 1С: строка/токен или вложенный список `{…}`. */
export type BracketNode = string | BracketNode[];

/** Снимает BOM; строки в кавычках раскавычиваются (`""` → `"`), прочие токены — как есть. */
export function parseBracketText(text: string): BracketNode[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const root: BracketNode[] = [];
  const stack: BracketNode[][] = [root];
  let token = '';
  const flush = (): void => {
    if (token) {
      stack[stack.length - 1].push(token);
      token = '';
    }
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      const end = findStringEnd(source, index + 1);
      stack[stack.length - 1].push(source.slice(index + 1, end).replace(/""/g, '"'));
      index = end;
    } else if (char === '{') {
      flush();
      const list: BracketNode[] = [];
      stack[stack.length - 1].push(list);
      stack.push(list);
    } else if (char === '}') {
      flush();
      if (stack.length === 1) {
        throw new Error('Ошибка скобочного формата 1С: лишняя закрывающая скобка.');
      }
      stack.pop();
    } else if (char === ',') {
      flush();
    } else if (!/\s/.test(char)) {
      token += char;
    }
  }
  if (stack.length !== 1) {
    throw new Error('Ошибка скобочного формата 1С: не закрыта скобка.');
  }
  flush();
  return root;
}

/** Индекс закрывающей кавычки строки, начинающейся с `start`; `""` внутри — экранированная кавычка. */
function findStringEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '"') {
      if (source[index + 1] !== '"') {
        return index;
      }
      index += 1;
    }
  }
  throw new Error('Ошибка скобочного формата 1С: не закрыта строка.');
}
