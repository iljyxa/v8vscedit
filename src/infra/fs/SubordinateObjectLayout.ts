import { META_TYPES } from '../../domain/MetaTypes';

/**
 * Подчинённые объекты с собственным XML в выгрузке: у каждого свой uuid, своя
 * запись в `ParentConfigurations.bin` и ConfigDumpInfo, свой захват в хранилище.
 * Файл лежит в подкаталоге владельца — `<Владелец>/<папка>/<Имя>.xml`, а его
 * модули и собственные подчинённые — в `<Владелец>/<папка>/<Имя>/`, поэтому
 * цепочка вложенности (куб → таблица измерения, подсистема → подсистема,
 * таблица → форма) читается из пути парами «папка/имя».
 *
 * Команды сюда не входят: в выгрузке команда описана внутри XML владельца,
 * отдельного файла у неё нет.
 */
export type SubordinateObjectTag = 'Form' | 'Template' | 'Recalculation' | 'Table' | 'Cube' | 'DimensionTable' | 'Subsystem';

function requireSubsystemFolder(): string {
  const folder = META_TYPES.Subsystem.folder;
  /* c8 ignore next 3 -- META_TYPES задаёт папку подсистем статически; ветка ловит порчу реестра при загрузке модуля */
  if (folder === undefined) {
    throw new Error('SubordinateObjectLayout: в META_TYPES не задана папка подсистем');
  }
  return folder;
}

/**
 * Подкаталог владельца для каждого вида подчинённого. Перерасчёт, таблица, куб и
 * таблица измерения — не MetaKind, поэтому заданы литералами (технический долг:
 * при появлении этих видов в навигаторе папки переезжают в META_TYPES).
 */
export const SUBORDINATE_OBJECT_FOLDERS: Readonly<Record<SubordinateObjectTag, string>> = {
  Form: 'Forms',
  Template: 'Templates',
  Recalculation: 'Recalculations',
  Table: 'Tables',
  Cube: 'Cubes',
  DimensionTable: 'DimensionTables',
  Subsystem: requireSubsystemFolder(),
};

const FOLDERS: ReadonlySet<string> = new Set(Object.values(SUBORDINATE_OBJECT_FOLDERS));

/** Является ли сегмент пути подкаталогом подчинённых со своим XML (регистр — как в выгрузке). */
export function isSubordinateObjectFolder(segment: string): boolean {
  return FOLDERS.has(segment);
}
