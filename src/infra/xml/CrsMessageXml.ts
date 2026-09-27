import { XMLParser } from 'fast-xml-parser';
import { RepositoryLockStatusError } from '../repository/RepositoryLockStatusSource';
import { escapeXmlAttribute } from './XmlUtils';

/**
 * Сообщения протокола сервера хранилища (crs), одинаковые для tcp и http: конверт
 * `crs:call` с аутентификацией и ответ `crs:call_return`/`crs:call_exception`. Формат
 * установлен по трафику платформы 8.5.1: тело — UTF-8 с BOM, конверт одной строкой,
 * порядок атрибутов `alias`/`name`/`version` фиксирован (так шлёт Конфигуратор).
 */

export interface CrsCallEnvelope {
  readonly alias: string;
  readonly method: string;
  readonly version: string;
  readonly user: string;
  readonly passwordHash: string;
  readonly paramsXml: string;
}

const CRS_NAMESPACE = 'http://v8.1c.ru/8.2/crs';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export function buildCrsCallBody(envelope: CrsCallEnvelope): Buffer {
  const text = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>'
    + `<crs:call xmlns:crs="${CRS_NAMESPACE}" alias="${escapeXmlAttribute(envelope.alias)}"`
    + ` name="${escapeXmlAttribute(envelope.method)}" version="${escapeXmlAttribute(envelope.version)}">`
    + `<crs:auth user="${escapeXmlAttribute(envelope.user)}" password="${escapeXmlAttribute(envelope.passwordHash)}"/>`
    + `${envelope.paramsXml}</crs:call>`;
  return Buffer.from(text, 'utf-8');
}

/** Параметры `DevDepot_devObjectsStatistic`: пустой objRefs — все объекты; без `crs:bind` (база не нужна). */
export const CRS_OBJECTS_STATISTIC_PARAMS = '<crs:params><crs:objRefs/><crs:removed value="false"/></crs:params>';

export interface CrsObjectStatistic {
  readonly objectId: string;
  readonly revised: boolean;
  /** Держатель захвата; нулевой uuid свободного объекта отбрасывается. */
  readonly revisorId?: string;
  readonly reviseDate?: string;
}

export interface CrsCallReturn {
  readonly statistics: readonly CrsObjectStatistic[];
  /** id пользователя хранилища → имя. */
  readonly users: ReadonlyMap<string, string>;
}

export type CrsResponse =
  | { readonly kind: 'return'; readonly value: CrsCallReturn }
  | { readonly kind: 'exception'; readonly clsid: string; readonly payload: string };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Элементы-записи `crs:value` — всегда списком, даже из одного элемента.
  isArray: (name, _path, _isLeaf, isAttribute) => name === 'value' && !isAttribute,
});

/** Разбор ответа сервера; нераспознанное тело (не crs, оборванное) — ошибка протокола. */
export function parseCrsResponse(body: Buffer): CrsResponse {
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(body.toString('utf-8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch (error) {
    throw protocolError(`ответ не является XML (${(error as Error).message})`);
  }
  const result = parsed.call_return;
  if (isRecord(result)) {
    return { kind: 'return', value: readCallReturn(result) };
  }
  const exception = parsed.call_exception;
  const clsid = text(exception, '@_clsid');
  const payload = text(exception, '#text');
  if (clsid === undefined || payload === undefined) {
    throw protocolError('ответ не содержит crs:call_return или crs:call_exception');
  }
  return { kind: 'exception', clsid, payload };
}

function readCallReturn(result: Record<string, unknown>): CrsCallReturn {
  const statistics = values(result.statMap).flatMap((item): CrsObjectStatistic[] => {
    const objectId = valueOf(field(item, 'first'));
    const second = field(item, 'second');
    const revisorId = valueOf(field(second, 'revisorID'));
    return objectId === undefined ? [] : [{
      objectId,
      revised: valueOf(field(second, 'revised')) === 'true',
      revisorId: revisorId === ZERO_UUID ? undefined : revisorId,
      reviseDate: valueOf(field(second, 'reviseDate')),
    }];
  });
  const users = values(result.users)
    .map((item): [string | undefined, string | undefined] =>
      [valueOf(field(item, 'first')), valueOf(field(field(field(item, 'second'), 'info'), 'name'))])
    .filter((entry): entry is [string, string] => entry[0] !== undefined && entry[1] !== undefined);
  return { statistics, users: new Map(users) };
}

/** Дочерний элемент/атрибут разобранного узла; у пустого элемента (`''`) полей нет. */
function field(node: unknown, name: string): unknown {
  return isRecord(node) ? node[name] : undefined;
}

function text(node: unknown, name: string): string | undefined {
  const value = field(node, name);
  return typeof value === 'string' ? value : undefined;
}

/** Значение атрибута `value` — так crs кодирует все скаляры. */
function valueOf(node: unknown): string | undefined {
  return text(node, '@_value');
}

function values(node: unknown): unknown[] {
  const list = field(node, 'value');
  return Array.isArray(list) ? list : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolError(detail: string): RepositoryLockStatusError {
  return new RepositoryLockStatusError('protocol', `Некорректный ответ сервера хранилища: ${detail}.`);
}
