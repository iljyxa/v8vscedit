/**
 * Построчное сохранение BOM и переводов строк (EOL) при перезаписи существующего текста.
 *
 * Платформа 1С пишет выгрузку со СМЕШАННЫМ EOL: файл в CRLF, а текст запроса внутри
 * `<query>` макета СКД — на голых LF. Мутаторы же собирают новый текст через `\n`,
 * поэтому приведение всего файла к одному стилю даёт лишний дифф в строках, которых
 * правка не касалась. Здесь новый текст сопоставляется со старым построчно (по тексту
 * без EOL), и неизменённые строки получают свой исходный EOL байт-в-байт; EOL новых
 * строк выводится из окружения (см. {@link fillEol}).
 *
 * Модуль чистый (без fs/path/vscode): запись на диск — `XmlUtils.writeTextFilePreservingBomAndEol`.
 */

/**
 * Порог редакционного расстояния построчного Myers-диффа: при превышении
 * весь несовпадающий средний участок сворачивается в один ханк вместо
 * точного O(D²)-вычисления трассы — защита от квадратичного взрыва
 * времени/памяти на больших файлах с массированными правками.
 */
export const MAX_LINE_DIFF_EDIT_DISTANCE = 1000;

const BOM = '\ufeff';

interface Line {
  readonly text: string;
  /** '\r\n' | '\n' | '\r' | '' (только у последней строки без завершающего перевода). */
  readonly eol: string;
}

/**
 * Возвращает `next`, в котором EOL неизменённых строк взяты из `original`, а BOM
 * присутствует ровно один раз, если он был хотя бы в одном из аргументов.
 * Одиночный `\r` считается разделителем строк (как в `hasRealChange`), поэтому для
 * любых `o`, `n`, отличающихся только EOL и, возможно, отсутствием BOM в `n`, результат
 * равен `o` байт-в-байт (BOM в `n`, которого не было в `o`, появится в результате).
 * Наличие завершающего EOL определяет `next`.
 */
export function preserveBomAndEol(original: string, next: string): string {
  if (next === original) {
    return original;
  }
  const hasBom = original.startsWith(BOM) || next.startsWith(BOM);
  const orig = splitLines(stripBom(original));
  const upd = splitLines(stripBom(next));
  const dominant = dominantEol(orig);

  const out: string[] = hasBom ? [BOM] : [];
  const emitHunk = (a: number, k: number, b: number, m: number): void => {
    if (m === 0) {
      return;
    }
    const fill = fillEol(orig, a, k, dominant);
    for (let t = 0; t < m; t++) {
      const line = upd[b + t];
      let eol = '';
      if (line.eol !== '') {
        // Замещённая строка той же позиции (или последняя замещённая) — ближайший
        // аналог новой строки: её EOL переносится, чтобы граница ханка с соседним
        // неизменённым текстом не сдвигалась. EOL наследуется буквально, включая одиночный
        // `\r`, а стиль заполнения `\r` не бывает.
        const inherited = k === m ? orig[a + t].eol : t === m - 1 && k > 0 ? orig[a + k - 1].eol : '';
        eol = inherited || fill;
      }
      out.push(line.text, eol);
    }
  };

  let i = 0;
  let j = 0;
  for (const [mi, mj] of matchLines(orig, upd)) {
    emitHunk(i, mi - i, j, mj - j);
    const line = upd[mj];
    // Бывшая последняя строка без EOL, которая в next уже не последняя, — EOL ей
    // выбирается как новой строке, вставленной на её место.
    out.push(line.text, line.eol === '' ? '' : orig[mi].eol || fillEol(orig, mi, 0, dominant));
    i = mi + 1;
    j = mj + 1;
  }
  emitHunk(i, orig.length - i, j, upd.length - j);
  return out.join('');
}

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** Ручной сканер: split по регулярке потерял бы, каким именно разделителем оканчивалась строка. */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x0a && code !== 0x0d) {
      continue;
    }
    const eol = code === 0x0d && text.charCodeAt(i + 1) === 0x0a ? '\r\n' : text[i];
    lines.push({ text: text.slice(start, i), eol });
    i += eol.length - 1;
    start = i + 1;
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), eol: '' });
  }
  return lines;
}

/** Одиночный `\r` не голосует: стилем заполнения новых строк он быть не может. */
function dominantEol(lines: readonly Line[]): string {
  let crlf = 0;
  let lf = 0;
  for (const line of lines) {
    if (line.eol === '\r\n') {
      crlf++;
    } else if (line.eol === '\n') {
      lf++;
    }
  }
  return crlf >= lf && crlf > 0 ? '\r\n' : '\n';
}

/**
 * Стиль заполнения ханка `orig[a..a+k)`: большинство среди замещённых строк, кроме
 * последней (её EOL уходит последней строке ханка); при ничьей — EOL строки перед
 * ханком, т.к. вставка обычно продолжает окружающий блок (например, текст запроса
 * на LF внутри CRLF-файла); иначе — преобладающий стиль файла. Пустой и одиночный
 * `\r` кандидатами не считаются.
 */
function fillEol(orig: readonly Line[], a: number, k: number, dominant: string): string {
  let balance = 0;
  for (let t = a; t < a + k - 1; t++) {
    if (orig[t].eol === '\r\n') {
      balance++;
    } else if (orig[t].eol === '\n') {
      balance--;
    }
  }
  if (balance !== 0) {
    return balance > 0 ? '\r\n' : '\n';
  }
  const before = a > 0 ? orig[a - 1].eol : '';
  return before === '\r\n' || before === '\n' ? before : dominant;
}

/**
 * Пары совпавших строк `[индекс в orig, индекс в upd]` по возрастанию: общий префикс,
 * средний участок по Myers и общий суффикс. Префикс/суффикс снимаются за O(n), чтобы
 * типичная точечная правка большого файла не доходила до диффа вовсе.
 */
function matchLines(orig: readonly Line[], upd: readonly Line[]): [number, number][] {
  let pre = 0;
  while (pre < orig.length && pre < upd.length && orig[pre].text === upd[pre].text) {
    pre++;
  }
  let suf = 0;
  while (
    suf < orig.length - pre
    && suf < upd.length - pre
    && orig[orig.length - 1 - suf].text === upd[upd.length - 1 - suf].text
  ) {
    suf++;
  }

  const ids = new Map<string, number>();
  const intern = (line: Line): number => {
    let id = ids.get(line.text);
    if (id === undefined) {
      id = ids.size;
      ids.set(line.text, id);
    }
    return id;
  };
  const middleOrig = orig.slice(pre, orig.length - suf).map(intern);
  const middleUpd = upd.slice(pre, upd.length - suf).map(intern);
  // Сверх порога средний участок — один ханк: совпадений внутри нет.
  const middle = myersMatches(middleOrig, middleUpd) ?? [];

  const pairs: [number, number][] = [];
  for (let t = 0; t < pre; t++) {
    pairs.push([t, t]);
  }
  for (const [x, y] of middle) {
    pairs.push([pre + x, pre + y]);
  }
  for (let t = suf; t > 0; t--) {
    pairs.push([orig.length - t, upd.length - t]);
  }
  return pairs;
}

/**
 * Классический Myers O((N+M)·D): после каждого шага d сохраняется только срез V
 * по диагоналям [-d, d] — память ≈ D², а не N·M. Возвращает `undefined`, если
 * D > {@link MAX_LINE_DIFF_EDIT_DISTANCE}.
 */
function myersMatches(a: readonly number[], b: readonly number[]): [number, number][] | undefined {
  const n = a.length;
  const m = b.length;
  const offset = MAX_LINE_DIFF_EDIT_DISTANCE + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= MAX_LINE_DIFF_EDIT_DISTANCE; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, n, m, d);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return undefined;
}

/** Обратный проход по трассе: диагональные участки между правками — совпавшие строки. */
function backtrack(trace: readonly Int32Array[], n: number, m: number, distance: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = distance; d >= 0; d--) {
    let prevX = 0;
    let prevY = 0;
    if (d > 0) {
      // trace[d - 1] хранит диагонали [-(d-1), d-1], индекс k лежит по смещению d - 1.
      const prev = trace[d - 1];
      const at = (k: number): number => prev[k + d - 1];
      const k = x - y;
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      prevX = at(prevK);
      prevY = prevX - prevK;
    }
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  return pairs.reverse();
}
