import * as path from 'path';
import {
  decideRootIncrementalStrategy,
  diffConfigDumpInfo,
  extractDumpInfoOwner,
} from '../../../infra/repository/ConfigDumpInfoDiff';
import { resolveNewSubsystemMembers } from '../../../infra/repository/RepositoryDumpPlan';
import { dumpInfoOwnerToRepositoryFullName, getRootLockName, isRootLockName } from '../../../infra/repository/RepositoryObjectNames';
import { CONFIG_DUMP_INFO_FILE, type ObjectScope } from '../../../infra/repository/RepositoryObjectScope';
import type { RepositoryNodeRef, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import { readConfigDumpInfoFile } from '../../../infra/xml/ConfigDumpInfoReader';
import { buildRepositoryLockRequest, buildRepositoryUpdateRequest } from './RepositoryCommandRunner';
import {
  applyMergeWithPostMutation,
  buildOperationBackupDir,
  DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
  isNestedSubsystemMember,
  isObjectMissingInProject,
  planMergeSources,
  prepareRepositorySubject,
  reportCliOutcome,
  reportFlowError,
  reportMergeOutcome,
  resolveConflictChoice,
  resolveMergeScope,
  resolveSubjectTarget,
  runRepositoryExclusive,
  skippedRelsOfScope,
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

/**
 * Предел выгрузок рекурсивной подсистемы за операцию: новые участники подсистемы
 * известны только из её XML версии хранилища, поэтому довыгружаются отдельными
 * раундами до неподвижной точки.
 */
const MAX_SUBSYSTEM_DUMP_ROUNDS = 5;

/** Выгрузки, сделанные в аренде: каталоги и то, что из них сливается в проект. */
interface AcquiredRepositoryDump {
  sources: DumpMergeSource[];
  added: string[];
  removed: string[];
  configDumpInfoSource?: string;
  /** Участники рекурсивной подсистемы, найденные довыгрузкой. */
  extraMembers: string[];
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
      const acquisition = await acquireRepositoryDump(subject, services, deps);
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
  });
}

async function acquireRepositoryDump(
  subject: RepositorySubject,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<DumpAcquisition> {
  switch (subject.plan.kind) {
    case 'objects':
      return acquireObjectsDump(subject, subject.plan.fullNames, services, deps);
    case 'root-object':
      return acquireObjectsDump(subject, [getRootLockName(subject.target)], services, deps);
    case 'root-incremental':
      return acquireRootIncrementalDump(subject.target, services, deps);
  }
}

/**
 * Частичная выгрузка объектов; для рекурсивной подсистемы — довыгрузка участников,
 * появившихся в её версии хранилища, каждый раунд в отдельный каталог.
 */
async function acquireObjectsDump(
  subject: RepositorySubject,
  fullNames: readonly string[],
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<DumpAcquisition> {
  const { target } = subject;
  const first = await deps.dumpToTemp(target, { mode: 'partial', fullNames: fullNames.map((name) => toDumpListName(name, target)) }, services);
  if (!first.ok) {
    return { status: 'failed', reason: first.reason };
  }
  const disposers = [() => { first.dispose(); }];
  const located = fullNames.map((fullName) => ({ fullName, dir: first.dir }));
  const extraMembers: string[] = [];
  if (subject.subsystemRecursive) {
    const known = new Set(fullNames);
    const dirs = [first.dir];
    for (let round = 1; round < MAX_SUBSYSTEM_DUMP_ROUNDS; round += 1) {
      const fresh = [...new Set(dirs.flatMap((dir) => resolveNewSubsystemMembers(dir, [subject.anchor], known)))];
      if (fresh.length === 0) {
        break;
      }
      const next = await deps.dumpToTemp(target, { mode: 'partial', fullNames: fresh }, services);
      if (!next.ok) {
        services.outputChannel.appendLine(`[repository][file-sync] довыгрузка участников подсистемы не удалась: ${next.reason}`);
        break;
      }
      disposers.push(() => { next.dispose(); });
      dirs.push(next.dir);
      fresh.forEach((fullName) => {
        known.add(fullName);
        extraMembers.push(fullName);
        located.push({ fullName, dir: next.dir });
      });
    }
  }
  const byDir = new Map<string, DumpScopeEntry[]>();
  const added: string[] = [];
  for (const { fullName, dir } of located) {
    if (isNestedSubsystemMember(subject, fullName)) {
      continue;
    }
    const scope = resolveMergeScope(target, fullName, dir, subject.subsystemRecursive && fullName === subject.anchor);
    if (!scope) {
      services.outputChannel.appendLine(`[repository][file-sync] «${fullName}»: область файлов не определена — пропущено.`);
      continue;
    }
    if (isObjectMissingInProject(target, fullName)) {
      added.push(fullName);
    }
    byDir.set(dir, [...(byDir.get(dir) ?? []), { fullName, scope }]);
  }
  return {
    status: 'acquired',
    dump: {
      sources: [...byDir.entries()].map(([dir, entries]) => ({ dir, entries })),
      added,
      removed: [],
      extraMembers,
      rootManifest: false,
      dispose: () => disposers.forEach((dispose) => dispose()),
    },
  };
}

/**
 * Рекурсивный корень: сравнение ConfigDumpInfo.xml проекта и базы, частичная выгрузка
 * только изменившихся владельцев. Полная выгрузка — лишь когда сравнение невозможно
 * или изменений слишком много.
 */
async function acquireRootIncrementalDump(
  target: RepositoryTarget,
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
  const diff = diffConfigDumpInfo(projectInfo, nextInfo);
  const totalOwners = new Set([...nextInfo.keys()].map(extractDumpInfoOwner)).size;
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
  const fetched = [...diff.changedOwners, ...diff.addedOwners].map(toFullName).filter((name): name is string => name !== null);
  const removed = diff.removedOwners.map(toFullName).filter((name): name is string => name !== null && !isRootLockName(name));
  const disposers = [() => { info.dispose(); }];
  let dir = info.dir;
  if (fetched.length > 0) {
    const partial = await deps.dumpToTemp(target, { mode: 'partial', fullNames: fetched.map((name) => toDumpListName(name, target)) }, services);
    if (!partial.ok) {
      info.dispose();
      return { status: 'failed', reason: partial.reason };
    }
    disposers.push(() => { partial.dispose(); });
    dir = partial.dir;
  }
  const entries = scopeEntries(target, fetched, dir);
  const removedEntries = scopeEntries(target, removed, undefined);
  return {
    status: 'acquired',
    dump: {
      sources: [{ dir, entries, removed: removedEntries }],
      added: fetched.filter((fullName) => isObjectMissingInProject(target, fullName)),
      removed,
      configDumpInfoSource: infoPath,
      extraMembers: [],
      rootManifest: true,
      dispose: () => disposers.forEach((dispose) => dispose()),
    },
  };
}

/** Владельцы корня: область подсистемы включает вложенные (ConfigDumpInfo группирует их под родителем). */
function scopeEntries(target: RepositoryTarget, fullNames: readonly string[], dumpDir: string | undefined): DumpScopeEntry[] {
  return fullNames
    .map((fullName) => ({ fullName, scope: resolveMergeScope(target, fullName, dumpDir, true) }))
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
 * Снимок = версия хранилища: из каталога выгрузки плюс файлы, которых в неполной
 * выгрузке не было. Получение пересоздаёт снимок только захваченным объектам.
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
      planned.flatMap((source) => source.plan.conflicts).forEach((entry) => {
        if (entry.repositoryHash !== null && keptLocal.has(path.resolve(target.configRoot, entry.rel))) {
          overrides[entry.rel] = entry.repositoryHash;
        }
      });
      snapshots.captureRootManifest(target, overrides);
    }
    return;
  }
  for (const source of planned) {
    for (const entry of source.entries) {
      const locked = isRootLockName(entry.fullName)
        ? services.repositoryService.isRootLocked(target)
        : services.repositoryService.isLocked(target, entry.fullName);
      if (operation === 'lock' || locked) {
        snapshots.captureFromDirectory(target, entry.fullName, source.dir, entry.scope, skippedRelsOfScope(source.plan, entry.scope));
      }
    }
  }
}

