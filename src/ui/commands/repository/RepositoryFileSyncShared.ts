import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConfigurationDumpRequest } from '../../../infra/agent';
import { buildScopeKey, computeFileHash, loadHashCache, patchHashCacheForFiles } from '../../../infra/cache/HashCache';
import { syncConfigurationChildObjects } from '../../../infra/repository/ConfigurationChildObjectsSync';
import { buildRepositoryDumpPlan, resolveXmlPathByFullName, type RepositoryDumpPlan } from '../../../infra/repository/RepositoryDumpPlan';
import { buildRepositoryScopeKey } from '../../../infra/repository/RepositoryLockState';
import {
  applyRepositoryMerge,
  buildMergeBackupDir,
  type MergeApplyResult,
  type MergeChoice,
} from '../../../infra/repository/RepositoryMergeApplier';
import {
  collectMergeFileStates,
  isTextMergeFile,
  planRepositoryMerge,
  type MergePlan,
} from '../../../infra/repository/RepositoryMergePlanner';
import type { RepositoryLockMode } from '../../../infra/repository/RepositoryLockState';
import { buildRootDumpListName, isRootLockName } from '../../../infra/repository/RepositoryObjectNames';
import {
  resolveObjectScope,
  toPosixRel,
  type ObjectScope,
  type ScopeDepth,
} from '../../../infra/repository/RepositoryObjectScope';
import type { RepositoryNodeRef, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';
import { dumpConfigurationToTemp } from '../ext/ConfigurationDumpRunner';
import { notifyConfigurationOperationBusy } from '../ext/configurationOperationBusy';
import {
  executeRepositoryCli,
  resolveRepositoryTarget,
  type RepositoryCliRequest,
  type RepositoryCliResult,
  type RepositoryCliServices,
} from './RepositoryCommandRunner';
import {
  chooseConflictResolutionModal,
  confirmRollbackModal,
  getDirtyEditorFilePaths,
  isFileSyncOnLockUnlockEnabled,
  openMergeDiffs,
  showNotification,
  type ConflictSummary,
  type MergeDiffPair,
  type NotificationAction,
  type RollbackSummary,
} from './RepositoryFileSyncDialogs';

export type RepositoryFileSyncServices = Pick<
  CommandServices,
  | 'configurationOperationGuard'
  | 'workspaceFolder'
  | 'outputChannel'
  | 'repositoryService'
  | 'projectSecretStorage'
  | 'supportService'
  | 'suppressConfigurationReloadForFiles'
  | 'markChangedConfigurationByFiles'
  | 'treeProvider'
  | 'refreshActionsView'
  | 'reloadEntries'
>;

export type RepositoryFlowOutcome = 'done' | 'busy' | 'failed' | 'interrupted';

export interface RepositoryTempDump {
  dir: string;
  dispose(): void;
}

export type RepositoryDumpToTempResult = ({ ok: true } & RepositoryTempDump) | { ok: false; reason: string };

/**
 * Внешние точки потоков хранилища: процесс Конфигуратора, выгрузка и все диалоги.
 * Внедряются, чтобы порядок «аренда → release → диалог» проверялся без процесса 1С
 * и без модальных окон.
 */
export interface RepositoryFileSyncDeps {
  runRepositoryCli: (request: RepositoryCliRequest, services: RepositoryCliServices) => Promise<RepositoryCliResult>;
  dumpToTemp: (
    target: RepositoryTarget,
    request: ConfigurationDumpRequest,
    services: RepositoryFileSyncServices
  ) => Promise<RepositoryDumpToTempResult>;
  chooseConflictResolution: (summary: ConflictSummary) => Promise<MergeChoice>;
  confirmRollback: (summary: RollbackSummary) => Promise<boolean>;
  openDiffs: (pairs: MergeDiffPair[]) => void | Promise<void>;
  notifyBusy: (message: string) => void;
  notifyInfo: (message: string, actions?: readonly NotificationAction[]) => void;
  notifyWarning: (message: string) => void;
  notifyError: (message: string) => void;
  isFileSyncEnabled: () => boolean;
  /** Абсолютные пути файлов с несохранёнными изменениями в редакторах. */
  getDirtyFilePaths: () => readonly string[];
  now: () => Date;
}

/* c8 ignore start -- тонкие обёртки над vscode.window и запуском выгрузки; сами потоки
   проверяются тестами с внедрёнными deps, модальные диалоги — см. RepositoryFileSyncDialogs. */
async function dumpRepositoryTargetToTemp(
  target: RepositoryTarget,
  request: ConfigurationDumpRequest,
  services: RepositoryFileSyncServices
): Promise<RepositoryDumpToTempResult> {
  const result = await dumpConfigurationToTemp(
    { kind: target.configKind, name: target.displayName, rootPath: target.configRoot, extensionName: target.extensionName },
    request,
    services.workspaceFolder,
    services.outputChannel
  );
  return result.ok ? { ok: true, dir: result.handle.dir, dispose: () => result.handle.dispose() } : result;
}

export const DEFAULT_REPOSITORY_FILE_SYNC_DEPS: RepositoryFileSyncDeps = {
  runRepositoryCli: executeRepositoryCli,
  dumpToTemp: dumpRepositoryTargetToTemp,
  chooseConflictResolution: chooseConflictResolutionModal,
  confirmRollback: confirmRollbackModal,
  openDiffs: openMergeDiffs,
  notifyBusy: notifyConfigurationOperationBusy,
  notifyInfo: (message, actions) => showNotification((text, ...items) => vscode.window.showInformationMessage(text, ...items), message, actions),
  notifyWarning: (message) => showNotification((text, ...items) => vscode.window.showWarningMessage(text, ...items), message),
  notifyError: (message) => showNotification((text, ...items) => vscode.window.showErrorMessage(text, ...items), message),
  isFileSyncEnabled: isFileSyncOnLockUnlockEnabled,
  getDirtyFilePaths: getDirtyEditorFilePaths,
  now: () => new Date(),
};
/* c8 ignore stop */

/** Лимит вкладок сравнения за одну операцию: остальные файлы перечисляются в журнале. */
export const MAX_DIFF_TABS = 10;

function logFileSync(services: Pick<RepositoryFileSyncServices, 'outputChannel'>, message: string): void {
  services.outputChannel.appendLine(`[repository][file-sync] ${message}`);
}

function reportRepositoryBusy(
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  label: string,
  heldBy: string
): void {
  services.outputChannel.appendLine(`[repository][file-sync][busy] ${label}: пропущено, выполняется "${heldBy}"`);
  deps.notifyBusy(`${label}: уже выполняется операция "${heldBy}". Дождитесь её завершения.`);
}

/**
 * Предпроверка занятости до любых диалогов выбора режима: иначе пользователь
 * отвечал бы на вопросы ради операции, которая всё равно не сможет стартовать.
 * Guard не захватывается — окончательная проверка остаётся за `runExclusive`.
 */
export function ensureRepositoryGuardFree(
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  label: string
): boolean {
  const heldBy = services.configurationOperationGuard.heldBy;
  if (heldBy === undefined) {
    return true;
  }
  reportRepositoryBusy(services, deps, label, heldBy);
  return false;
}

/** Аренда guard'а на цепочку «Конфигуратор → состояние → выгрузка во temp». */
export async function runRepositoryExclusive<T>(
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  label: string,
  operation: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const result = await services.configurationOperationGuard.runExclusive(`Хранилище: ${label}`, operation);
  if (!result.acquired) {
    reportRepositoryBusy(services, deps, label, result.heldBy);
    return { acquired: false };
  }
  return result;
}

/** Сообщение об исходе Конфигуратора — только после освобождения guard'а. */
export function reportCliOutcome(
  result: Exclude<RepositoryCliResult, { status: 'done' }>,
  label: string,
  deps: RepositoryFileSyncDeps
): RepositoryFlowOutcome {
  if (result.status === 'interrupted') {
    deps.notifyWarning(`${label}: ${result.message}`);
    return 'interrupted';
  }
  deps.notifyError(`${label}: ${result.message}`);
  return 'failed';
}

export function reportFlowError(
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  label: string,
  error: unknown
): RepositoryFlowOutcome {
  const message = error instanceof Error ? error.message : String(error);
  services.outputChannel.appendLine(`[repository][file-sync][error] ${label}: ${message}`);
  deps.notifyError(`${label}: ${message}`);
  return 'failed';
}

/**
 * Что именно захватывается/освобождается узлом: якорь (fullName узла или сентинел
 * корня), состав по проекту, режим захвата и план выгрузки. Файл `Objects.xml` пишется
 * здесь, поэтому вызывается уже внутри аренды.
 */
export interface RepositorySubject {
  target: RepositoryTarget;
  objectsFile: string;
  anchor: string;
  members: string[];
  isRoot: boolean;
  /** Режим захвата единиц `members`: рекурсивный захватывает и подчинённые на сервере. */
  mode: RepositoryLockMode;
  plan: RepositoryDumpPlan;
}

export function resolveSubjectTarget(
  node: RepositoryNodeRef,
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps
): RepositoryTarget | null {
  const target = resolveRepositoryTarget(services.repositoryService, node);
  if (!target) {
    deps.notifyError('Не удалось определить конфигурацию для выбранного узла.');
  }
  return target;
}

export function prepareRepositorySubject(
  node: RepositoryNodeRef,
  recursive: boolean,
  target: RepositoryTarget,
  services: RepositoryFileSyncServices
): RepositorySubject {
  const objects = services.repositoryService.createObjectsFileForNode(node, recursive);
  const plan = buildRepositoryDumpPlan(node, objects, recursive, target.configRoot);
  const anchor = objects.fullNames[0];
  return {
    target,
    objectsFile: objects.filePath,
    anchor,
    members: plan.kind === 'objects' ? [...new Set([anchor, ...plan.fullNames])] : [anchor],
    isRoot: isRootLockName(anchor),
    mode: recursive ? 'recursive' : 'object',
    plan,
  };
}

/** Имя объекта в `-listFile`: корень представлен в state.json сентинелом, в выгрузке — именем. */
export function toDumpListName(fullName: string, target: RepositoryTarget): string {
  return isRootLockName(fullName) ? buildRootDumpListName(target) : fullName;
}

/**
 * Область единицы для слияния: сначала по проекту, иначе по выгрузке (единица новая
 * в хранилище и в проекте её ещё нет).
 */
export function resolveMergeScope(
  target: RepositoryTarget,
  fullName: string,
  dumpDir: string | undefined,
  depth: ScopeDepth
): ObjectScope | null {
  return resolveObjectScope(target.configRoot, fullName, target, depth)
    ?? (dumpDir ? resolveObjectScope(dumpDir, fullName, target, depth) : null);
}

export function isObjectMissingInProject(target: RepositoryTarget, fullName: string): boolean {
  return !isRootLockName(fullName) && resolveObjectScope(target.configRoot, fullName, target) === null;
}

export interface DumpScopeEntry {
  fullName: string;
  scope: ObjectScope;
}

/** Каталог выгрузки и области, которые из него сливаются в проект. */
export interface DumpMergeSource {
  dir: string;
  entries: DumpScopeEntry[];
  /** Объекты, удалённые из хранилища: их файлы проекта идут на удаление. */
  removed?: DumpScopeEntry[];
}

export interface PlannedMergeSource extends DumpMergeSource {
  plan: MergePlan;
}

export function loadBaseHashes(services: RepositoryFileSyncServices, target: RepositoryTarget): Record<string, string> {
  const scopeKey = buildScopeKey(target.configKind, target.configRoot, target.extensionName ?? '');
  return loadHashCache(services.workspaceFolder.uri.fsPath, scopeKey).files;
}

function toConfigRelativePaths(target: RepositoryTarget, filePaths: readonly string[]): string[] {
  const root = path.resolve(target.configRoot);
  return filePaths
    .map((filePath) => path.relative(root, path.resolve(filePath)))
    .filter((rel) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel))
    .map(toPosixRel);
}

/** Трёхсторонний план по каждому каталогу выгрузки (R — выгрузка, L — проект, B — хеш-кэш/снимок). */
export function planMergeSources(
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  target: RepositoryTarget,
  sources: readonly DumpMergeSource[]
): PlannedMergeSource[] {
  const baseHashes = loadBaseHashes(services, target);
  const snapshotHashes: Record<string, string> = {};
  for (const source of sources) {
    for (const entry of source.entries) {
      Object.assign(snapshotHashes, services.repositoryService.snapshots.readSnapshotHashes(target, entry.fullName) ?? {});
    }
  }
  const dirtyRelativePaths = toConfigRelativePaths(target, deps.getDirtyFilePaths());
  return sources.map((source) => ({
    ...source,
    plan: planRepositoryMerge(collectMergeFileStates({
      configRoot: target.configRoot,
      dumpDir: source.dir,
      scopes: source.entries.map((entry) => entry.scope),
      removedScopes: (source.removed ?? []).map((entry) => entry.scope),
      baseHashes,
      snapshotHashes,
      dirtyRelativePaths,
      requirePrimaryFile: true,
    })),
  }));
}

/** Ровно один модальный диалог на операцию и только при конфликтах. */
export async function resolveConflictChoice(
  deps: RepositoryFileSyncDeps,
  planned: readonly PlannedMergeSource[],
  operationLabel: string,
  objectLabel: string
): Promise<MergeChoice> {
  const conflicts = planned.flatMap((source) => source.plan.conflicts);
  if (conflicts.length === 0) {
    return 'replace';
  }
  const choice = await deps.chooseConflictResolution({
    operationLabel,
    objectLabel,
    conflictCount: conflicts.length,
    files: conflicts.map((entry) => entry.rel),
  });
  // Закрытие диалога без выбора трактуется как отказ от перезаписи.
  return choice === 'compare' || choice === 'replace' ? choice : 'keep-local';
}

export interface MergeApplicationRequest {
  target: RepositoryTarget;
  sources: readonly PlannedMergeSource[];
  choice: MergeChoice;
  backupDir: string;
  /** Объекты, появившиеся/исчезнувшие в хранилище, — для ChildObjects Configuration.xml. */
  childObjects?: { added: readonly string[]; removed: readonly string[] };
  /** Новый ConfigDumpInfo.xml: заменяет проектный после применения всех владельцев. */
  configDumpInfoSource?: string;
}

export interface MergeApplicationResult {
  merge: MergeApplyResult;
  changedFiles: string[];
}

export interface PostMutationRequest {
  changedFiles: readonly string[];
  /** Файлы, оставленные с расхождением от базы, — помечаются изменёнными. */
  keptDivergentFiles: readonly string[];
  /** Изменился состав объектов/Configuration.xml — нужен полный reloadEntries. */
  structural: boolean;
}

/**
 * Общий post-mutation путь без `changeDetector.detect()`: файлы пишет расширение само,
 * и хеш-кэш уже описывает состояние базы.
 */
export async function finishPostMutation(services: RepositoryFileSyncServices, request: PostMutationRequest): Promise<void> {
  const changed = [...request.changedFiles];
  if (changed.length > 0) {
    services.suppressConfigurationReloadForFiles(changed);
  }
  if (request.keptDivergentFiles.length > 0) {
    services.markChangedConfigurationByFiles([...request.keptDivergentFiles]);
  }
  if (request.structural) {
    await services.reloadEntries();
  } else if (changed.length > 0 && !services.treeProvider.refreshCacheForFiles(changed)) {
    services.treeProvider.refresh();
  }
  services.refreshActionsView();
}

function isConfigurationXml(target: RepositoryTarget, filePath: string): boolean {
  return path.resolve(filePath) === path.resolve(target.configRoot, 'Configuration.xml');
}

/**
 * Применяет планы слияния, синхронизирует ChildObjects и ConfigDumpInfo.xml и
 * проводит общий post-mutation путь.
 */
export async function applyMergeWithPostMutation(
  services: RepositoryFileSyncServices,
  request: MergeApplicationRequest
): Promise<MergeApplicationResult> {
  const { target } = request;
  const projectRoot = services.workspaceFolder.uri.fsPath;
  const merge: MergeApplyResult = { writtenFiles: [], deletedFiles: [], keptLocalFiles: [], backups: [], repositoryCopies: [] };
  let created = false;
  for (const source of request.sources) {
    // Новый файл объекта (форма, модуль, XML) меняет состав дерева — точечного обновления кэша мало.
    created ||= source.plan.entries.some((entry) => entry.localHash === null
      && (entry.action === 'write' || (entry.action === 'conflict-write' && request.choice !== 'keep-local')));
    const result = applyRepositoryMerge({
      projectRoot,
      target,
      dumpDir: source.dir,
      plan: source.plan,
      choice: request.choice,
      backupDir: request.backupDir,
      beforeWrite: (filePaths) => services.suppressConfigurationReloadForFiles(filePaths),
    });
    merge.writtenFiles.push(...result.writtenFiles);
    merge.deletedFiles.push(...result.deletedFiles);
    merge.keptLocalFiles.push(...result.keptLocalFiles);
    merge.backups.push(...result.backups);
    merge.repositoryCopies.push(...result.repositoryCopies);
  }
  const changedFiles = [...merge.writtenFiles, ...merge.deletedFiles];
  const childObjectsChanged = syncChildObjectsAfterMerge(services, target, request.childObjects);
  changedFiles.push(...childObjectsChanged);
  if (request.configDumpInfoSource && fs.existsSync(request.configDumpInfoSource)) {
    const projectDumpInfo = path.join(target.configRoot, path.basename(request.configDumpInfoSource));
    services.suppressConfigurationReloadForFiles([projectDumpInfo]);
    fs.copyFileSync(request.configDumpInfoSource, projectDumpInfo);
  }
  await finishPostMutation(services, {
    changedFiles,
    keptDivergentFiles: merge.keptLocalFiles,
    structural: created
      || merge.deletedFiles.length > 0
      || childObjectsChanged.length > 0
      || changedFiles.some((filePath) => isConfigurationXml(target, filePath)),
  });
  return { merge, changedFiles };
}

/**
 * Новые/удалённые в хранилище объекты верхнего уровня отражаются в ChildObjects.
 * Хеш Configuration.xml обновляется, только если файл был чист (совпадал с базой):
 * иначе в кэш попала бы локальная правка, которой в базе нет.
 */
function syncChildObjectsAfterMerge(
  services: RepositoryFileSyncServices,
  target: RepositoryTarget,
  changes: MergeApplicationRequest['childObjects']
): string[] {
  if (!changes) {
    return [];
  }
  const added = changes.added.filter((fullName) => resolveXmlPathByFullName(target.configRoot, fullName) !== null);
  const removed = changes.removed.filter((fullName) => resolveXmlPathByFullName(target.configRoot, fullName) === null);
  const configXmlPath = path.join(target.configRoot, 'Configuration.xml');
  if ((added.length === 0 && removed.length === 0) || !fs.existsSync(configXmlPath)) {
    return [];
  }
  const wasClean = loadBaseHashes(services, target)['Configuration.xml'] === computeFileHash(configXmlPath);
  services.suppressConfigurationReloadForFiles([configXmlPath]);
  const result = syncConfigurationChildObjects(target.configRoot, { added, removed });
  result.warnings.forEach((warning) => logFileSync(services, `ChildObjects: ${warning}`));
  if (result.changedFiles.length > 0 && wasClean) {
    patchHashCacheForFiles(
      services.workspaceFolder.uri.fsPath,
      target.configKind,
      target.configRoot,
      target.extensionName ?? '',
      ['Configuration.xml']
    );
  }
  return result.changedFiles;
}

export function buildOperationBackupDir(
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  target: RepositoryTarget,
  label: string
): string {
  return buildMergeBackupDir(services.workspaceFolder.uri.fsPath, buildRepositoryScopeKey(target), label, deps.now());
}

function isProjectFileWritable(services: RepositoryFileSyncServices, filePath: string): boolean {
  return !services.repositoryService.isEditRestricted(filePath) && !(services.supportService?.isLocked(filePath) ?? false);
}

/** Текстовые пары для сравнения (не больше лимита вкладок); остальное — в журнал. */
function selectDiffPairs(
  services: RepositoryFileSyncServices,
  candidates: readonly { rel: string; left: string; right: string }[],
  titleSuffix: string
): MergeDiffPair[] {
  const textual = candidates.filter((item) => isTextMergeFile(item.rel) && fs.existsSync(item.right));
  const skipped = candidates.filter((item) => !textual.includes(item)).map((item) => item.rel);
  const overflow = textual.slice(MAX_DIFF_TABS).map((item) => item.rel);
  if (skipped.length > 0 || overflow.length > 0) {
    logFileSync(services, `без окна сравнения (двоичные, удалённые или сверх лимита ${String(MAX_DIFF_TABS)}): ${[...skipped, ...overflow].join(', ')}`);
  }
  return textual.slice(0, MAX_DIFF_TABS).map((item) => ({
    title: `${path.posix.basename(item.rel)} (${titleSuffix})`,
    left: item.left,
    right: item.right,
    writable: isProjectFileWritable(services, item.right),
  }));
}

/**
 * Сообщения и сравнения после слияния — вне аренды. «Сравнить» открывает пары
 * «резервная копия ↔ файл проекта», keep-local — немодальное сообщение с кнопкой.
 */
export async function reportMergeOutcome(
  services: RepositoryFileSyncServices,
  deps: RepositoryFileSyncDeps,
  planned: readonly PlannedMergeSource[],
  applied: MergeApplicationResult,
  choice: MergeChoice,
  objectLabel: string
): Promise<void> {
  const skipped = planned.flatMap((source) => source.plan.skipped.map((entry) => entry.rel));
  if (skipped.length > 0) {
    logFileSync(services, `«${objectLabel}»: нет в выгрузке, локальные файлы не тронуты: ${skipped.join(', ')}`);
    deps.notifyWarning(
      `«${objectLabel}»: выгрузка из базы неполная, ${String(skipped.length)} файл(ов) оставлены без изменений (см. журнал).`
    );
  }
  const { merge } = applied;
  if (merge.backups.length > 0) {
    logFileSync(services, `резервные копии: ${merge.backups.map((backup) => backup.backupPath).join(', ')}`);
  }
  if (choice === 'compare') {
    const pairs = selectDiffPairs(
      services,
      merge.backups.map((backup) => ({ rel: backup.rel, left: backup.backupPath, right: backup.projectPath })),
      'мои изменения ↔ хранилище'
    );
    if (pairs.length > 0) {
      await deps.openDiffs(pairs);
    }
    return;
  }
  if (choice === 'keep-local' && merge.keptLocalFiles.length > 0) {
    const pairs = selectDiffPairs(
      services,
      merge.repositoryCopies.map((copy) => ({ rel: copy.rel, left: copy.repositoryPath, right: copy.projectPath })),
      'хранилище ↔ мои изменения'
    );
    const hint = pairs.some((pair) => !pair.writable) ? ' Захватите объект, чтобы перенести правки.' : '';
    deps.notifyInfo(
      `«${objectLabel}»: локальные файлы оставлены без изменений (${String(merge.keptLocalFiles.length)}), ` +
        `версия хранилища сохранена рядом с резервными копиями.${hint}`,
      pairs.length > 0 ? [{ label: 'Сравнить', run: () => { void deps.openDiffs(pairs); } }] : []
    );
  }
}
