import * as path from 'path';
import {
  decideRootIncrementalStrategy,
  diffConfigDumpInfo,
  extractDumpInfoUnit,
} from '../../../infra/repository/ConfigDumpInfoDiff';
import {
  resolveXmlPathByFullName,
  SUBSYSTEM_MEMBERS_INCLUDE_SUBORDINATES,
  type DumpExpansion,
} from '../../../infra/repository/RepositoryDumpPlan';
import {
  collectRemovedSubordinates,
  createNewSubordinatesExpansion,
  createSubsystemExpansion,
  createTowardsExpansion,
  expandSubordinateUnits,
  runDumpRounds,
  type UnitExpansion,
} from '../../../infra/repository/RepositoryDumpRounds';
import {
  dumpInfoOwnerToRepositoryFullName,
  getRepositoryUnitAncestors,
  getRootLockName,
  isRootLockName,
} from '../../../infra/repository/RepositoryObjectNames';
import { CONFIG_DUMP_INFO_FILE, type ObjectScope, type ScopeDepth } from '../../../infra/repository/RepositoryObjectScope';
import type { RepositoryNodeRef, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import { readConfigDumpInfoFile } from '../../../infra/xml/ConfigDumpInfoReader';
import { buildRepositoryLockRequest, buildRepositoryUpdateRequest } from './RepositoryCommandRunner';
import {
  applyMergeWithPostMutation,
  buildOperationBackupDir,
  DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
  isObjectMissingInProject,
  loadBaseHashes,
  planMergeSources,
  prepareRepositorySubject,
  reportCliOutcome,
  reportFlowError,
  reportMergeOutcome,
  resolveConflictChoice,
  resolveMergeScope,
  resolveSubjectTarget,
  runRepositoryExclusive,
  toDumpListName,
  type DumpMergeSource,
  type DumpScopeEntry,
  type MergeApplicationResult,
  type PlannedMergeSource,
  type RepositoryFileSyncDeps,
  type RepositoryFileSyncServices,
  type RepositoryFlowOutcome,
  type RepositorySubject,
} from './RepositoryFileSyncShared';

/** Выгрузки, сделанные в аренде: каталоги и то, что из них сливается в проект. */
interface AcquiredRepositoryDump {
  sources: DumpMergeSource[];
  added: string[];
  removed: string[];
  configDumpInfoSource?: string;
  /** Единицы, найденные раундами выгрузки сверх состава по проекту, — члены захвата. */
  extraMembers: string[];
  /** Единицы, которые не удалось выгрузить: в слияние не входят, их файлы не трогаются. */
  missing: string[];
  /** Рекурсивный корень: эталон отмены захвата — хеш-манифест, а не снимки объектов. */
  rootManifest: boolean;
  dispose(): void;
}

type DumpAcquisition =
  | { status: 'acquired'; dump: AcquiredRepositoryDump }
  | { status: 'unchanged' }
  | { status: 'failed'; reason: string };

interface LeaseResult {
  cli: Awaited<ReturnType<RepositoryFileSyncDeps['runRepositoryCli']>>;
  subject?: RepositorySubject;
  acquisition?: DumpAcquisition;
}

type RepositoryFetchOperation = 'lock' | 'update';

/**
 * Захват: в одной аренде Конфигуратор (`-revised`), состояние захвата и выгрузка
 * во временный каталог; слияние с проектом, диалог конфликтов и снимок — после неё.
 */
export async function runRepositoryLockFlow(
  node: RepositoryNodeRef,
  recursive: boolean,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps = DEFAULT_REPOSITORY_FILE_SYNC_DEPS
): Promise<RepositoryFlowOutcome> {
  return runFetchFlow('lock', node, { recursive, force: false }, services, deps);
}

/** Получение: те же шаги без изменения состояния захвата. */
export async function runRepositoryUpdateFlow(
  node: RepositoryNodeRef,
  options: { recursive: boolean; force: boolean; version?: string },
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps = DEFAULT_REPOSITORY_FILE_SYNC_DEPS
): Promise<RepositoryFlowOutcome> {
  return runFetchFlow('update', node, options, services, deps);
}

async function runFetchFlow(
  operation: RepositoryFetchOperation,
  node: RepositoryNodeRef,
  options: { recursive: boolean; force: boolean; version?: string },
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<RepositoryFlowOutcome> {
  const target = resolveSubjectTarget(node, services, deps);
  if (!target) {
    return 'failed';
  }
  const objectLabel = node.label ?? target.displayName;
  const label = `${operation === 'lock' ? 'Захват' : 'Получение'} «${objectLabel}»`;
  const syncEnabled = deps.isFileSyncEnabled();
  // Хеш-кэш большой конфигурации читается долго — только до аренды guard'а.
  const baseHashes = syncEnabled ? loadBaseHashes(services, target) : {};
  let leased: Awaited<ReturnType<typeof runRepositoryExclusive<LeaseResult>>>;
  try {
    leased = await runRepositoryExclusive<LeaseResult>(services, deps, label, async () => {
      const subject = prepareRepositorySubject(node, options.recursive, target, services);
      const request = operation === 'lock'
        ? buildRepositoryLockRequest(target, subject.objectsFile, objectLabel)
        : buildRepositoryUpdateRequest(target, subject.objectsFile, objectLabel, options);
      const cli = await deps.runRepositoryCli(request, services);
      if (cli.status !== 'done') {
        return { cli };
      }
      if (operation === 'lock') {
        applySubjectLock(services, subject, subject.members);
      }
      if (!syncEnabled) {
        return { cli, subject };
      }
      const acquisition = await acquireRepositoryDump(subject, baseHashes, services, deps);
      if (operation === 'lock' && acquisition.status === 'acquired' && acquisition.dump.extraMembers.length > 0) {
        applySubjectLock(services, subject, [...subject.members, ...acquisition.dump.extraMembers]);
      }
      return { cli, subject, acquisition };
    });
  } catch (error) {
    return reportFlowError(services, deps, label, error);
  }
  if (!leased.acquired) {
    return 'busy';
  }
  const { cli, subject, acquisition } = leased.value;
  if (cli.status !== 'done') {
    return reportCliOutcome(cli, label, deps);
  }
  if (subject && acquisition) {
    try {
      await completeFetchSync(operation, subject, acquisition, objectLabel, services, deps);
    } catch (error) {
      // Сбой синхронизации файлов не отменяет уже выполненную операцию хранилища.
      reportFlowError(services, deps, `${label}: синхронизация файлов`, error);
    }
  }
  deps.notifyInfo(operation === 'lock'
    ? `Объекты «${objectLabel}» захвачены.`
    : `Объекты «${objectLabel}» получены из хранилища.`);
  return 'done';
}

function applySubjectLock(services: RepositoryFileSyncServices, subject: RepositorySubject, members: readonly string[]): void {
  services.repositoryService.lockState.applyLock(subject.target, {
    anchor: subject.anchor,
    members,
    recursiveRoot: subject.isRoot && subject.plan.kind === 'root-incremental',
    // Корень описывается rootRecursive, режим для него не пишется.
    mode: subject.isRoot ? undefined : subject.mode,
  });
}

async function acquireRepositoryDump(
  subject: RepositorySubject,
  baseHashes: Readonly<Record<string, string>>,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<DumpAcquisition> {
  switch (subject.plan.kind) {
    case 'objects':
      return acquireObjectsDump(subject, subject.plan.anchors, subject.plan.expansion, baseHashes, services, deps);
    case 'root-object':
      return acquireObjectsDump(subject, [getRootLockName(subject.target)], 'none', baseHashes, services, deps);
    case 'root-incremental':
      return acquireRootIncrementalDump(subject.target, baseHashes, services, deps);
  }
}

function resolveUnitExpansion(expansion: DumpExpansion, target: RepositoryTarget): UnitExpansion {
  switch (expansion) {
    case 'subordinates':
      return expandSubordinateUnits;
    case 'subsystem':
      return createSubsystemExpansion(SUBSYSTEM_MEMBERS_INCLUDE_SUBORDINATES);
    case 'new-subordinates':
      return createNewSubordinatesExpansion(target);
    case 'none':
      return createTowardsExpansion();
  }
}

interface DumpSourceDraft {
  entries: DumpScopeEntry[];
  removed: DumpScopeEntry[];
}

/**
 * Выгрузка единиц раундами (см. RepositoryDumpRounds): каждая найденная единица
 * сливается своей областью `unit` из каталога своего раунда. Подчинённые, исчезнувшие
 * из XML версии хранилища, при рекурсивной операции удаляются целиком (`tree`), при
 * нерекурсивной — не трогаются: сервер их не отдаёт и не захватывает.
 */
async function acquireObjectsDump(
  subject: RepositorySubject,
  anchors: readonly string[],
  expansion: DumpExpansion,
  baseHashes: Readonly<Record<string, string>>,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<DumpAcquisition> {
  const { target } = subject;
  const log = (message: string): void => services.outputChannel.appendLine(`[repository][file-sync] ${message}`);
  const rounds = await runDumpRounds({
    target,
    anchors,
    expansion: resolveUnitExpansion(expansion, target),
    services,
    dumpToTemp: deps.dumpToTemp,
    toDumpListName,
    baseHashes,
    optimistic: expansion !== 'none',
  });
  if (rounds.status === 'failed') {
    return { status: 'failed', reason: rounds.reason };
  }
  const recursive = expansion === 'subordinates' || expansion === 'subsystem';
  const drafts = new Map<string, DumpSourceDraft>();
  const added: string[] = [];
  for (const { fullName, dir } of rounds.found) {
    const scope = resolveMergeScope(target, fullName, dir, 'unit');
    if (!scope) {
      log(`«${fullName}»: область файлов не определена — пропущено.`);
      continue;
    }
    // В ChildObjects Configuration.xml попадают только объекты верхнего уровня.
    if (getRepositoryUnitAncestors(fullName).length === 0 && isObjectMissingInProject(target, fullName)) {
      added.push(fullName);
    }
    const draft = drafts.get(dir) ?? { entries: [], removed: [] };
    drafts.set(dir, draft);
    draft.entries.push({ fullName, scope });
    const removed = collectRemovedUnitSubordinates(target, fullName, dir);
    if (recursive) {
      draft.removed.push(...scopeEntries(target, removed, undefined, 'tree'));
    } else if (removed.length > 0) {
      log(`«${fullName}»: в хранилище нет ${removed.join(', ')} — при нерекурсивной операции файлы не тронуты.`);
    }
  }
  const known = new Set(subject.members);
  return {
    status: 'acquired',
    dump: {
      sources: [...drafts.entries()].map(([dir, draft]) => ({ dir, entries: draft.entries, removed: draft.removed })),
      added,
      removed: [],
      extraMembers: recursive ? rounds.found.map((unit) => unit.fullName).filter((fullName) => !known.has(fullName)) : [],
      missing: rounds.missing,
      rootManifest: false,
      dispose: () => { rounds.dispose(); },
    },
  };
}

/** Подчинённые единицы, перечисленные в XML проекта, но исчезнувшие из XML выгрузки. */
function collectRemovedUnitSubordinates(target: RepositoryTarget, fullName: string, dumpDir: string): string[] {
  const projectXml = resolveXmlPathByFullName(target.configRoot, fullName);
  const dumpXml = resolveXmlPathByFullName(dumpDir, fullName);
  return projectXml && dumpXml ? collectRemovedSubordinates(target, fullName, projectXml, dumpXml) : [];
}

/**
 * Рекурсивный корень: сравнение ConfigDumpInfo.xml проекта и базы, частичная выгрузка
 * только изменившихся владельцев. Полная выгрузка — лишь когда сравнение невозможно
 * или изменений слишком много.
 */
async function acquireRootIncrementalDump(
  target: RepositoryTarget,
  baseHashes: Readonly<Record<string, string>>,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<DumpAcquisition> {
  const log = (message: string): void => services.outputChannel.appendLine(`[repository][file-sync] ${message}`);
  const projectInfo = readConfigDumpInfoFile(path.join(target.configRoot, CONFIG_DUMP_INFO_FILE));
  if (!projectInfo) {
    log('нет проектного ConfigDumpInfo.xml — полная выгрузка.');
    return acquireFullDump(target, services, deps);
  }
  const info = await deps.dumpToTemp(target, { mode: 'update-info' }, services);
  if (!info.ok) {
    log(`сбой выгрузки ConfigDumpInfo.xml (${info.reason}) — полная выгрузка.`);
    return acquireFullDump(target, services, deps);
  }
  const infoPath = path.join(info.dir, CONFIG_DUMP_INFO_FILE);
  const nextInfo = readConfigDumpInfoFile(infoPath);
  // Пустой новый ConfigDumpInfo при непустом проектном — сбой выгрузки, а не удаление всех объектов.
  if (!nextInfo || (nextInfo.size === 0 && projectInfo.size > 0)) {
    info.dispose();
    log('ConfigDumpInfo.xml из базы не разобран — полная выгрузка.');
    return acquireFullDump(target, services, deps);
  }
  // Группировка по единицам: изменённая форма выгружается одна, без владельца.
  const diff = diffConfigDumpInfo(projectInfo, nextInfo, extractDumpInfoUnit);
  const totalOwners = new Set([...nextInfo.keys()].map(extractDumpInfoUnit)).size;
  const strategy = decideRootIncrementalStrategy(diff, totalOwners);
  if (strategy !== 'partial') {
    info.dispose();
    if (strategy === 'none') {
      log('ConfigDumpInfo.xml без изменений — выгрузка объектов не нужна.');
      return { status: 'unchanged' };
    }
    log('изменено владельцев больше порога — полная выгрузка.');
    return acquireFullDump(target, services, deps);
  }
  const toFullName = (owner: string): string | null => {
    const fullName = dumpInfoOwnerToRepositoryFullName(owner, target);
    if (!fullName) {
      log(`владелец "${owner}" не распознан — пропущен.`);
    }
    return fullName;
  };
  // Неизвестный вид подчинённого сводится к единице-родителю — возможны повторы.
  const fetched = [...new Set([...diff.changedOwners, ...diff.addedOwners].map(toFullName).filter((name): name is string => name !== null))];
  const removed = diff.removedOwners.map(toFullName).filter((name): name is string => name !== null && !isRootLockName(name));
  const disposers = [() => { info.dispose(); }];
  let dir = info.dir;
  if (fetched.length > 0) {
    const rounds = await runDumpRounds({
      target,
      anchors: fetched,
      expansion: createTowardsExpansion(),
      services,
      dumpToTemp: deps.dumpToTemp,
      toDumpListName,
      baseHashes,
      optimistic: false,
    });
    if (rounds.status === 'failed') {
      info.dispose();
      return { status: 'failed', reason: rounds.reason };
    }
    disposers.push(() => { rounds.dispose(); });
    dir = rounds.found[0].dir;
  }
  const isTopLevel = (fullName: string): boolean => getRepositoryUnitAncestors(fullName).length === 0;
  return {
    status: 'acquired',
    dump: {
      sources: [{ dir, entries: scopeEntries(target, fetched, dir, 'unit'), removed: scopeEntries(target, removed, undefined, 'tree') }],
      added: fetched.filter((fullName) => isTopLevel(fullName) && isObjectMissingInProject(target, fullName)),
      removed: removed.filter(isTopLevel),
      configDumpInfoSource: infoPath,
      extraMembers: [],
      missing: [],
      rootManifest: true,
      dispose: () => disposers.forEach((dispose) => dispose()),
    },
  };
}

/**
 * Единицы корня со своими областями. Удалённые из хранилища сливаются областью `tree`:
 * вместе с единицей исчезают и все её подчинённые.
 */
function scopeEntries(
  target: RepositoryTarget,
  fullNames: readonly string[],
  dumpDir: string | undefined,
  depth: ScopeDepth
): DumpScopeEntry[] {
  return fullNames
    .map((fullName) => ({ fullName, scope: resolveMergeScope(target, fullName, dumpDir, depth) }))
    .filter((entry): entry is DumpScopeEntry => entry.scope !== null);
}

async function acquireFullDump(
  target: RepositoryTarget,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<DumpAcquisition> {
  const full = await deps.dumpToTemp(target, { mode: 'full' }, services);
  if (!full.ok) {
    return { status: 'failed', reason: full.reason };
  }
  const scope: ObjectScope = { kind: 'all' };
  return {
    status: 'acquired',
    dump: {
      sources: [{ dir: full.dir, entries: [{ fullName: getRootLockName(target), scope }] }],
      added: [],
      removed: [],
      configDumpInfoSource: path.join(full.dir, CONFIG_DUMP_INFO_FILE),
      extraMembers: [],
      missing: [],
      rootManifest: true,
      dispose: () => { full.dispose(); },
    },
  };
}

async function completeFetchSync(
  operation: RepositoryFetchOperation,
  subject: RepositorySubject,
  acquisition: DumpAcquisition,
  objectLabel: string,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<void> {
  const { target } = subject;
  if (acquisition.status === 'failed') {
    services.outputChannel.appendLine(`[repository][file-sync][error] «${objectLabel}»: ${acquisition.reason}`);
    deps.notifyWarning(`Не удалось синхронизировать файлы «${objectLabel}» с хранилищем: ${acquisition.reason}`);
    return;
  }
  if (acquisition.status === 'unchanged') {
    if (shouldCaptureRootManifest(operation, services, target)) {
      services.repositoryService.snapshots.captureRootManifest(target);
    }
    return;
  }
  const { dump } = acquisition;
  try {
    const planned = planMergeSources(services, deps, target, dump.sources);
    const choice = await resolveConflictChoice(deps, planned, operation === 'lock' ? 'Захват' : 'Получение', objectLabel);
    const applied = await applyMergeWithPostMutation(services, {
      target,
      sources: planned,
      choice,
      backupDir: buildOperationBackupDir(services, deps, target, operation),
      childObjects: { added: dump.added, removed: dump.removed },
      configDumpInfoSource: dump.configDumpInfoSource,
    });
    captureFetchSnapshots(operation, subject, dump, planned, applied, services);
    await reportMergeOutcome(services, deps, planned, applied, choice, objectLabel);
    if (dump.missing.length > 0) {
      services.outputChannel.appendLine(`[repository][file-sync] «${objectLabel}»: не выгружены ${dump.missing.join(', ')}.`);
      deps.notifyWarning(`«${objectLabel}»: часть подчинённых объектов не получена из базы (${String(dump.missing.length)}), их файлы не изменены (см. журнал).`);
    }
  } finally {
    dump.dispose();
  }
}

function shouldCaptureRootManifest(
  operation: RepositoryFetchOperation,
  services: RepositoryFileSyncServices,
  target: RepositoryTarget
): boolean {
  return operation === 'lock' || services.repositoryService.lockState.isRootRecursiveLocked(target);
}

/**
 * Снимок = версия хранилища: по снимку на каждую захваченную единицу из каталога её
 * раунда, с подчинёнными из XML версии хранилища. Проектные файлы в снимок не
 * подмешиваются: откат должен возвращать именно версию хранилища.
 */
function captureFetchSnapshots(
  operation: RepositoryFetchOperation,
  subject: RepositorySubject,
  dump: AcquiredRepositoryDump,
  planned: readonly PlannedMergeSource[],
  applied: MergeApplicationResult,
  services: RepositoryFileSyncServices
): void {
  const { target } = subject;
  const snapshots = services.repositoryService.snapshots;
  if (dump.rootManifest) {
    if (shouldCaptureRootManifest(operation, services, target)) {
      const keptLocal = new Set(applied.merge.keptLocalFiles.map((filePath) => path.resolve(filePath)));
      const overrides: Record<string, string> = {};
      const excludeRels: string[] = [];
      planned.flatMap((source) => source.plan.conflicts).forEach((entry) => {
        if (!keptLocal.has(path.resolve(target.configRoot, entry.rel))) {
          return;
        }
        // Файла нет в версии хранилища — в манифесте его быть не должно.
        if (entry.repositoryHash === null) {
          excludeRels.push(entry.rel);
        } else {
          overrides[entry.rel] = entry.repositoryHash;
        }
      });
      snapshots.captureRootManifest(target, overrides, excludeRels);
    }
    return;
  }
  for (const source of planned) {
    for (const entry of source.entries) {
      const locked = isRootLockName(entry.fullName)
        ? services.repositoryService.isRootLocked(target)
        : services.repositoryService.isLocked(target, entry.fullName);
      // Полученная, но не захваченная единица (новая форма при нерекурсивном захвате) снимка не требует.
      if (locked) {
        const dumpXml = resolveXmlPathByFullName(source.dir, entry.fullName);
        const subordinates = dumpXml ? expandSubordinateUnits(entry.fullName, dumpXml) : undefined;
        snapshots.captureFromDirectory(target, entry.fullName, source.dir, entry.scope, [], 'unit', subordinates);
      }
    }
  }
}

