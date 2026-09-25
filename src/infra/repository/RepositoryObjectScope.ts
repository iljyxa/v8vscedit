import * as fs from 'fs';
import * as path from 'path';
import { META_TYPES } from '../../domain/MetaTypes';
import {
  formatRepositoryUnit,
  getRootLockName,
  isRootLockName,
  ONE_C_TYPE_NAMES,
  parseRepositoryUnit,
  REPOSITORY_SUBORDINATE_LAYOUT,
  type RepositorySubordinateTag,
  type RepositoryUnitPath,
} from './RepositoryObjectNames';
import type { RepositoryTarget } from './RepositoryService';

/**
 * Глубина области единицы хранилища:
 *  - `unit` — только сама единица: каталоги подчинённых единиц (формы, макеты,
 *    перерасчёты, таблицы, кубы, вложенные подсистемы) исключены, у них свои захват,
 *    выгрузка и снимок;
 *  - `tree` — весь каталог единицы (удалённые из хранилища единицы, старые глубокие снимки).
 */
export type ScopeDepth = 'unit' | 'tree';

/**
 * Область файлов, которую затрагивает захват/получение одной единицы хранилища.
 * Одна и та же область применяется и к проекту, и к временной выгрузке, чтобы
 * «лишние» файлы (сироты) определялись одинаково с обеих сторон.
 *  - `object` — XML единицы + содержимое её каталога (кроме `excludeDirRels`);
 *  - `root` — Configuration.xml + корневой Ext/** (модули приложения/сеанса и т.п.);
 *  - `all` — вся выгрузка (fallback полной выгрузки корня).
 * Все относительные пути — POSIX.
 */
export type ObjectScope =
  | {
    kind: 'object';
    fullName: string;
    xmlRel: string;
    dirRel: string;
    excludeDirRels: readonly string[];
    depth: ScopeDepth;
  }
  | { kind: 'root'; fullName: string }
  | { kind: 'all' };

export type ObjectXmlLayout = 'flat' | 'deep';

/** Служебный файл выгрузки: версии объектов, а не содержимое — в слияние не входит. */
export const CONFIG_DUMP_INFO_FILE = 'ConfigDumpInfo.xml';
const CONFIGURATION_XML_FILE = 'Configuration.xml';
const ROOT_EXT_DIR = 'Ext';

export function toPosixRel(rel: string): string {
  return rel.split(path.sep).join('/').replace(/\\/g, '/');
}

/** Каталоги подчинённых единиц под каталогом единицы — исключения области `unit`. */
const SUBORDINATE_FOLDERS: readonly string[] = Object.values(REPOSITORY_SUBORDINATE_LAYOUT).map((layout) => layout.folder);

const SUBORDINATE_TAG_BY_FOLDER: ReadonlyMap<string, RepositorySubordinateTag> = new Map(
  (Object.entries(REPOSITORY_SUBORDINATE_LAYOUT) as [RepositorySubordinateTag, { folder: string }][]).map(
    ([tag, layout]): [string, RepositorySubordinateTag] => [layout.folder, tag]
  )
);

/** Каталог единицы `Folder/Name(/SubFolder/Name)*`; папка владельца — из META_TYPES. */
function resolveUnitDirRel(unit: RepositoryUnitPath): string | null {
  const folder = META_TYPES[unit.kind].folder;
  if (!folder) {
    return null;
  }
  return [`${folder}/${unit.name}`, ...unit.segments.map((segment) => `${REPOSITORY_SUBORDINATE_LAYOUT[segment.tag].folder}/${segment.name}`)]
    .join('/');
}

/** XML единицы в `baseDir`: глубокая раскладка `…/N/N.xml`, затем плоская `…/N.xml`. */
function findUnitXmlRel(baseDir: string, dirRel: string): string | null {
  const name = path.posix.basename(dirRel);
  const deepXml = `${dirRel}/${name}.xml`;
  if (fs.existsSync(path.join(baseDir, deepXml))) {
    return deepXml;
  }
  const flatXml = `${path.posix.dirname(dirRel)}/${name}.xml`;
  return fs.existsSync(path.join(baseDir, flatXml)) ? flatXml : null;
}

/** Путь основного XML единицы относительно `baseDir`; `null` — имя не распознано или файла нет. */
export function resolveUnitXmlRel(baseDir: string, fullName: string): string | null {
  const unit = parseRepositoryUnit(fullName);
  const dirRel = unit ? resolveUnitDirRel(unit) : null;
  return dirRel ? findUnitXmlRel(baseDir, dirRel) : null;
}

/**
 * Область единицы по fullName (владелец верхнего уровня или подчинённый объект).
 * `null` — имя не распознано или XML единицы в `configRoot` нет.
 */
export function resolveObjectScope(
  configRoot: string,
  fullName: string,
  target: RepositoryTarget,
  depth: ScopeDepth = 'tree'
): ObjectScope | null {
  if (isRootLockName(fullName)) {
    return { kind: 'root', fullName: getRootLockName(target) };
  }
  const unit = parseRepositoryUnit(fullName);
  const dirRel = unit ? resolveUnitDirRel(unit) : null;
  const xmlRel = dirRel ? findUnitXmlRel(configRoot, dirRel) : null;
  if (!dirRel || !xmlRel) {
    return null;
  }
  const excludeDirRels = depth === 'unit' ? SUBORDINATE_FOLDERS.map((folder) => `${dirRel}/${folder}`) : [];
  return { kind: 'object', fullName, xmlRel, dirRel, excludeDirRels, depth };
}

function objectXmlForms(scope: Extract<ObjectScope, { kind: 'object' }>): { flat: string; deep: string } {
  const name = path.posix.basename(scope.dirRel);
  return {
    flat: `${path.posix.dirname(scope.dirRel)}/${name}.xml`,
    deep: `${scope.dirRel}/${name}.xml`,
  };
}

function isUnderDir(rel: string, dirRel: string): boolean {
  return rel.startsWith(`${dirRel}/`);
}

/**
 * Принадлежность пути области. XML объекта распознаётся в обеих раскладках, т.к.
 * раскладка проекта и выгрузки может различаться.
 */
export function isPathInScope(rel: string, scope: ObjectScope): boolean {
  const normalized = toPosixRel(rel);
  if (scope.kind === 'all') {
    return true;
  }
  if (scope.kind === 'root') {
    return normalized === CONFIGURATION_XML_FILE || isUnderDir(normalized, ROOT_EXT_DIR);
  }
  if (normalized === objectXmlForms(scope).flat) {
    return true;
  }
  return isUnderDir(normalized, scope.dirRel)
    && !scope.excludeDirRels.some((excluded) => isUnderDir(normalized, excluded));
}

/** Файлы области в каталоге `baseDir` (POSIX, отсортированы, без ConfigDumpInfo.xml). */
export function collectScopeFiles(baseDir: string, scope: ObjectScope): string[] {
  const result: string[] = [];
  const pushIfFile = (rel: string): void => {
    if (isExistingFile(path.join(baseDir, rel))) {
      result.push(rel);
    }
  };
  if (scope.kind === 'all') {
    walkFiles(baseDir, '', result);
  } else if (scope.kind === 'root') {
    pushIfFile(CONFIGURATION_XML_FILE);
    walkFiles(baseDir, ROOT_EXT_DIR, result);
  } else {
    pushIfFile(objectXmlForms(scope).flat);
    walkFiles(baseDir, scope.dirRel, result, new Set(scope.excludeDirRels));
  }
  return result
    .filter((rel) => rel !== CONFIG_DUMP_INFO_FILE && isPathInScope(rel, scope))
    .sort((left, right) => left.localeCompare(right));
}

/** Раскладка XML объекта области в каталоге `baseDir`; без XML — раскладка самой области. */
export function detectScopeLayout(baseDir: string, scope: ObjectScope): ObjectXmlLayout {
  if (scope.kind !== 'object') {
    return 'flat';
  }
  const forms = objectXmlForms(scope);
  if (isExistingFile(path.join(baseDir, forms.deep))) {
    return 'deep';
  }
  if (isExistingFile(path.join(baseDir, forms.flat))) {
    return 'flat';
  }
  return scope.xmlRel === forms.deep ? 'deep' : 'flat';
}

/**
 * Путь файла выгрузки в проекте: XML объекта переводится в раскладку проекта,
 * прочие файлы каталога объекта от раскладки не зависят.
 */
export function mapDumpPathToProject(rel: string, scope: ObjectScope, projectLayout: ObjectXmlLayout): string {
  if (scope.kind !== 'object') {
    return rel;
  }
  const normalized = toPosixRel(rel);
  const forms = objectXmlForms(scope);
  if (normalized !== forms.flat && normalized !== forms.deep) {
    return rel;
  }
  return projectLayout === 'deep' ? forms.deep : forms.flat;
}

/**
 * Владелец файла выгрузки как fullName хранилища. Папка распознаётся по META_TYPES
 * (без отдельного словаря папок); файлы корня — сентинел корня; вложенные файлы
 * объекта (формы, макеты, модули) — сам объект верхнего уровня.
 */
export function resolveOwnerFullNameByRelativePath(rel: string, target: RepositoryTarget): string | null {
  const normalized = toPosixRel(rel);
  if (normalized === CONFIG_DUMP_INFO_FILE) {
    return null;
  }
  if (normalized === CONFIGURATION_XML_FILE || isUnderDir(normalized, ROOT_EXT_DIR)) {
    return getRootLockName(target);
  }
  const segments = normalized.split('/');
  if (segments.length < 2) {
    return null;
  }
  const [folder, objectSegment] = segments;
  const def = Object.values(META_TYPES).find(
    (candidate) => candidate.folder === folder && ONE_C_TYPE_NAMES[candidate.kind] !== undefined
  );
  const typeName = def ? ONE_C_TYPE_NAMES[def.kind] : undefined;
  if (!typeName) {
    return null;
  }
  const objectName = segments.length === 2 && objectSegment.toLowerCase().endsWith('.xml')
    ? objectSegment.slice(0, -'.xml'.length)
    : objectSegment;
  return `${typeName}.${objectName}`;
}

/**
 * Подчинённые сегменты единицы по пути файла внутри каталога владельца: пары
 * «каталог подчинённых/имя» (`Forms/Y`, `Cubes/C/DimensionTables/D`). Только строковые
 * операции — вызывается на горячем пути проверки readonly. Файлы внутри каталогов
 * не-единиц (`Commands/**`, `Ext/**`) относятся к ближайшей единице.
 */
export function resolveUnitSuffixByRelativePath(rel: string): RepositoryUnitPath['segments'] {
  const segments = toPosixRel(rel).split('/');
  const result: RepositoryUnitPath['segments'] = [];
  for (let index = 2; index + 1 < segments.length; index += 2) {
    const tag = SUBORDINATE_TAG_BY_FOLDER.get(segments[index]);
    if (!tag) {
      break;
    }
    const isLast = index + 2 === segments.length;
    result.push({ tag, name: isLast ? stripXmlExtension(segments[index + 1]) : segments[index + 1] });
  }
  return result;
}

/** Самая конкретная единица хранилища по пути файла (владелец + подчинённые сегменты). */
export function resolveLockUnitByRelativePath(rel: string, target: RepositoryTarget): string | null {
  const owner = resolveOwnerFullNameByRelativePath(rel, target);
  const unit = owner ? parseRepositoryUnit(owner) : null;
  if (!unit) {
    return owner;
  }
  unit.segments.push(...resolveUnitSuffixByRelativePath(rel));
  return formatRepositoryUnit(unit);
}

function stripXmlExtension(segment: string): string {
  return segment.toLowerCase().endsWith('.xml') ? segment.slice(0, -'.xml'.length) : segment;
}

/**
 * Удаляет опустевшие каталоги от файла вверх, пока каталог остаётся внутри области —
 * папка типа (`Catalogs`) и корень конфигурации не трогаются.
 */
export function removeEmptyParentDirs(baseDir: string, rel: string, scope: ObjectScope): void {
  let dirRel = path.posix.dirname(toPosixRel(rel));
  while (dirRel.includes('/') && isPathInScope(`${dirRel}/_`, scope)) {
    const dirPath = path.join(baseDir, dirRel);
    try {
      if (fs.readdirSync(dirPath).length > 0) {
        return;
      }
      fs.rmdirSync(dirPath);
    } catch {
      return;
    }
    dirRel = path.posix.dirname(dirRel);
  }
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Исключённые каталоги не обходятся: файлы подчинённых единиц не нужны области владельца. */
function walkFiles(baseDir: string, relDir: string, out: string[], excluded: ReadonlySet<string> = new Set()): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(baseDir, relDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!excluded.has(rel)) {
        walkFiles(baseDir, rel, out, excluded);
      }
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}
