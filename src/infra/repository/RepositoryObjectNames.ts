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

/** `Справочник.Товары` → `Catalog.Товары` (формат ссылки ChildObjects/Content). */
export function toChildObjectRef(fullName: string): string | null {
  const parsed = parseRepositoryFullName(fullName);
  if (!parsed) {
    return null;
  }
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
 * Владелец записи ConfigDumpInfo (`Catalog.X`, `Configuration.X`) → fullName хранилища.
 * Корень приводится к сентинелу, т.к. именно им корень представлен в state.json и
 * в планах выгрузки; имя конфигурации в записи для этого не нужно.
 */
export function dumpInfoOwnerToRepositoryFullName(owner: string, target: RepositoryTarget): string | null {
  const parts = splitTypeAndName(owner);
  if (!parts) {
    return null;
  }
  if (parts[0] === 'Configuration') {
    return getRootLockName(target);
  }
  return convertContentRefToRepositoryFullName(owner);
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
