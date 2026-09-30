import * as fs from 'fs';
import * as path from 'path';

/** Разобранный путь к объекту метаданных внутри каталога выгрузки */
export interface ObjectLocation {
  /** Абсолютный путь к каталогу конфигурации */
  configRoot: string;
  /** Имя папки категории (например `Catalogs`, `Documents`) */
  folderName: string;
  /** Имя объекта */
  objectName: string;
  /** Абсолютный путь к каталогу объекта (всегда существует концептуально, даже при плоской структуре) */
  objectDir: string;
}

/**
 * Возвращает корень конфигурации, имя папки, имя объекта и каталог объекта по пути XML.
 * Понимает две формы выгрузки:
 *   - глубокая: `<Root>/<Folder>/<Name>/<Name>.xml`;
 *   - плоская:  `<Root>/<Folder>/<Name>.xml`.
 */
export function getObjectLocationFromXml(xmlPath: string): ObjectLocation {
  const normalized = path.normalize(xmlPath);
  const fileName = path.basename(normalized, '.xml');
  const xmlDir = path.dirname(normalized);
  const parentName = path.basename(xmlDir);

  const isDeep = parentName === fileName;

  if (isDeep) {
    const folderDir = path.dirname(xmlDir);
    return {
      configRoot: path.dirname(folderDir),
      folderName: path.basename(folderDir),
      objectName: fileName,
      objectDir: xmlDir,
    };
  }

  return {
    configRoot: path.dirname(xmlDir),
    folderName: path.basename(xmlDir),
    objectName: fileName,
    objectDir: path.join(xmlDir, fileName),
  };
}

/**
 * Ищет XML объекта метаданных в папке категории выгрузки: сначала глубокая форма
 * `<Root>/<Folder>/<Name>/<Name>.xml`, затем плоская `<Root>/<Folder>/<Name>.xml`.
 *
 * Глубокая форма проверяется первой, чтобы сохранить порядок, в котором искали
 * прежние копии этой логики (`MetaPathResolver.resolveXml`,
 * `RepositoryService.resolveOwnerObjectXmlPath`): при одновременном наличии обоих
 * файлов результат не меняется.
 *
 * Имя папки категории вычисляет вызывающий — из `META_TYPES` или из сегмента пути
 * к модулю; своего словаря «тип → папка» здесь нет, поэтому функция работает и
 * для папок, которых нет в реестре.
 */
export function findObjectXmlInFolder(configRoot: string, folderName: string, objectName: string): string | null {
  const deepPath = path.join(configRoot, folderName, objectName, `${objectName}.xml`);
  if (fs.existsSync(deepPath)) {
    return deepPath;
  }

  const flatPath = path.join(configRoot, folderName, `${objectName}.xml`);
  if (fs.existsSync(flatPath)) {
    return flatPath;
  }

  return null;
}
