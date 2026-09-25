import * as path from 'path';
import { patchHashCacheEntries } from '../../../infra/cache/HashCache';
import { resolveXmlPathByFullName } from '../../../infra/repository/RepositoryDumpPlan';
import { expandSubordinateUnits } from '../../../infra/repository/RepositoryDumpRounds';
import { hashScopeFiles } from '../../../infra/repository/RepositoryLockSnapshotStore';
import { diffScopeAgainstEtalon } from '../../../infra/repository/RepositoryMergePlanner';
import { isRootLockName } from '../../../infra/repository/RepositoryObjectNames';
import {
  detectScopeLayout,
  isPathInScope,
  mapDumpPathToProject,
  type ObjectScope,
} from '../../../infra/repository/RepositoryObjectScope';
import type { RepositoryNodeRef, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import { buildRepositoryCommitRequest, buildRepositoryUnlockRequest } from './RepositoryCommandRunner';
import {
  buildOperationBackupDir,
  DEFAULT_REPOSITORY_FILE_SYNC_DEPS,
  finishPostMutation,
  loadBaseHashes,
  prepareRepositorySubject,
  reportCliOutcome,
  reportFlowError,
  resolveMergeScope,
  resolveSubjectTarget,
  runRepositoryExclusive,
  type RepositoryFileSyncDeps,
  type RepositoryFileSyncServices,
  type RepositoryFlowOutcome,
  type RepositorySubject,
} from './RepositoryFileSyncShared';
import { acquireUnlockEtalons, type UnlockEtalonRequest, type UnlockEtalons } from './RepositoryUnlockEtalons';

interface UnlockLeaseResult {
  cli: Awaited<ReturnType<RepositoryFileSyncDeps['runRepositoryCli']>>;
  subject?: RepositorySubject;
  released?: string[];
  etalons?: UnlockEtalons;
}

/**
 * Отмена захвата: в аренде Конфигуратор, состояние захвата и (если эталона нет)
 * выгрузка версии хранилища; сравнение с эталоном и откат — после аренды.
 * Снимки удаляются при любом исходе: захвата больше нет.
 */
export async function runRepositoryUnlockFlow(
  node: RepositoryNodeRef,
  options: { recursive: boolean; force: boolean },
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps = DEFAULT_REPOSITORY_FILE_SYNC_DEPS
): Promise<RepositoryFlowOutcome> {
  const target = resolveSubjectTarget(node, services, deps);
  if (!target) {
    return 'failed';
  }
  const objectLabel = node.label ?? target.displayName;
  const label = `Освобождение «${objectLabel}»`;
  const syncEnabled = deps.isFileSyncEnabled();
  // Хеш-кэш нужен только рекурсивному корню без манифеста; читается до аренды guard'а.
  const baseHashes = syncEnabled && options.recursive && isRootNode(node) ? loadBaseHashes(services, target) : {};
  let leased: Awaited<ReturnType<typeof runRepositoryExclusive<UnlockLeaseResult>>>;
  try {
    leased = await runRepositoryExclusive<UnlockLeaseResult>(services, deps, label, async () => {
      const subject = prepareRepositorySubject(node, options.recursive, target, services);
      const cli = await deps.runRepositoryCli(
        buildRepositoryUnlockRequest(target, subject.objectsFile, objectLabel, options.force),
        services
      );
      if (cli.status !== 'done') {
        return { cli };
      }
      const released = applySubjectUnlock(services, subject, options.recursive);
      if (!syncEnabled) {
        return { cli, subject, released };
      }
      const etalons = await acquireUnlockEtalons(subject, released, options.recursive, baseHashes, services, deps);
      return { cli, subject, released, etalons };
    });
  } catch (error) {
    return reportFlowError(services, deps, label, error);
  }
  if (!leased.acquired) {
    return 'busy';
  }
  const { cli, subject, released, etalons } = leased.value;
  if (cli.status !== 'done') {
    return reportCliOutcome(cli, label, deps);
  }
  if (subject && released) {
    try {
      if (etalons) {
        await completeUnlockSync(subject, etalons, objectLabel, services, deps);
      }
    } catch (error) {
      reportFlowError(services, deps, `${label}: синхронизация файлов`, error);
    } finally {
      if (etalons?.status === 'ready') {
        etalons.dispose();
      }
      discardSubjectSnapshots(services, subject, released, options.recursive);
    }
  }
  deps.notifyInfo(`Объекты «${objectLabel}» освобождены.`);
  return 'done';
}

/**
 * Помещение: Конфигуратор в аренде; без сохранения захвата — то же снятие состояния,
 * что и при отмене захвата. С сохранением захвата версия хранилища = проект, поэтому
 * снимки пересоздаются из проекта.
 */
export async function runRepositoryCommitFlow(
  node: RepositoryNodeRef,
  formData: { recursive: boolean; comment: string; keepLocked: boolean; force: boolean },
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps = DEFAULT_REPOSITORY_FILE_SYNC_DEPS
): Promise<RepositoryFlowOutcome> {
  const target = resolveSubjectTarget(node, services, deps);
  if (!target) {
    return 'failed';
  }
  const objectLabel = node.label ?? target.displayName;
  const label = `Помещение «${objectLabel}»`;
  let leased: Awaited<ReturnType<typeof runRepositoryExclusive<UnlockLeaseResult>>>;
  try {
    leased = await runRepositoryExclusive<UnlockLeaseResult>(services, deps, label, async () => {
      const subject = prepareRepositorySubject(node, formData.recursive, target, services);
      const cli = await deps.runRepositoryCli(
        buildRepositoryCommitRequest(target, subject.objectsFile, objectLabel, formData),
        services
      );
      if (cli.status !== 'done' || formData.keepLocked) {
        return { cli, subject };
      }
      return { cli, subject, released: applySubjectUnlock(services, subject, formData.recursive) };
    });
  } catch (error) {
    return reportFlowError(services, deps, label, error);
  }
  if (!leased.acquired) {
    return 'busy';
  }
  const { cli, subject, released } = leased.value;
  if (cli.status !== 'done') {
    return reportCliOutcome(cli, label, deps);
  }
  if (subject && released) {
    discardSubjectSnapshots(services, subject, released, formData.recursive);
  } else if (subject && deps.isFileSyncEnabled()) {
    recaptureSnapshotsFromProject(services, subject);
  }
  deps.notifyInfo(`Изменения «${objectLabel}» помещены в хранилище.`);
  return 'done';
}

function applySubjectUnlock(services: RepositoryFileSyncServices, subject: RepositorySubject, recursive: boolean): string[] {
  return services.repositoryService.lockState.applyUnlock(subject.target, {
    anchor: subject.anchor,
    members: subject.members,
    recursive,
    isRoot: subject.isRoot,
  });
}

function isRootRecursive(subject: RepositorySubject, recursive: boolean): boolean {
  return subject.isRoot && recursive;
}

/** Корень определяется по виду узла ещё до аренды — так же, как в createObjectsFileForNode. */
function isRootNode(node: RepositoryNodeRef): boolean {
  return node.nodeKind === 'configuration' || node.nodeKind === 'extension';
}

function discardSubjectSnapshots(
  services: RepositoryFileSyncServices,
  subject: RepositorySubject,
  released: readonly string[],
  recursive: boolean
): void {
  const snapshots = services.repositoryService.snapshots;
  if (isRootRecursive(subject, recursive)) {
    snapshots.discardAll(subject.target);
    return;
  }
  released.forEach((fullName) => snapshots.discard(subject.target, fullName));
}

/** Помещение с сохранением захвата: версия хранилища = проект, снимок каждой захваченной единицы — из проекта. */
function recaptureSnapshotsFromProject(services: RepositoryFileSyncServices, subject: RepositorySubject): void {
  const { target } = subject;
  const repository = services.repositoryService;
  if (subject.isRoot && repository.lockState.isRootRecursiveLocked(target)) {
    repository.snapshots.captureRootManifest(target);
    return;
  }
  for (const fullName of subject.members) {
    const locked = isRootLockName(fullName) ? repository.isRootLocked(target) : repository.isLocked(target, fullName);
    const scope = locked ? resolveMergeScope(target, fullName, undefined, 'unit') : null;
    if (scope) {
      const projectXml = resolveXmlPathByFullName(target.configRoot, fullName);
      const subordinates = projectXml ? expandSubordinateUnits(fullName, projectXml) : undefined;
      repository.snapshots.captureFromProject(target, fullName, scope, 'unit', subordinates);
    }
  }
}

interface EtalonComparison {
  fullName: string;
  scope: ObjectScope;
  etalon: Record<string, string>;
  changed: string[];
  missing: string[];
  extra: string[];
}

async function completeUnlockSync(
  subject: RepositorySubject,
  etalons: UnlockEtalons,
  objectLabel: string,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): Promise<void> {
  if (etalons.status === 'failed') {
    services.outputChannel.appendLine(`[repository][file-sync][error] «${objectLabel}»: ${etalons.reason}`);
    deps.notifyWarning(`Не удалось сравнить файлы «${objectLabel}» с версией хранилища: ${etalons.reason}`);
    return;
  }
  const { target } = subject;
  const comparisons: EtalonComparison[] = [];
  for (const item of etalons.objects) {
    const scope = resolveMergeScope(target, item.fullName, item.source === 'dump' ? item.dir : undefined, item.depth);
    if (!scope) {
      services.outputChannel.appendLine(`[repository][file-sync] «${item.fullName}»: область файлов не определена — пропущено.`);
      continue;
    }
    const snapshotHashes = prepareSnapshotEtalon(services, target, item, scope);
    comparisons.push(compareWithEtalon(target, item.fullName, scope, snapshotHashes));
  }
  await rollbackToEtalons(services, deps, target, comparisons, objectLabel);
}

/**
 * Выгрузка и «пусто» превращаются в снимки, чтобы откат шёл одним путём restoreToProject.
 * Проектные файлы в эталон не подмешиваются: откат возвращает именно версию хранилища.
 */
function prepareSnapshotEtalon(
  services: RepositoryFileSyncServices,
  target: RepositoryTarget,
  item: UnlockEtalonRequest,
  scope: ObjectScope
): Record<string, string> {
  const snapshots = services.repositoryService.snapshots;
  switch (item.source) {
    case 'snapshot':
      return item.hashes;
    case 'dump':
      return snapshots.captureFromDirectory(target, item.fullName, item.dir, scope, [], item.depth);
    case 'empty':
      snapshots.captureEmpty(target, item.fullName);
      return {};
  }
}

function compareWithEtalon(
  target: RepositoryTarget,
  fullName: string,
  scope: ObjectScope,
  snapshotHashes: Readonly<Record<string, string>>
): EtalonComparison {
  const layout = detectScopeLayout(target.configRoot, scope);
  const etalon: Record<string, string> = {};
  for (const [rel, hash] of Object.entries(snapshotHashes)) {
    const projectRel = mapDumpPathToProject(rel, scope, layout);
    // Старый глубокий снимок содержит файлы подчинённых единиц — они сравниваются своими эталонами.
    if (isPathInScope(projectRel, scope)) {
      etalon[projectRel] = hash;
    }
  }
  const diff = diffScopeAgainstEtalon(etalon, hashScopeFiles(target.configRoot, scope));
  return { fullName, scope, etalon, ...diff };
}

/**
 * Один модальный диалог на все расходящиеся объекты. При любом исходе хеш-кэш = эталон:
 * база после отмены захвата содержит версию хранилища.
 */
async function rollbackToEtalons(
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  target: RepositoryTarget,
  comparisons: readonly EtalonComparison[],
  objectLabel: string
): Promise<void> {
  const divergent = comparisons.filter((item) => item.changed.length + item.missing.length + item.extra.length > 0);
  const toAbsolute = (rels: readonly string[]): string[] => rels.map((rel) => path.join(target.configRoot, rel));
  const changedFiles: string[] = [];
  let keptDivergentFiles: string[] = [];
  let structural = false;
  if (divergent.length > 0) {
    // Закрытие диалога без выбора = оставить изменения.
    const rollback = await deps.confirmRollback({
      objectLabel,
      objectCount: divergent.length,
      changedCount: sum(divergent, (item) => item.changed.length),
      missingCount: sum(divergent, (item) => item.missing.length),
      extraCount: sum(divergent, (item) => item.extra.length),
      files: divergent.flatMap((item) => [...item.changed, ...item.missing, ...item.extra]),
    });
    if (rollback) {
      const backupDir = buildOperationBackupDir(services, deps, target, 'unlock');
      for (const item of divergent) {
        services.suppressConfigurationReloadForFiles(toAbsolute([...item.changed, ...item.missing, ...item.extra]));
        const restored = services.repositoryService.snapshots.restoreToProject(target, item.fullName, item.scope, backupDir);
        changedFiles.push(...restored.restored, ...restored.deleted);
        structural ||= restored.deleted.length > 0 || item.missing.length > 0;
        if (restored.backups.length > 0) {
          services.outputChannel.appendLine(
            `[repository][file-sync] резервные копии: ${restored.backups.map((backup) => backup.backupPath).join(', ')}`
          );
        }
      }
    } else {
      keptDivergentFiles = divergent.flatMap((item) => toAbsolute([...item.changed, ...item.missing, ...item.extra]));
    }
  }
  const entries: Record<string, string> = {};
  comparisons.forEach((item) => Object.assign(entries, item.etalon));
  patchHashCacheEntries(
    services.workspaceFolder.uri.fsPath,
    target.configKind,
    target.configRoot,
    target.extensionName ?? '',
    entries,
    comparisons.flatMap((item) => item.extra)
  );
  if (changedFiles.length > 0 || keptDivergentFiles.length > 0) {
    await finishPostMutation(services, {
      changedFiles,
      keptDivergentFiles,
      structural: structural || changedFiles.some((filePath) => path.basename(filePath) === 'Configuration.xml'
        && path.resolve(path.dirname(filePath)) === path.resolve(target.configRoot)),
    });
  }
}

function sum<T>(items: readonly T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

