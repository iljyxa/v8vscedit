import * as fs from 'fs';
import * as path from 'path';

/**
 * Пути к реальным выгрузкам платформы 1С в `example/`, используемым как эталон
 * при тестировании разбора `Ext/ParentConfigurations.bin`. Обе выгрузки собраны
 * одним и тем же скриптом (`example/tools/build-supported-cf.mjs`) из одной и той
 * же поставки — набор объектов на поддержке и коды режимов совпадают, см.
 * `example/tools/support-rules.json`.
 */
export const EXAMPLE_CF_ROOTS: Readonly<Record<'2.20' | '2.21', string>> = {
  '2.20': path.resolve(__dirname, '../../../../example/2.20/src/cf'),
  '2.21': path.resolve(__dirname, '../../../../example/2.21/src/cf'),
};

/**
 * Реальный `ParentConfigurations.bin` конфигурации с флагом «изменения
 * запрещены» (заголовок `{6,1,…}`) — собран тем же скриптом из поставки
 * example/2.21 с правилами `support-rules-forbidden.json`, см. шапку
 * `example/tools/build-supported-cf.mjs`.
 */
export const CHANGES_FORBIDDEN_BIN_PATH = path.resolve(
  __dirname,
  '../../../../example/support/changes-forbidden/ParentConfigurations.bin'
);

const ROOT_UUID_RE = /uuid="([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;

/**
 * Читает собственный uuid объекта метаданных из начала его XML: первое
 * вхождение атрибута `uuid="…"` в файле принадлежит корневому элементу объекта
 * (тот же приём, что `SupportInfoService` использует для получения uuid
 * владельца). Используется вместо хардкода uuid из `example/` в тексте тестов.
 */
export function readRootUuid(xmlPath: string): string {
  const head = fs.readFileSync(xmlPath, 'utf-8').slice(0, 4096);
  const m = ROOT_UUID_RE.exec(head);
  if (!m) {
    throw new Error(`uuid не найден в начале файла: ${xmlPath}`);
  }
  return m[1].toLowerCase();
}

const ATTRIBUTE_UUID_RE =
  /<Attribute uuid="([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;

/** Читает uuid первого дочернего `<Attribute>` объекта (для проверки getSupportModeByUuid не по владельцу). */
export function firstAttributeUuid(xmlPath: string): string {
  const content = fs.readFileSync(xmlPath, 'utf-8');
  const m = ATTRIBUTE_UUID_RE.exec(content);
  if (!m) {
    throw new Error(`<Attribute uuid="…"> не найден в файле: ${xmlPath}`);
  }
  return m[1].toLowerCase();
}

export interface MalformedBinCase {
  readonly label: string;
  readonly text: string;
  readonly reason: string;
}

const realBinText = fs.readFileSync(
  path.join(EXAMPLE_CF_ROOTS['2.21'], 'Ext', 'ParentConfigurations.bin'),
  'utf-8'
);

/**
 * Пять способов получить нераспознанный `ParentConfigurations.bin`, разделяемые
 * между тестами парсера (`parentConfigurationsParser.test.ts`) и интеграционными
 * тестами `SupportInfoService` — там и там ожидается один и тот же `reason`.
 */
export const MALFORMED_BIN_CASES: readonly MalformedBinCase[] = [
  { label: 'пустая строка', text: '', reason: 'заголовок не распознан' },
  { label: 'произвольный мусор', text: 'мусор', reason: 'заголовок не распознан' },
  { label: 'обрезанный заголовок', text: '{6,0,1,', reason: 'заголовок не распознан' },
  {
    label: 'неподдерживаемая версия формата (7 вместо 6)',
    text: realBinText.replace('{6,0,1,', '{7,0,1,'),
    reason: 'неподдерживаемая версия формата 7',
  },
  {
    label: 'неизвестное значение флага запрета изменений (2)',
    text: realBinText.replace('{6,0,1,', '{6,2,1,'),
    reason: 'неизвестное значение флага запрета изменений',
  },
];
