import * as path from 'path';
import type { ConfigurationDumpRequest } from '../agent';
import { readChildObjectRefs } from '../xml/ChildObjectRefsReader';
import { SubsystemXmlService } from '../xml/SubsystemXmlService';
import {
  convertContentRefToRepositoryFullName,
  getRepositoryUnitAncestors,
  parseRepositoryUnit,
  REPOSITORY_SUBORDINATE_LAYOUT,
  subordinateUnitFullName,
  type RepositorySubordinateTag,
} from './RepositoryObjectNames';
import { resolveUnitXmlRel } from './RepositoryObjectScope';
import type { RepositoryTarget } from './RepositoryService';

/**
 * Выгрузка единиц хранилища раундами. Частичная выгрузка владельца не содержит его
 * подчинённых с собственным XML, а полный состав подчинённых известен только из XML
 * версии хранилища. Поэтому раунд 0 оптимистично берёт состав из проекта (обычно
 * совпадает — один запуск Конфигуратора), а следующие раунды довыгружают то, что
 * обнаружилось в XML уже выгруженных единиц. Несуществующее в базе имя роняет весь
 * запуск, поэтому оптимистичный список при сбое откатывается к якорям.
 */

/** Прямые подчинённые единицы по её XML (`unitXmlPath`) — fullName'ы хранилища. */
export type UnitExpansion = (unit: string, unitXmlPath: string) => string[];

/** Предел запусков выгрузки за одну операцию: защита от бесконечного раскрытия. */
export const MAX_DUMP_ROUNDS = 5;

const SUBORDINATE_TAGS: ReadonlySet<string> = new Set(Object.keys(REPOSITORY_SUBORDINATE_LAYOUT));

export interface DumpRoundsTempDir {
  dir: string;
  dispose(): void;
}

export type DumpRoundsTempResult = ({ ok: true } & DumpRoundsTempDir) | { ok: false; reason: string };

export interface DumpRoundsRequest<S extends { outputChannel: { appendLine(line: string): void } }> {
  target: RepositoryTarget;
  /** Единицы, без которых операция не имеет смысла; при сбое выгружаются одни. */
  anchors: readonly string[];
  expansion: UnitExpansion;
  services: S;
  dumpToTemp: (target: RepositoryTarget, request: ConfigurationDumpRequest, services: S) => Promise<DumpRoundsTempResult>;
  toDumpListName: (fullName: string, target: RepositoryTarget) => string;
  /** Хеш-кэш проекта, загруженный до аренды guard'а. */
  baseHashes: Readonly<Record<string, string>>;
  /** Раунд 0 с раскрытием по проекту; `false` — только якоря (точные имена). */
  optimistic: boolean;
}

export interface DumpRoundsFoundUnit {
  fullName: string;
  /** Каталог раунда, в который выгружена единица. */
  dir: string;
}

export type DumpRoundsResult =
  | { status: 'ok'; found: DumpRoundsFoundUnit[]; missing: string[]; dispose(): void }
  | { status: 'failed'; reason: string };

export function expandSubordinateUnits(unit: string, unitXmlPath: string): string[] {
  return (readChildObjectRefs(unitXmlPath, SUBORDINATE_TAGS) ?? [])
    .map((ref) => subordinateUnitFullName(unit, ref.tag as RepositorySubordinateTag, ref.name));
}

/**
 * Рекурсивная подсистема: вложенные подсистемы и участники `<Content>`; участник
 * (не подсистема) раскрывается в собственных подчинённых, если так захватывает сервер.
 */
export function createSubsystemExpansion(includeMemberSubordinates: boolean): UnitExpansion {
  return (unit, unitXmlPath) => {
    if (parseRepositoryUnit(unit)?.kind !== 'Subsystem') {
      return includeMemberSubordinates ? expandSubordinateUnits(unit, unitXmlPath) : [];
    }
    return [...expandSubordinateUnits(unit, unitXmlPath), ...readSubsystemContent(unitXmlPath)];
  };
}

function readSubsystemContent(subsystemXmlPath: string): string[] {
  let refs: string[];
  try {
    refs = new SubsystemXmlService().readSubsystem(subsystemXmlPath).contentRefs;
    /* c8 ignore start -- раскрытие вызывается только для XML, найденного в каталоге; сбой чтения — гонка с ФС */
  } catch {
    return [];
  }
  /* c8 ignore stop */
  return refs
    .map((ref) => convertContentRefToRepositoryFullName(ref))
    .filter((fullName): fullName is string => fullName !== null);
}

/** Нерекурсивная операция: подчинённые из XML хранилища, которых в проекте ещё нет. */
export function createNewSubordinatesExpansion(target: RepositoryTarget): UnitExpansion {
  return (unit, unitXmlPath) => expandSubordinateUnits(unit, unitXmlPath)
    .filter((fullName) => resolveUnitXmlRel(target.configRoot, fullName) === null);
}

/**
 * Отмена захвата без снимка: из выгруженной единицы — только подчинённые, ведущие к
 * нужным единицам `wanted` (сами нужные и их предки).
 */
export function createTowardsExpansion(wanted: readonly string[] = []): UnitExpansion {
  const reachable = new Set(wanted.flatMap((fullName) => [fullName, ...getRepositoryUnitAncestors(fullName)]));
  return (unit, unitXmlPath) => expandSubordinateUnits(unit, unitXmlPath).filter((fullName) => reachable.has(fullName));
}

/** Раскрытие единиц, чей XML есть в `dir`; уникально и отсортировано. */
export function collectUnitClosure(dir: string, units: readonly string[], expansion: UnitExpansion): string[] {
  const result = new Set<string>();
  for (const unit of units) {
    const xmlRel = resolveUnitXmlRel(dir, unit);
    if (xmlRel) {
      expansion(unit, path.join(dir, xmlRel)).forEach((fullName) => result.add(fullName));
    }
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

/**
 * Список раунда 0: якоря и замыкание раскрытия по XML проекта. Не-якорные имена при
 * непустом хеш-кэше берутся, только если XML единицы известен с прошлой синхронизации:
 * локальный подчинённый, которого нет в базе, иначе ронял бы весь запуск.
 */
export function buildOptimisticDumpList(
  anchors: readonly string[],
  projectRoot: string,
  expansion: UnitExpansion,
  baseHashes: Readonly<Record<string, string>>
): string[] {
  const filterByCache = Object.keys(baseHashes).length > 0;
  const result = [...anchors];
  const seen = new Set(anchors);
  const queue = [...anchors];
  for (let unit = queue.shift(); unit !== undefined; unit = queue.shift()) {
    const xmlRel = resolveUnitXmlRel(projectRoot, unit);
    if (!xmlRel) {
      continue;
    }
    for (const candidate of expansion(unit, path.join(projectRoot, xmlRel))) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      const candidateXmlRel = resolveUnitXmlRel(projectRoot, candidate);
      if (filterByCache && (candidateXmlRel === null || !Object.prototype.hasOwnProperty.call(baseHashes, candidateXmlRel))) {
        continue;
      }
      result.push(candidate);
      queue.push(candidate);
    }
  }
  return result;
}

/**
 * Подчинённые, удалённые из хранилища: перечислены в XML проекта, но не в XML
 * выгрузки, и их файлы ещё есть в проекте.
 */
export function collectRemovedSubordinates(
  target: RepositoryTarget,
  ownerUnit: string,
  projectXmlPath: string,
  dumpXmlPath: string
): string[] {
  const inRepository = new Set(expandSubordinateUnits(ownerUnit, dumpXmlPath));
  return expandSubordinateUnits(ownerUnit, projectXmlPath)
    .filter((fullName) => !inRepository.has(fullName) && resolveUnitXmlRel(target.configRoot, fullName) !== null);
}

/**
 * Раунды выгрузки внутри аренды guard'а. Успешный запуск означает, что все имена
 * списка есть в базе (несуществующее имя роняет весь запуск), поэтому каждое
 * запрошенное имя успешного раунда — найденная единица; раскрываются только те, чей
 * XML есть в каталоге раунда. Каталоги раундов освобождает `dispose` результата, а
 * при сбое — сама функция.
 */
export async function runDumpRounds<S extends { outputChannel: { appendLine(line: string): void } }>(
  request: DumpRoundsRequest<S>
): Promise<DumpRoundsResult> {
  const { target, anchors, expansion, services } = request;
  const log = (message: string): void => services.outputChannel.appendLine(`[repository][file-sync] ${message}`);
  const disposers: (() => void)[] = [];
  const dispose = (): void => disposers.splice(0).forEach((item) => { item(); });
  let calls = 0;
  const dumpRound = async (fullNames: readonly string[]): Promise<DumpRoundsTempResult> => {
    calls += 1;
    const result = await request.dumpToTemp(
      target,
      { mode: 'partial', fullNames: fullNames.map((fullName) => request.toDumpListName(fullName, target)) },
      services
    );
    if (result.ok) {
      disposers.push(() => { result.dispose(); });
    }
    return result;
  };
  let handedOver = false;
  try {
    let list = request.optimistic ? buildOptimisticDumpList(anchors, target.configRoot, expansion, request.baseHashes) : [...anchors];
    let round = await dumpRound(list);
    if (!round.ok && list.length > anchors.length) {
      log(`оптимистичный список выгрузки отклонён (${round.reason}) — повтор только по ${anchors.join(', ')}.`);
      list = [...anchors];
      round = await dumpRound(list);
    }
    if (!round.ok) {
      return { status: 'failed', reason: round.reason };
    }
    const found: DumpRoundsFoundUnit[] = [];
    const known = new Set<string>();
    const record = (fullNames: readonly string[], dir: string): void => {
      fullNames.forEach((fullName) => {
        found.push({ fullName, dir });
        known.add(fullName);
      });
    };
    record(list, round.dir);
    let fresh = list;
    let freshDir = round.dir;
    const missing: string[] = [];
    for (;;) {
      const expected = collectUnitClosure(freshDir, fresh, expansion).filter((fullName) => !known.has(fullName));
      if (expected.length === 0) {
        break;
      }
      if (calls >= MAX_DUMP_ROUNDS) {
        log(`достигнут предел ${String(MAX_DUMP_ROUNDS)} запусков выгрузки — не выгружены: ${expected.join(', ')}.`);
        missing.push(...expected);
        break;
      }
      const next = await dumpRound(expected);
      if (!next.ok) {
        log(`довыгрузка ${expected.join(', ')} не удалась: ${next.reason}`);
        missing.push(...expected);
        break;
      }
      record(expected, next.dir);
      fresh = expected;
      freshDir = next.dir;
    }
    handedOver = true;
    return { status: 'ok', found, missing, dispose };
  } finally {
    if (!handedOver) {
      dispose();
    }
  }
}
