import * as fs from 'fs';
import * as path from 'path';
import { META_TYPES } from '../../domain/MetaTypes';
import { getRootLockName, isRootLockName, ONE_C_TYPE_NAMES, parseRepositoryFullName } from './RepositoryObjectNames';
import type { RepositoryTarget } from './RepositoryService';

/**
 * Область файлов, которую затрагивает захват/получение одного объекта хранилища.
 * Одна и та же область применяется и к проекту, и к временной выгрузке, чтобы
 * «лишние» файлы (сироты) определялись одинаково с обеих сторон.
 *  - `object` — XML объекта + всё содержимое его каталога (кроме `excludeDirRels`);
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

/**
 * Область объекта по fullName. Папка берётся из META_TYPES; поддерживаются обе
 * раскладки XML (плоская `F/N.xml` и глубокая `F/N/N.xml`). `null` — тип не
 * распознан или XML объекта в `configRoot` нет.
 */
export function resolveObjectScope(configRoot: string, fullName: string, target: RepositoryTarget): ObjectScope | null {
  if (isRootLockName(fullName)) {
    return { kind: 'root', fullName: getRootLockName(target) };
  }
  const parsed = parseRepositoryFullName(fullName);
  const folder = parsed ? META_TYPES[parsed.kind].folder : undefined;
  if (!parsed || !folder) {
    return null;
  }
  const dirRel = `${folder}/${parsed.name}`;
  const deepXml = `${dirRel}/${parsed.name}.xml`;
  const flatXml = `${folder}/${parsed.name}.xml`;
  let xmlRel: string;
  if (fs.existsSync(path.join(configRoot, deepXml))) {
    xmlRel = deepXml;
  } else if (fs.existsSync(path.join(configRoot, flatXml))) {
    xmlRel = flatXml;
  } else {
    return null;
  }
  // Вложенные подсистемы — самостоятельные объекты хранилища со своим захватом,
  // поэтому их файлы не относятся к области родительской подсистемы.
  const excludeDirRels = parsed.kind === 'Subsystem' ? [`${dirRel}/Subsystems`] : [];
  return { kind: 'object', fullName, xmlRel, dirRel, excludeDirRels };
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
    walkFiles(baseDir, scope.dirRel, result);
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

function walkFiles(baseDir: string, relDir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(baseDir, relDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkFiles(baseDir, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}
