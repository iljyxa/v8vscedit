import * as fs from 'fs';
import * as path from 'path';
import { SubsystemXmlService, type SubsystemInfo } from '../xml/SubsystemXmlService';
import {
  buildOptimisticDumpList,
  createSubsystemExpansion,
  expandSubordinateUnits,
} from './RepositoryDumpRounds';
import {
  convertContentRefToRepositoryFullName,
  isRootLockName,
  ONE_C_TYPE_NAMES,
  subordinateUnitFullName,
} from './RepositoryObjectNames';
import { resolveUnitXmlRel } from './RepositoryObjectScope';
import type { RepositoryNodeRef } from './RepositoryService';

/**
 * Стратегия раскрытия единиц при выгрузке (см. RepositoryDumpRounds):
 *  - `subordinates` — рекурсивный захват объекта: все подчинённые с собственным XML;
 *  - `subsystem` — рекурсивная подсистема: вложенные подсистемы, участники и их подчинённые;
 *  - `new-subordinates` — нерекурсивная операция: только подчинённые, которых нет в проекте
 *    (сервер отдаёт их в базу при получении, но не захватывает);
 *  - `none` — точные имена без раскрытия.
 */
export type DumpExpansion = 'subordinates' | 'subsystem' | 'new-subordinates' | 'none';

/**
 * Рекурсивный захват подсистемы захватывает на сервере и подчинённые участников
 * (формы, макеты) — проверено на платформе, поэтому они входят в состав выгрузки.
 */
export const SUBSYSTEM_MEMBERS_INCLUDE_SUBORDINATES = true;

/**
 * Что выгружать из базы после захвата/получения:
 *  - `objects` — единицы: `anchors` (узел операции), `fullNames` (состав по проекту —
 *    члены захвата до выгрузки) и стратегия раскрытия;
 *  - `root-object` — нерекурсивный захват корня: частичная выгрузка только самого корня;
 *  - `root-incremental` — рекурсивный захват корня: сравнение ConfigDumpInfo.xml и
 *    выгрузка только изменившихся единиц (полная — лишь как fallback).
 */
export type RepositoryDumpPlan =
  | { kind: 'objects'; anchors: readonly string[]; fullNames: readonly string[]; expansion: DumpExpansion }
  | { kind: 'root-object' }
  | { kind: 'root-incremental' };

/**
 * План выгрузки для только что захваченных/полученных объектов (`objects` — результат
 * `createObjectsFileForNode` для того же узла и `recursive`). Сервер нигде локально не
 * сохраняет раскрытый состав, поэтому он восстанавливается по XML проекта; расхождения
 * с хранилищем досчитываются раундами выгрузки.
 */
export function buildRepositoryDumpPlan(
  node: RepositoryNodeRef,
  objects: { fullNames: readonly string[] },
  recursive: boolean,
  configRoot: string
): RepositoryDumpPlan {
  const anchors = objects.fullNames;
  if (anchors.length > 0 && isRootLockName(anchors[0])) {
    return recursive ? { kind: 'root-incremental' } : { kind: 'root-object' };
  }
  if (!recursive) {
    return { kind: 'objects', anchors, fullNames: anchors, expansion: 'new-subordinates' };
  }
  if (node.nodeKind === 'Subsystem' && node.xmlPath) {
    const members = resolveSubsystemMemberFullNames(node.xmlPath, true, anchors[0]);
    const fullNames = buildOptimisticDumpList(members, configRoot, createSubsystemExpansion(SUBSYSTEM_MEMBERS_INCLUDE_SUBORDINATES), {});
    return { kind: 'objects', anchors, fullNames, expansion: 'subsystem' };
  }
  return { kind: 'objects', anchors, fullNames: buildOptimisticDumpList(anchors, configRoot, expandSubordinateUnits, {}), expansion: 'subordinates' };
}

/**
 * Состав подсистемы: fullName самой подсистемы плюс объекты её `<Content>`; при
 * `recursive` — то же для вложенных подсистем. Вложенная подсистема — самостоятельная
 * единица хранилища с именем `Подсистема.A.Подсистема.B`: короткое имя платформа
 * отклоняет, и вся выгрузка падает.
 */
export function resolveSubsystemMemberFullNames(
  subsystemXmlPath: string,
  recursive: boolean,
  rootFullName?: string
): string[] {
  const subsystemXmlService = new SubsystemXmlService();
  const result = new Set<string>();
  const visited = new Set<string>();

  const visit = (xmlPath: string, fullName: string | undefined): void => {
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

    const subsystemFullName = fullName ?? `${String(ONE_C_TYPE_NAMES.Subsystem)}.${subsystem.name}`;
    result.add(subsystemFullName);
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
      visit(fs.existsSync(nested) ? nested : flat, subordinateUnitFullName(subsystemFullName, 'Subsystem', child));
    }
  };

  visit(subsystemXmlPath, rootFullName);
  return [...result];
}

/**
 * По fullName единицы (`Справочник.Номенклатура`, `Справочник.Номенклатура.Форма.Ф`)
 * находит её XML в `configRoot` (глубокая раскладка, затем плоская). `null` — имя не
 * распознано или файла нет.
 */
export function resolveXmlPathByFullName(configRoot: string, fullName: string): string | null {
  const xmlRel = resolveUnitXmlRel(configRoot, fullName);
  return xmlRel ? path.join(configRoot, xmlRel) : null;
}
