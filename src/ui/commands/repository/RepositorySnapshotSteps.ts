import { describeFsError } from '../../../infra/repository/RepositoryTempCleanup';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices } from './RepositoryFileSyncShared';

/**
 * Снимок захвата — вспомогательный эталон для отката, а не часть операции хранилища:
 * его сбой (на Windows — EPERM при удалении каталога, который держит антивирус или
 * индексатор) не должен отменять уже выполненный захват/помещение/отмену захвата.
 * Шаг снимка выполняется best-effort: сбой становится строкой журнала и попадает в одно
 * сводное предупреждение после аренды.
 */

export type SnapshotStepKind = 'capture' | 'discard';

export interface SnapshotStepFailure {
  kind: SnapshotStepKind;
  /** fullName единицы или displayName цели (манифест корня, каталог всех снимков). */
  subject: string;
  /** Путь из `resolve*()` хранилища снимков — свой, а не из message ошибки Node. */
  location: string;
  reason: string;
  /** Остался снимок прошлого захвата: откат при отмене захвата пойдёт к устаревшей версии. */
  staleSnapshot: boolean;
}

export function trySnapshotStep(
  services: Pick<RepositoryFileSyncServices, 'outputChannel'>,
  kind: SnapshotStepKind,
  subject: string,
  location: string,
  step: () => void,
  isStale?: () => boolean
): SnapshotStepFailure | undefined {
  try {
    step();
    return undefined;
  } catch (error) {
    const failure: SnapshotStepFailure = {
      kind,
      subject,
      location,
      reason: describeFsError(error),
      staleSnapshot: isStale?.() ?? false,
    };
    services.outputChannel.appendLine(`[repository][file-sync][warn] ${describeFailure(failure)}`);
    return failure;
  }
}

function describeFailure(failure: SnapshotStepFailure): string {
  const head = `снимок «${failure.subject}» ${failure.kind === 'capture' ? 'не сохранён' : 'не удалён'} (${failure.location}): ${failure.reason}`;
  if (failure.kind === 'discard') {
    return head;
  }
  return failure.staleSnapshot
    ? `${head} — остался снимок прошлого захвата, удалите каталог вручную`
    : `${head} — при отмене захвата версия хранилища будет выгружена заново`;
}

type SnapshotStepServices = Pick<RepositoryFileSyncServices, 'outputChannel' | 'repositoryService'>;

/**
 * Снятие снимка единицы. Устаревшим он считается, если после сбоя манифест всё ещё читается:
 * значит, не удалось удалить даже манифест прошлого захвата.
 */
export function captureUnitSnapshotStep(
  services: SnapshotStepServices,
  target: RepositoryTarget,
  fullName: string,
  step: () => void
): SnapshotStepFailure[] {
  const snapshots = services.repositoryService.snapshots;
  const failure = trySnapshotStep(
    services,
    'capture',
    fullName,
    snapshots.resolveSnapshotDir(target, fullName),
    step,
    () => snapshots.readSnapshotInfo(target, fullName) !== undefined
  );
  return failure ? [failure] : [];
}

/** Хеш-манифест рекурсивно захваченного корня — тот же best-effort, что и снимок единицы. */
export function captureRootManifestStep(
  services: SnapshotStepServices,
  target: RepositoryTarget,
  step: () => void
): SnapshotStepFailure[] {
  const snapshots = services.repositoryService.snapshots;
  const failure = trySnapshotStep(
    services,
    'capture',
    target.displayName,
    snapshots.resolveRootManifestPath(target),
    step,
    () => snapshots.readRootManifestHashes(target) !== undefined
  );
  return failure ? [failure] : [];
}

/** Одно предупреждение на операцию; подробности по каждому снимку — в журнале. */
export function reportSnapshotFailures(
  deps: Pick<RepositoryFileSyncDeps, 'notifyWarning'>,
  objectLabel: string,
  failures: readonly SnapshotStepFailure[]
): void {
  if (failures.length === 0) {
    return;
  }
  const captured = failures.filter((failure) => failure.kind === 'capture').length;
  const discarded = failures.length - captured;
  const parts = [
    ...(captured > 0 ? [`не сохранено снимков захвата: ${String(captured)}`] : []),
    ...(discarded > 0 ? [`не удалено снимков захвата: ${String(discarded)}`] : []),
  ];
  const stale = failures.filter((failure) => failure.staleSnapshot).map((failure) => failure.location);
  const staleHint = stale.length > 0
    ? `; снимок прошлого захвата устарел — откат при отмене захвата вернёт его версию, удалите вручную: ${stale.join(', ')}`
    : '';
  deps.notifyWarning(
    `«${objectLabel}»: ${parts.join(', ')} — операция с хранилищем выполнена${staleHint}. Подробности — в журнале «1С Редактор».`
  );
}
