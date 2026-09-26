import { CHILD_TAG_CONFIG } from '../../domain/ChildTag';
import { META_TYPES, type MetaKind } from '../../domain/MetaTypes';
import type { RepositoryTarget } from './RepositoryService';

/**
 * Синхронизация с хранилищем работает с тремя «алфавитами» имён одного объекта:
 *  - технический fullName хранилища (`Справочник.Товары`) — `-Objects`/`-listFile`/`Objects.xml`;
 *  - ссылка ChildObjects/Content (`Catalog.Товары`) — английский вид из META_TYPES;
 *  - имя записи ConfigDumpInfo.xml — тот же английский алфавит, что и Content.
 * Модуль — единственное место перевода между ними.
 */

/** Сентинел захвата корня основной конфигурации в state.json (не имя объекта хранилища). */
export const CONFIGURATION_ROOT_LOCK_NAME = '__configuration_root__';
/** Сентинел захвата корня расширения в state.json (не имя объекта хранилища). */
export const EXTENSION_ROOT_LOCK_NAME = '__extension_root__';

/**
 * Внутренние имена типов объектов 1С, используемые для формирования полного имени
 * при захвате/освобождении в хранилище. Это НЕ человекочитаемые метки (label из META_TYPES),
 * а технические идентификаторы платформы 1С (например, «БизнесПроцесс» без дефиса).
 * Таблица параллельна META_TYPES — известный технический долг, перенесена без изменений.
 */
export const ONE_C_TYPE_NAMES: Partial<Record<MetaKind, string>> = {
  Subsystem: 'Подсистема',
  CommonModule: 'ОбщийМодуль',
  SessionParameter: 'ПараметрСеанса',
  CommonAttribute: 'ОбщийРеквизит',
  Role: 'Роль',
  CommonForm: 'ОбщаяФорма',
  CommonCommand: 'ОбщаяКоманда',
  CommandGroup: 'ГруппаКоманд',
  CommonPicture: 'ОбщаяКартинка',
  CommonTemplate: 'ОбщийМакет',
  XDTOPackage: 'XDTOPackage',
  StyleItem: 'ЭлементСтиля',
  DefinedType: 'ОпределяемыйТип',
  FunctionalOption: 'ФункциональнаяОпция',
  FunctionalOptionsParameter: 'ПараметрФункциональныхОпций',
  SettingsStorage: 'ХранилищеНастроек',
  Style: 'Стиль',
  WSReference: 'WSСсылка',
  WebSocketClient: 'WebSocketКлиент',
  IntegrationService: 'СервисИнтеграции',
  Bot: 'Бот',
  Interface: 'Интерфейс',
  PaletteColor: 'ЦветПалитры',
  Language: 'Язык',
  HTTPService: 'HTTPСервис',
  WebService: 'WebСервис',
  Constant: 'Константа',
  Catalog: 'Справочник',
  Document: 'Документ',
  DocumentNumerator: 'НумераторДокументов',
  Enum: 'Перечисление',
  InformationRegister: 'РегистрСведений',
  AccumulationRegister: 'РегистрНакопления',
  AccountingRegister: 'РегистрБухгалтерии',
  CalculationRegister: 'РегистрРасчета',
  Report: 'Отчет',
  DataProcessor: 'Обработка',
  BusinessProcess: 'БизнесПроцесс',
  Task: 'Задача',
  ExchangePlan: 'ПланОбмена',
  ChartOfCharacteristicTypes: 'ПланВидовХарактеристик',
  ChartOfAccounts: 'ПланСчетов',
  ChartOfCalculationTypes: 'ПланВидовРасчета',
  DocumentJournal: 'ЖурналДокументов',
  ScheduledJob: 'РегламентноеЗадание',
  EventSubscription: 'ПодпискаНаСобытие',
  FilterCriterion: 'КритерийОтбора',
  Sequence: 'Последовательность',
  ExternalDataSource: 'ВнешнийИсточникДанных',
};

/** Обратное отображение {@link ONE_C_TYPE_NAMES}: русский префикс fullName → вид метаданных. */
export const ONE_C_TYPE_NAMES_BY_PREFIX: ReadonlyMap<string, MetaKind> = new Map(
  (Object.entries(ONE_C_TYPE_NAMES) as [MetaKind, string][]).map(
    ([kind, typeName]): [string, MetaKind] => [typeName, kind]
  )
);

/**
 * Английский префикс Content/ConfigDumpInfo → вид метаданных. Выводится из самого
 * META_TYPES (а не отдельной таблицей), т.к. английское имя класса — это
 * `englishKind ?? kind` записи реестра.
 */
const KIND_BY_ENGLISH_NAME: ReadonlyMap<string, MetaKind> = new Map(
  Object.values(META_TYPES).map((def): [string, MetaKind] => [def.englishKind ?? def.kind, def.kind])
);

function splitTypeAndName(value: string): [string, string] | null {
  const dotIndex = value.indexOf('.');
  if (dotIndex <= 0 || dotIndex === value.length - 1) {
    return null;
  }
  return [value.slice(0, dotIndex), value.slice(dotIndex + 1)];
}

/** `Справочник.Товары` → `{ kind: 'Catalog', name: 'Товары' }`; нераспознанное — `null`. */
export function parseRepositoryFullName(fullName: string): { kind: MetaKind; name: string } | null {
  const parts = splitTypeAndName(fullName);
  const kind = parts ? ONE_C_TYPE_NAMES_BY_PREFIX.get(parts[0]) : undefined;
  return parts && kind ? { kind, name: parts[1] } : null;
}

/**
 * Подчинённые объекты с собственным XML: у каждого свои захват, строка `-listFile`,
 * запись ConfigDumpInfo и каталог выгрузки. Команды сюда не входят — платформа не
 * сохраняет их в отдельный файл, они выгружаются вместе с владельцем.
 */
export type RepositorySubordinateTag = 'Form' | 'Template' | 'Recalculation' | 'Table' | 'Cube' | 'DimensionTable' | 'Subsystem';

export interface RepositorySubordinateLayout {
  /** Подкаталог владельца в выгрузке. */
  folder: string;
  /** Русское имя вида в fullName хранилища (`Справочник.X.Форма.Y`). */
  oneCName: string;
}

function requireRegistryValue(value: string | undefined, what: string): string {
  /* c8 ignore next 3 -- реестры META_TYPES/ONE_C_TYPE_NAMES задают значение статически; ветка ловит порчу реестра при загрузке модуля */
  if (value === undefined) {
    throw new Error(`RepositoryObjectNames: не задано ${what}`);
  }
  return value;
}

/**
 * Раскладка единиц-подчинённых. Форма, макет и подсистема выводятся из реестров
 * (CHILD_TAG_CONFIG, ONE_C_TYPE_NAMES, META_TYPES); перерасчёт, таблица, куб и
 * таблица измерения — не MetaKind, поэтому заданы литералами (технический долг:
 * при появлении этих видов в навигаторе папки переезжают в META_TYPES).
 */
export const REPOSITORY_SUBORDINATE_LAYOUT: Readonly<Record<RepositorySubordinateTag, RepositorySubordinateLayout>> = {
  Form: { folder: 'Forms', oneCName: CHILD_TAG_CONFIG.Form.pathSegment },
  Template: { folder: 'Templates', oneCName: CHILD_TAG_CONFIG.Template.pathSegment },
  Recalculation: { folder: 'Recalculations', oneCName: 'Перерасчет' },
  Table: { folder: 'Tables', oneCName: 'Таблица' },
  Cube: { folder: 'Cubes', oneCName: 'Куб' },
  DimensionTable: { folder: 'DimensionTables', oneCName: 'ТаблицаИзмерения' },
  Subsystem: {
    folder: requireRegistryValue(META_TYPES.Subsystem.folder, 'META_TYPES.Subsystem.folder'),
    oneCName: requireRegistryValue(ONE_C_TYPE_NAMES.Subsystem, 'ONE_C_TYPE_NAMES.Subsystem'),
  },
};

const SUBORDINATE_TAG_BY_ONE_C_NAME: ReadonlyMap<string, RepositorySubordinateTag> = new Map(
  (Object.entries(REPOSITORY_SUBORDINATE_LAYOUT) as [RepositorySubordinateTag, RepositorySubordinateLayout][]).map(
    ([tag, layout]): [string, RepositorySubordinateTag] => [layout.oneCName, tag]
  )
);

export function isRepositorySubordinateTag(tag: string): tag is RepositorySubordinateTag {
  return Object.prototype.hasOwnProperty.call(REPOSITORY_SUBORDINATE_LAYOUT, tag);
}

/** Единица хранилища: владелец верхнего уровня и цепочка подчинённых до самой единицы. */
export interface RepositoryUnitPath {
  kind: MetaKind;
  name: string;
  segments: { tag: RepositorySubordinateTag; name: string }[];
}

/**
 * `Тип.Имя(.ПодТипRu.Имя)*` → путь единицы; `null` — нераспознанный вид владельца,
 * неизвестный вид подчинённого или оборванная пара «вид/имя».
 */
export function parseRepositoryUnit(fullName: string): RepositoryUnitPath | null {
  const parts = fullName.split('.');
  const kind = ONE_C_TYPE_NAMES_BY_PREFIX.get(parts[0]);
  if (!kind || parts.length % 2 !== 0) {
    return null;
  }
  const segments: RepositoryUnitPath['segments'] = [];
  for (let index = 2; index < parts.length; index += 2) {
    const tag = SUBORDINATE_TAG_BY_ONE_C_NAME.get(parts[index]);
    if (!tag) {
      return null;
    }
    segments.push({ tag, name: parts[index + 1] });
  }
  return { kind, name: parts[1], segments };
}

export function formatRepositoryUnit(unit: RepositoryUnitPath): string {
  return [
    `${String(ONE_C_TYPE_NAMES[unit.kind])}.${unit.name}`,
    ...unit.segments.map((segment) => `${REPOSITORY_SUBORDINATE_LAYOUT[segment.tag].oneCName}.${segment.name}`),
  ].join('.');
}

/** Имя подчинённой единицы; нераспознанный родитель — ошибка вызывающего кода. */
export function subordinateUnitFullName(parent: string, tag: RepositorySubordinateTag, name: string): string {
  if (!parseRepositoryUnit(parent)) {
    throw new Error(`Не распознано имя единицы хранилища "${parent}".`);
  }
  return `${parent}.${REPOSITORY_SUBORDINATE_LAYOUT[tag].oneCName}.${name}`;
}

/** Предки единицы от ближайшего к владельцу верхнего уровня; `[]` — для верхнего уровня и нераспознанных имён. */
export function getRepositoryUnitAncestors(fullName: string): string[] {
  const unit = parseRepositoryUnit(fullName);
  if (!unit) {
    return [];
  }
  const ancestors: string[] = [];
  for (let length = unit.segments.length - 1; length >= 0; length -= 1) {
    ancestors.push(formatRepositoryUnit({ ...unit, segments: unit.segments.slice(0, length) }));
  }
  return ancestors;
}

/** `Справочник.Товары` → `Catalog.Товары` (формат ссылки ChildObjects/Content). */
export function toChildObjectRef(fullName: string): string | null {
  const parsed = parseRepositoryFullName(fullName);
  if (!parsed) {
    return null;
  }
  // У всех видов ONE_C_TYPE_NAMES englishKind задан явно; `?? kind` — контракт MetaTypeDef.
  /* c8 ignore next */
  return `${META_TYPES[parsed.kind].englishKind ?? parsed.kind}.${parsed.name}`;
}

/**
 * Переводит ссылку из `<Content>` подсистемы (`Catalog.Товары`) в технический fullName
 * хранилища (`Справочник.Товары`). `null` — для нераспознанного префикса, например
 * UUID-ссылки на удалённый объект, которую платформа кладёт в Content вместо имени.
 */
export function convertContentRefToRepositoryFullName(ref: string): string | null {
  const parts = splitTypeAndName(ref);
  const kind = parts ? KIND_BY_ENGLISH_NAME.get(parts[0]) : undefined;
  const russianType = kind ? ONE_C_TYPE_NAMES[kind] : undefined;
  return parts && russianType ? `${russianType}.${parts[1]}` : null;
}

/**
 * Единица записи ConfigDumpInfo (`Catalog.X`, `Catalog.X.Form.Y`, `Configuration.X`) →
 * fullName хранилища. Пары «вид/имя» подчинённых переводятся, пока вид известен:
 * неизвестный вид подчинённого сводится к единице-родителю. Корень приводится к
 * сентинелу, т.к. именно им корень представлен в state.json и в планах выгрузки.
 */
export function dumpInfoOwnerToRepositoryFullName(owner: string, target: RepositoryTarget): string | null {
  const parts = owner.split('.');
  if (parts[0] === 'Configuration') {
    return getRootLockName(target);
  }
  const base = convertContentRefToRepositoryFullName(parts.slice(0, 2).join('.'));
  if (!base) {
    return null;
  }
  let fullName = base;
  for (let index = 2; index + 1 < parts.length && isRepositorySubordinateTag(parts[index]); index += 2) {
    fullName = subordinateUnitFullName(fullName, parts[index] as RepositorySubordinateTag, parts[index + 1]);
  }
  return fullName;
}

/**
 * Имя корня в `-listFile` частичной выгрузки. Формат для расширения совпадает с
 * основной конфигурацией; подтверждается только ручной проверкой на Конфигураторе.
 */
export function buildRootDumpListName(target: RepositoryTarget): string {
  return `Конфигурация.${target.displayName}`;
}

export function getRootLockName(target: RepositoryTarget): string {
  return target.configKind === 'cfe' ? EXTENSION_ROOT_LOCK_NAME : CONFIGURATION_ROOT_LOCK_NAME;
}

export function isRootLockName(name: string): boolean {
  return name === CONFIGURATION_ROOT_LOCK_NAME || name === EXTENSION_ROOT_LOCK_NAME;
}
