import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fixtureUuid, writeObjectXml } from './flatMetadataFixtures';

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

export interface SupportFixtureRoot {
  /** Временный каталог-контейнер (удаляется целиком в dispose). */
  readonly tempDir: string;
  readonly configRoot: string;
  readonly configurationXmlPath: string;
  /** Реальный Catalog «Контрагенты» — код `a=2` (снят с поддержки, `support-rules.json`). */
  readonly kontragentyXmlPath: string;
  /**
   * Реальный Catalog «АвансовыйОтчетПрисоединенныеФайлы» — не перечислен в
   * `support-rules*.json`, поэтому берёт `default` правил (код `a=0`, не
   * редактируется).
   */
  readonly avansovyOtchetXmlPath: string;
  /** Реальный Document «ПриходТовара» — код `a=1` (редактируется с сохранением поддержки). */
  readonly prihodTovaraXmlPath: string;
  /**
   * Синтетический справочник вне поставки (issue #21): его uuid заведомо
   * отсутствует в `ParentConfigurations.bin`. Реального такого объекта в
   * `example/` нет ПО ПОСТРОЕНИЮ — `example/tools/build-supported-cf.mjs`
   * формирует список поддержки из объектов ТЕКУЩЕЙ конфигурации, поэтому
   * каждый реальный объект выгрузки неизбежно в нём числится. XML
   * синтезирован через `writeObjectXml` — тот же приём, что и в
   * `supportInfoService.test.ts` для теста «uuid не в списке поставки».
   */
  readonly unlistedCatalogXmlPath: string;
  dispose(): void;
}

/**
 * Временный корень конфигурации, собранный из реальных XML `example/2.21/src/cf`
 * (Configuration.xml + три объекта трёх разных кодов `.bin`) и реального
 * `Ext/ParentConfigurations.bin` — обычного (`normal`, `example/tools/support-rules.json`)
 * или с флагом «изменения запрещены» в заголовке (`forbidden`,
 * `example/support/changes-forbidden`, см. `support-rules-forbidden.json`).
 * Используется тестами, которым нужен полноценный корень с несколькими
 * объектами разных кодов режима, а не единичный XML.
 */
export function buildSupportFixtureRoot(variant: 'normal' | 'forbidden'): SupportFixtureRoot {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-support-fixture-'));
  const configRoot = path.join(tempDir, 'cf');
  const source = EXAMPLE_CF_ROOTS['2.21'];

  fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
  fs.mkdirSync(path.join(configRoot, 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(configRoot, 'Ext'), { recursive: true });

  const configurationXmlPath = path.join(configRoot, 'Configuration.xml');
  fs.copyFileSync(path.join(source, 'Configuration.xml'), configurationXmlPath);

  const kontragentyXmlPath = path.join(configRoot, 'Catalogs', 'Контрагенты.xml');
  fs.copyFileSync(path.join(source, 'Catalogs', 'Контрагенты.xml'), kontragentyXmlPath);

  const avansovyOtchetXmlPath = path.join(configRoot, 'Catalogs', 'АвансовыйОтчетПрисоединенныеФайлы.xml');
  fs.copyFileSync(
    path.join(source, 'Catalogs', 'АвансовыйОтчетПрисоединенныеФайлы.xml'),
    avansovyOtchetXmlPath
  );

  const prihodTovaraXmlPath = path.join(configRoot, 'Documents', 'ПриходТовара.xml');
  fs.copyFileSync(path.join(source, 'Documents', 'ПриходТовара.xml'), prihodTovaraXmlPath);

  const binSource = variant === 'forbidden'
    ? CHANGES_FORBIDDEN_BIN_PATH
    : path.join(source, 'Ext', 'ParentConfigurations.bin');
  fs.copyFileSync(binSource, path.join(configRoot, 'Ext', 'ParentConfigurations.bin'));

  const unlistedCatalogXmlPath = writeObjectXml(
    configRoot,
    'Catalogs',
    'СобственныйСправочник',
    'Catalog',
    fixtureUuid(`unlisted-catalog-${variant}`),
    'flat'
  );

  return {
    tempDir,
    configRoot,
    configurationXmlPath,
    kontragentyXmlPath,
    avansovyOtchetXmlPath,
    prihodTovaraXmlPath,
    unlistedCatalogXmlPath,
    dispose(): void {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
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
