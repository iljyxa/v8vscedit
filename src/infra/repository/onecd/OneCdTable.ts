import { parseBracketText, type BracketNode } from '../OneCBracketText';
import { OneCdFormatError, type OneCdFile } from './OneCdFile';

/**
 * Таблицы файла 1CD: описание (скобочный текст из корневого объекта), размер записи и
 * декодирование значений. Запись: 1 байт флага удаления, затем поля; у поля с NULL
 * перед значением байт-признак (0 — NULL). Запись 0 служебная.
 */

export type OneCdFieldType = 'B' | 'L' | 'N' | 'NC' | 'NVC' | 'NT' | 'I' | 'DT' | 'RV';

export interface OneCdField {
  readonly name: string;
  readonly type: OneCdFieldType;
  readonly nullable: boolean;
  readonly length: number;
  readonly precision: number;
}

export interface OneCdTableDescription {
  readonly name: string;
  readonly fields: readonly OneCdField[];
  readonly recordLock: boolean;
  readonly dataPage: number;
  readonly blobPage: number;
  readonly indexPage: number;
}

export type OneCdValue = Buffer | string | number | boolean | null | { readonly blobIndex: number; readonly blobLength: number };
export type OneCdRecord = Readonly<Record<string, OneCdValue>>;

/** Размер значения поля в байтах (без байта-признака NULL). */
const FIELD_SIZES: Readonly<Record<OneCdFieldType, (field: Pick<OneCdField, 'length'>) => number>> = {
  B: (field) => field.length,
  L: () => 1,
  N: (field) => Math.floor((field.length + 2) / 2),
  NC: (field) => 2 * field.length,
  NVC: (field) => 2 + 2 * field.length,
  NT: () => 8,
  I: () => 8,
  DT: () => 7,
  RV: () => 16,
};

const MIN_RECORD_SIZE = 5;

export function parseTableDescription(text: string): OneCdTableDescription {
  let nodes: BracketNode[];
  try {
    nodes = parseBracketText(text);
  } catch (error) {
    // Токенизатор бросает только Error с описанием места разбора.
    throw corrupted((error as Error).message);
  }
  const table = nodes[0];
  if (!Array.isArray(table) || typeof table[0] !== 'string') {
    throw corrupted('описание таблицы без имени');
  }
  const section = (name: string): BracketNode[] | undefined =>
    table.find((node): node is BracketNode[] => Array.isArray(node) && node[0] === name);
  const fields = section('Fields');
  const files = section('Files');
  if (!fields || !files) {
    throw corrupted(`в описании таблицы ${table[0]} нет Fields/Files`);
  }
  return {
    name: table[0],
    fields: fields.slice(1).map(parseField),
    recordLock: section('Recordlock')?.[1] !== '0',
    dataPage: toCount(files[1]),
    blobPage: toCount(files[2]),
    indexPage: toCount(files[3]),
  };
}

export function computeRecordSize(fields: readonly OneCdField[]): number {
  const size = fields.reduce((sum, field) => sum + FIELD_SIZES[field.type](field) + Number(field.nullable), 1);
  return Math.max(MIN_RECORD_SIZE, size);
}

export function decodeRecords(description: OneCdTableDescription, data: Buffer): OneCdRecord[] {
  /* c8 ignore start -- Recordlock=1 добавляет в запись служебное поле версии; во всех таблицах
     файлов хранилища 8.3.27 и 8.5.1 он равен 0 (инвентаризация генератора фикстуры), разбирать
     такую запись без реального образца нельзя */
  if (description.recordLock) {
    throw new OneCdFormatError('unsupported-version', `Таблица ${description.name} с блокировкой записей не поддерживается.`);
  }
  /* c8 ignore stop */
  const recordSize = computeRecordSize(description.fields);
  if (data.length % recordSize !== 0) {
    throw corrupted(`данные таблицы ${description.name} не кратны размеру записи ${String(recordSize)}`);
  }
  const records: OneCdRecord[] = [];
  for (let offset = recordSize; offset < data.length; offset += recordSize) {
    if (data[offset] !== 0) {
      continue;
    }
    const record: Record<string, OneCdValue> = {};
    let position = offset + 1;
    for (const field of description.fields) {
      const isNull = field.nullable && data[position] === 0;
      position += Number(field.nullable);
      const size = FIELD_SIZES[field.type](field);
      record[field.name] = isNull ? null : decodeValue(field, data.subarray(position, position + size));
      position += size;
    }
    records.push(record);
  }
  return records;
}

/** GUID в байтовом порядке `bytes_le` (первые три группы — little-endian), как его хранит 1CD. */
export function formatGuidBytesLe(bytes: Buffer): string {
  const le = (start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).reverse().toString('hex');
  const hex = bytes.toString('hex');
  return `${le(0, 4)}-${le(4, 6)}-${le(6, 8)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** BCD `yyyyMMddhhmmss` → `YYYY-MM-DDTHH:mm:ss` (локальное время, без зоны); пустая дата — `undefined`. */
export function decodeBcdDateTime(bytes: Buffer): string | undefined {
  const digits = bytes.toString('hex');
  if (!/^\d{14}$/.test(digits) || digits.startsWith('0000')) {
    return undefined;
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
}

export async function readOneCdTable(file: OneCdFile, tableName: string): Promise<OneCdRecord[]> {
  const description = (await file.readTableDescriptions())
    .map(parseTableDescription)
    .find((candidate) => candidate.name === tableName);
  if (!description) {
    throw corrupted(`нет таблицы ${tableName}`);
  }
  return decodeRecords(description, await file.readObject(description.dataPage));
}

function decodeValue(field: OneCdField, value: Buffer): OneCdValue {
  switch (field.type) {
    case 'L':
      return value[0] !== 0;
    case 'N':
      return decodeBcdNumber(value, field);
    case 'NC':
      return value.toString('utf16le').trimEnd();
    case 'NVC':
      return value.subarray(2, 2 + 2 * value.readUInt16LE(0)).toString('utf16le');
    case 'NT':
    case 'I':
      return { blobIndex: value.readUInt32LE(0), blobLength: value.readUInt32LE(4) };
    case 'DT':
      return decodeBcdDateTime(value) ?? null;
    default:
      // B и RV — двоичные значения фиксированной длины.
      return Buffer.from(value);
  }
}

/** BCD-число: первый полубайт — знак (1 — «+», 0 — «−»), далее `length` цифр, из них `precision` дробных. */
function decodeBcdNumber(value: Buffer, field: OneCdField): number {
  const digits = value.toString('hex');
  const sign = Number(digits[0]) * 2 - 1;
  return (sign * Number(digits.slice(1, 1 + field.length))) / 10 ** field.precision;
}

function parseField(node: BracketNode): OneCdField {
  if (!Array.isArray(node) || node.length < 5 || node.slice(0, 5).some((item) => typeof item !== 'string')) {
    throw corrupted(`описание поля ${JSON.stringify(node)}`);
  }
  const [name, type, nullable, length, precision] = node as string[];
  /* c8 ignore start -- набор типов полей хранилища 8.3.27/8.5.1 закрыт (инвентаризация
     генератора фикстуры); незнакомый тип — формат будущей версии, размер записи не вычислить */
  if (!Object.prototype.hasOwnProperty.call(FIELD_SIZES, type)) {
    throw new OneCdFormatError('unsupported-version', `Тип поля ${type} в файле хранилища не поддерживается.`);
  }
  /* c8 ignore stop */
  return { name, type: type as OneCdFieldType, nullable: nullable === '1', length: toCount(length), precision: toCount(precision) };
}

function toCount(value: BracketNode | undefined): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw corrupted(`ожидалось целое число, получено ${JSON.stringify(value)}`);
  }
  return count;
}

function corrupted(detail: string): OneCdFormatError {
  return new OneCdFormatError('corrupted', `Файл хранилища повреждён или изменяется платформой (${detail}) — повторите обновление.`);
}
