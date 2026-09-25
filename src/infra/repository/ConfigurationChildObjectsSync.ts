import * as path from 'path';
import type { ConfigurationXmlEditor } from '../xml/ConfigurationXmlEditor';
import { isRootLockName, toChildObjectRef } from './RepositoryObjectNames';

export interface ChildObjectsSyncResult {
  changedFiles: string[];
  warnings: string[];
}

/**
 * Приводит `<ChildObjects>` Configuration.xml в соответствие объектам, появившимся
 * или исчезнувшим после получения из хранилища (fullName хранилища, `Справочник.X`).
 * Порядок и сохранение BOM/EOL — на стороне `ConfigurationXmlEditor`; объекты без
 * файла верхнего уровня (например, вложенная подсистема) не добавляются и дают
 * предупреждение. Сентинел корня — не объект ChildObjects и молча пропускается.
 */
export function syncConfigurationChildObjects(
  configRoot: string,
  changes: { added: readonly string[]; removed: readonly string[] },
  editor: ConfigurationXmlEditor
): ChildObjectsSyncResult {
  const configXmlPath = path.join(configRoot, 'Configuration.xml');
  const changedFiles = new Set<string>();
  const warnings: string[] = [];
  const apply = (fullName: string, edit: (objectRef: string) => { changedFiles: string[]; warnings: string[]; errors: string[] }): void => {
    if (isRootLockName(fullName)) {
      return;
    }
    const objectRef = toChildObjectRef(fullName);
    if (!objectRef) {
      warnings.push(`Неизвестный тип объекта хранилища "${fullName}" — ChildObjects не изменён.`);
      return;
    }
    const result = edit(objectRef);
    result.changedFiles.forEach((file) => changedFiles.add(file));
    warnings.push(...result.warnings, ...result.errors);
  };
  changes.added.forEach((fullName) => apply(fullName, (ref) => editor.addChildObject(configXmlPath, ref)));
  changes.removed.forEach((fullName) => apply(fullName, (ref) => editor.removeChildObject(configXmlPath, ref)));
  return { changedFiles: [...changedFiles], warnings };
}
