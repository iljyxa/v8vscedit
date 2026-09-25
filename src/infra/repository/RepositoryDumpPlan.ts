import * as fs from 'fs';
import * as path from 'path';
import { META_TYPES } from '../../domain/MetaTypes';
import { SubsystemXmlService, type SubsystemInfo } from '../xml/SubsystemXmlService';
import {
  convertContentRefToRepositoryFullName,
  isRootLockName,
  ONE_C_TYPE_NAMES,
  parseRepositoryFullName,
} from './RepositoryObjectNames';
import type { RepositoryNodeRef } from './RepositoryService';

/**
 * Что выгружать из базы после захвата/получения:
 *  - `objects` — частичная выгрузка перечисленных объектов;
 *  - `root-object` — нерекурсивный захват корня: частичная выгрузка только самого корня;
 *  - `root-incremental` — рекурсивный захват корня: сравнение ConfigDumpInfo.xml и
 *    выгрузка только изменившихся владельцев (полная — лишь как fallback).
 */
export type RepositoryDumpPlan =
  | { kind: 'objects'; fullNames: readonly string[] }
  | { kind: 'root-object' }
  | { kind: 'root-incremental' };

/**
 * План выгрузки для объектов, только что захваченных/полученных (`objects` — результат
 * `createObjectsFileForNode` для того же узла и `recursive`). Сервер хранилища раскрывает
 * состав рекурсивной подсистемы сам и нигде локально его не сохраняет, поэтому состав
 * раскрывается здесь по XML подсистемы.
 */
export function buildRepositoryDumpPlan(
  node: RepositoryNodeRef,
  objects: { fullNames: readonly string[] },
  recursive: boolean
): RepositoryDumpPlan {
  if (objects.fullNames.length > 0 && isRootLockName(objects.fullNames[0])) {
    return recursive ? { kind: 'root-incremental' } : { kind: 'root-object' };
  }
  if (node.nodeKind === 'Subsystem' && recursive && node.xmlPath) {
    return { kind: 'objects', fullNames: resolveSubsystemMemberFullNames(node.xmlPath, true) };
  }
  return { kind: 'objects', fullNames: objects.fullNames };
}

/**
 * Состав подсистемы: fullName самой подсистемы плюс объекты её `<Content>`; при
 * `recursive` — то же для дочерних подсистем (`<Папка>/<Имя>/<Имя>.xml`, иначе
 * `<Папка>/<Имя>.xml`, как в дереве подсистем).
 */
export function resolveSubsystemMemberFullNames(subsystemXmlPath: string, recursive: boolean): string[] {
  const subsystemXmlService = new SubsystemXmlService();
  const result = new Set<string>();
  const visited = new Set<string>();

  const visit = (xmlPath: string): void => {
    const key = path.resolve(xmlPath).toLowerCase();
    if (visited.has(key) || !fs.existsSync(xmlPath)) {
      return;
    }
    visited.add(key);

    let subsystem: SubsystemInfo;
    try {
      subsystem = subsystemXmlService.readSubsystem(xmlPath);
    } catch {
      // Повреждённый XML подсистемы не должен ронять весь план выгрузки — ветка пропускается.
      return;
    }

    result.add(`${String(ONE_C_TYPE_NAMES.Subsystem)}.${subsystem.name}`);
    // `<Content>` хранит английские ссылки (`Catalog.Товары`), а `-listFile` ожидает
    // русский технический fullName — копировать ссылки как есть нельзя.
    for (const ref of subsystem.contentRefs) {
      const repositoryFullName = convertContentRefToRepositoryFullName(ref);
      if (repositoryFullName) {
        result.add(repositoryFullName);
      }
    }

    if (!recursive) {
      return;
    }
    for (const child of subsystem.childSubsystems) {
      const nested = path.join(subsystem.homeDir, 'Subsystems', child, `${child}.xml`);
      const flat = path.join(subsystem.homeDir, 'Subsystems', `${child}.xml`);
      visit(fs.existsSync(nested) ? nested : flat);
    }
  };

  visit(subsystemXmlPath);
  return [...result];
}

/**
 * По fullName (`Справочник.Номенклатура`) находит XML объекта верхнего уровня в
 * `configRoot` (глубокая раскладка, затем плоская). `null` — тип не распознан или
 * файла нет.
 */
export function resolveXmlPathByFullName(configRoot: string, fullName: string): string | null {
  const parsed = parseRepositoryFullName(fullName);
  const folder = parsed ? META_TYPES[parsed.kind].folder : undefined;
  if (!parsed || !folder) {
    return null;
  }
  const typeDir = path.join(configRoot, folder);
  const nested = path.join(typeDir, parsed.name, `${parsed.name}.xml`);
  if (fs.existsSync(nested)) {
    return nested;
  }
  const flat = path.join(typeDir, `${parsed.name}.xml`);
  return fs.existsSync(flat) ? flat : null;
}

/**
 * Участники рекурсивных подсистем по их версии из выгрузки (`dumpDir`), которых нет
 * среди уже выгруженных (`known`): новые в хранилище объекты подсистемы, требующие
 * довыгрузки. Вложенные подсистемы в результат не входят — их файлы приходят в
 * составе выгрузки родителя. Подсистема, ещё не выгруженная в `dumpDir`, пропускается.
 */
export function resolveNewSubsystemMembers(
  dumpDir: string,
  subsystemFullNames: readonly string[],
  known: ReadonlySet<string>
): string[] {
  const subsystems = new Set(subsystemFullNames);
  const result = new Set<string>();
  for (const subsystemFullName of subsystemFullNames) {
    const xmlPath = resolveXmlPathByFullName(dumpDir, subsystemFullName);
    if (!xmlPath) {
      continue;
    }
    for (const member of resolveSubsystemMemberFullNames(xmlPath, true)) {
      if (!known.has(member) && !subsystems.has(member) && parseRepositoryFullName(member)?.kind !== 'Subsystem') {
        result.add(member);
      }
    }
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}
