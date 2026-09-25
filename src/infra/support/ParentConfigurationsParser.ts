/**
 * Разбор текста `Ext/ParentConfigurations.bin` — списка объектов конфигурации,
 * стоящих на поддержке поставщика. Формат снят с платформы 8.5.1 (см. шапку
 * `example/tools/build-supported-cf.mjs`):
 *
 *   {6,<изменения запрещены 1|0>,<число поставщиков>,<uuid>,<копия совпадает 1|0>,<uuid>,
 *    "<версия>","<поставщик>","<имя>",<число записей>, a,b,uuid,uuid, …, <хвост>}
 *
 * Парсер отдаёт сырые коды записей (`a`) и не знает их смысла: трактовка кода в
 * режим поддержки — ответственность `SupportInfoService`, чтобы таблица
 * соответствия жила в одном месте.
 */

export interface ParentConfigurationsRecord {
  /** Код режима поддержки из файла (первое число четвёрки `a,b,uuid,uuid`). */
  readonly code: number;
  /** uuid объекта в нижнем регистре. */
  readonly uuid: string;
}

export interface ParentConfigurationsInfo {
  readonly changesForbidden: boolean;
  readonly vendorCount: number;
  /** Число записей, объявленное в заголовке; может расходиться с `records.length`. */
  readonly declaredRecordCount: number;
  readonly records: readonly ParentConfigurationsRecord[];
}

export type ParentConfigurationsParseResult =
  | { readonly ok: true; readonly info: ParentConfigurationsInfo }
  | { readonly ok: false; readonly reason: string };

const SUPPORTED_FORMAT_VERSION = 6;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Строка в кавычках с CSV-экранированием `""` — запятая внутри неё не разделитель. */
const QUOTED = '"(?:[^"]|"")*"';
const SEP = '\\s*,\\s*';

const HEADER_RE = new RegExp(
  '^\\s*\\{\\s*(\\d+)' + SEP + '(\\d+)' + SEP + '(\\d+)' + SEP + `(${UUID})` + SEP + '(\\d+)' + SEP +
    `(${UUID})` + SEP + QUOTED + SEP + QUOTED + SEP + QUOTED + SEP + '(\\d+)\\s*,',
  'i'
);

/**
 * Запись — четвёрка `a,b,uuid,uuid` с ОДИНАКОВЫМИ uuid. Требование равенства
 * отсекает случайные пары чисел и uuid из хвоста и служебных полей. Счётчиком
 * заголовка тело не нарезается: раскладка для нескольких поставщиков не сверена
 * с эталоном платформы, а поиск по форме записи от неё не зависит.
 */
const RECORD_SOURCE = `(?:^|,)\\s*(\\d+)${SEP}(\\d+)${SEP}(${UUID})${SEP}\\3(?=\\s*[,}])`;

export function parseParentConfigurations(text: string): ParentConfigurationsParseResult {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const header = HEADER_RE.exec(content);
  if (!header) {
    return { ok: false, reason: 'заголовок не распознан' };
  }

  const version = parseInt(header[1], 10);
  if (version !== SUPPORTED_FORMAT_VERSION) {
    return { ok: false, reason: `неподдерживаемая версия формата ${String(version)}` };
  }

  const flag = parseInt(header[2], 10);
  if (flag !== 0 && flag !== 1) {
    return { ok: false, reason: 'неизвестное значение флага запрета изменений' };
  }

  const body = content.slice(header[0].length);
  const recordRe = new RegExp(RECORD_SOURCE, 'gi');
  const records: ParentConfigurationsRecord[] = [];
  let m: RegExpExecArray | null;
  while ((m = recordRe.exec(body)) !== null) {
    records.push({ code: parseInt(m[1], 10), uuid: m[3].toLowerCase() });
  }

  return {
    ok: true,
    info: {
      changesForbidden: flag === 1,
      vendorCount: parseInt(header[3], 10),
      declaredRecordCount: parseInt(header[7], 10),
      records,
    },
  };
}
