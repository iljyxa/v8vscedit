import { isSupportedConfigFile } from '../../../infra/cache/HashCache';
import { resolveXmlPathByFullName } from '../../../infra/repository/RepositoryDumpPlan';
import {
  createTowardsExpansion,
  expandSubordinateUnits,
  runDumpRounds,
  type DumpRoundsFoundUnit,
} from '../../../infra/repository/RepositoryDumpRounds';
import { diffOwnersAgainstBaseline, hashScopeFiles } from '../../../infra/repository/RepositoryLockSnapshotStore';
import { getRepositoryUnitAncestors } from '../../../infra/repository/RepositoryObjectNames';
import type { ScopeDepth } from '../../../infra/repository/RepositoryObjectScope';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import { disposeOnError } from '../../../infra/repository/RepositoryTempCleanup';
import {
  toDumpListName,
  type RepositoryFileSyncDeps,
  type RepositoryFileSyncServices,
  type RepositorySubject,
} from './RepositoryFileSyncShared';

/**
 * Эталон единицы при отмене захвата: снимок захвата, свежая выгрузка версии хранилища
 * (снимка нет) или «пусто» (единица создана локально, в хранилище её нет). `depth` —
 * глубина области сравнения: `tree` только у старого глубокого снимка при рекурсивной
 * отмене, иначе у каждой единицы своя область.
 */
export type UnlockEtalonRequest = { fullName: string; depth: ScopeDepth } & (
  | { source: 'snapshot'; hashes: Record<string, string> }
  /** `dir` — каталог раунда выгрузки. */
  | { source: 'dump'; dir: string }
  | { source: 'empty' }
);

export type UnlockEtalons =
  | { status: 'ready'; objects: UnlockEtalonRequest[]; dispose(): void }
  | { status: 'failed'; reason: string };

const NOTHING_TO_DISPOSE = (): void => undefined;

function log(services: RepositoryFileSyncServices, message: string): void {
  services.outputChannel.appendLine(`[repository][file-sync] ${message}`);
}

/**
 * Эталоны в аренде: Конфигуратор нужен только единицам без снимка. Рекурсивный корень
 * сравнивается с хеш-манифестом (или хеш-кэшем, если манифеста нет) — выгружаются
 * только изменённые единицы. `currentRootHashes` — хеши файлов проекта, посчитанные
 * до аренды: отмена захвата файлы не меняет, а хеширование всей конфигурации внутри
 * аренды держало бы guard занятым без нужды.
 */
export async function acquireUnlockEtalons(
  subject: RepositorySubject,
  released: readonly string[],
  recursive: boolean,
  baseHashes: Readonly<Record<string, string>>,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  currentRootHashes?: Readonly<Record<string, string>>
): Promise<UnlockEtalons> {
  if (subject.isRoot && recursive) {
    const current = currentRootHashes ?? hashRootFiles(subject.target);
    const units = collectRootUnitsToRestore(services, subject.target, baseHashes, current);
    if (!units) {
      return { status: 'ready', objects: [], dispose: NOTHING_TO_DISPOSE };
    }
    const empty = units.added.map((fullName): UnlockEtalonRequest => ({ fullName, source: 'empty', depth: 'unit' }));
    // Все изменённые единицы были в манифесте на момент захвата, т.е. есть в хранилище, —
    // выгружаются одним запуском по точным именам.
    return dumpEtalons(subject, empty, units.changed, units.changed, services, deps);
  }
  const decided = decideSnapshotEtalons(subject, released, recursive, services);
  const wanted = new Set(decided.toDump);
  const anchors = decided.toDump.filter((fullName) => !getRepositoryUnitAncestors(fullName).some((ancestor) => wanted.has(ancestor)));
  return dumpEtalons(subject, decided.ready, decided.toDump, anchors, services, deps);
}

/**
 * Эталоны по снимкам (Р8) обходом от предков к потомкам: единица под предком с
 * глубоким эталоном покрыта им; свой снимок — эталон; нет снимка, а снимок ближайшего
 * предка знает состав подчинённых и её там нет — единица создана локально; иначе —
 * выгрузка.
 */
function decideSnapshotEtalons(
  subject: RepositorySubject,
  released: readonly string[],
  recursive: boolean,
  services: RepositoryFileSyncServices
): { ready: UnlockEtalonRequest[]; toDump: string[] } {
  const snapshots = services.repositoryService.snapshots;
  const byDepth = [...released].sort((left, right) =>
    getRepositoryUnitAncestors(left).length - getRepositoryUnitAncestors(right).length || left.localeCompare(right));
  const treeCovered = new Set<string>();
  const ready: UnlockEtalonRequest[] = [];
  const toDump: string[] = [];
  for (const fullName of byDepth) {
    const ancestors = getRepositoryUnitAncestors(fullName);
    if (ancestors.some((ancestor) => treeCovered.has(ancestor))) {
      treeCovered.add(fullName);
      continue;
    }
    const info = snapshots.readSnapshotInfo(subject.target, fullName);
    if (info) {
      const depth: ScopeDepth = info.depth === 'tree' && recursive ? 'tree' : 'unit';
      if (depth === 'tree') {
        treeCovered.add(fullName);
      }
      ready.push({ fullName, source: 'snapshot', depth, hashes: info.hashes });
      continue;
    }
    const parentSubordinates = ancestors.length > 0
      ? snapshots.readSnapshotInfo(subject.target, ancestors[0])?.subordinates
      : undefined;
    if (parentSubordinates && !parentSubordinates.includes(fullName)) {
      ready.push({ fullName, source: 'empty', depth: 'unit' });
      continue;
    }
    toDump.push(fullName);
  }
  return { ready, toDump };
}

/**
 * Выгрузка эталонов единиц без снимка: от якорей к вложенным единицам раунды идут
 * через XML уже выгруженных предков. Единица, которую выгруженный родитель не
 * перечисляет, в хранилище отсутствует — эталон «пусто»; остальные невыгруженные —
 * без эталона (лог, файлы и хеш-кэш не трогаются).
 */
async function dumpEtalons(
  subject: RepositorySubject,
  ready: UnlockEtalonRequest[],
  toDump: readonly string[],
  anchors: readonly string[],
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<UnlockEtalons> {
  if (toDump.length === 0) {
    return { status: 'ready', objects: ready, dispose: NOTHING_TO_DISPOSE };
  }
  const rounds = await runDumpRounds({
    target: subject.target,
    anchors,
    expansion: createTowardsExpansion(toDump),
    services,
    dumpToTemp: deps.dumpToTemp,
    toDumpListName,
    baseHashes: {},
    optimistic: false,
  });
  if (rounds.status === 'failed') {
    return { status: 'failed', reason: rounds.reason };
  }
  // Каталоги раундов до передачи в эталоны принадлежат этой функции — освобождаются и при исключении.
  return disposeOnError(rounds, (): UnlockEtalons => {
    const found = new Map(rounds.found.map((unit): [string, DumpRoundsFoundUnit] => [unit.fullName, unit]));
    const objects = [...ready];
    for (const fullName of toDump) {
      const unit = found.get(fullName);
      if (unit) {
        objects.push({ fullName, source: 'dump', depth: 'unit', dir: unit.dir });
      } else if (isAbsentInDumpedParent(fullName, found)) {
        objects.push({ fullName, source: 'empty', depth: 'unit' });
      } else {
        log(services, `«${fullName}»: версия хранилища не получена — сравнение пропущено.`);
      }
    }
    return { status: 'ready', objects, dispose: () => { rounds.dispose(); } };
  });
}

/** Невыгруженная единица не якорь, т.е. у неё есть родитель; его XML из выгрузки решает. */
function isAbsentInDumpedParent(fullName: string, found: ReadonlyMap<string, DumpRoundsFoundUnit>): boolean {
  const parent = found.get(getRepositoryUnitAncestors(fullName)[0]);
  if (!parent) {
    return false;
  }
  const parentXml = resolveXmlPathByFullName(parent.dir, parent.fullName);
  return parentXml !== null && !expandSubordinateUnits(parent.fullName, parentXml).includes(fullName);
}

/** Хеши всех файлов проекта цели — текущее состояние рекурсивного корня. */
export function hashRootFiles(target: RepositoryTarget): Record<string, string> {
  return hashScopeFiles(target.configRoot, { kind: 'all' });
}

/** Единицы рекурсивного корня, разошедшиеся с эталоном хешей; `null` — эталона нет. */
function collectRootUnitsToRestore(
  services: RepositoryFileSyncServices,
  target: RepositoryTarget,
  baseHashes: Readonly<Record<string, string>>,
  rootHashes: Readonly<Record<string, string>>
): { changed: string[]; added: string[] } | null {
  const manifest = services.repositoryService.snapshots.readRootManifestHashes(target);
  let baseline = manifest;
  let current = rootHashes;
  if (!baseline) {
    if (Object.keys(baseHashes).length === 0) {
      log(services, `«${target.displayName}»: нет хеш-манифеста захвата и хеш-кэша — откат файлов пропущен.`);
      return null;
    }
    // Хеш-кэш хранит только файлы конфигурации — остальные в сравнении не участвуют.
    baseline = baseHashes;
    current = Object.fromEntries(Object.entries(current).filter(([rel]) => isSupportedConfigFile(rel)));
  }
  const diff = diffOwnersAgainstBaseline(target, baseline, current);
  return { changed: diff.owners.filter((owner) => !diff.addedOwners.includes(owner)), added: diff.addedOwners };
}
