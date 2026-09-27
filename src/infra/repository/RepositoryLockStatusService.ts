import * as fs from 'fs';
import * as path from 'path';
import { parseConfigDumpInfoUnitIds } from '../xml/ConfigDumpInfoReader';
import { FileRepositoryLockStatusSource } from './FileRepositoryLockStatusSource';
import { NetworkRepositoryLockStatusSource } from './NetworkRepositoryLockStatusSource';
import { toLocalTimestamp, type RepositoryLockHolder, type RepositoryLockState } from './RepositoryLockState';
import {
  classifyRepositoryLocation,
  RepositoryLockStatusError,
  type RepositoryLockStatusErrorCode,
  type RepositoryLockStatusSource,
  type RepositoryServerLockRecord,
} from './RepositoryLockStatusSource';
import { dumpInfoOwnerToRepositoryFullName } from './RepositoryObjectNames';
import type { RepositoryBinding, RepositoryTarget } from './RepositoryService';

export interface RepositoryLockStatusServiceDeps {
  readonly workspaceRoot: string;
  readonly lockState: RepositoryLockState;
  isConnected(target: RepositoryTarget): boolean;
  /** Привязка с паролем из SecretStorage (пароль живёт только в памяти). */
  resolveBinding(target: RepositoryTarget): Promise<RepositoryBinding | null>;
  readPlatformVersionHint(): string | undefined;
  now(): Date;
}

/** Версия для первого вызова сервера, когда ни опрос, ни env.json её не подсказали. */
export const DEFAULT_CRS_VERSION_HINT = '8.3.27.0';

export type RepositoryLockStatusSyncResult =
  | { status: 'synced'; foreign: number; own: number; unmatched: number; changed: string[]; ownElsewhere: string[]; unconfirmed: string[] }
  | { status: 'not-connected' }
  | { status: 'stale' }
  | { status: 'failed'; code: RepositoryLockStatusErrorCode | 'no-dump-info' | 'unknown'; reason: string };

/**
 * Опрос статусов захвата цели: привязка → вид хранилища → источник → имена единиц по
 * ConfigDumpInfo.xml цели → свои/чужие захваты в state.json. Никогда не бросает: любой
 * сбой — `failed` с причиной, чтобы автообновление при старте не роняло активацию.
 */
export class RepositoryLockStatusService {
  constructor(
    private readonly deps: RepositoryLockStatusServiceDeps,
    private readonly sources: readonly RepositoryLockStatusSource[] = [new FileRepositoryLockStatusSource(), new NetworkRepositoryLockStatusSource()]
  ) {}

  async syncTarget(target: RepositoryTarget): Promise<RepositoryLockStatusSyncResult> {
    try {
      const binding = this.deps.isConnected(target) ? await this.deps.resolveBinding(target) : null;
      if (!binding) {
        return { status: 'not-connected' };
      }
      const location = classifyRepositoryLocation(binding.repoPath, this.deps.workspaceRoot);
      const source = this.sources.find((candidate) => candidate.supports(location));
      if (!source) {
        return { status: 'failed', code: 'invalid-address', reason: `Неизвестный вид адреса хранилища: ${binding.repoPath}` };
      }
      const { lockState } = this.deps;
      const revision = lockState.getRevision();
      const platformVersionHint = lockState.getServerVersion(target)
        ?? this.deps.readPlatformVersionHint()
        ?? DEFAULT_CRS_VERSION_HINT;
      const result = await source.readLocks(location, { user: binding.repoUser, password: binding.repoPassword, platformVersionHint });
      const dumpInfo = await readDumpInfo(target);
      if (dumpInfo === null) {
        return {
          status: 'failed',
          code: 'no-dump-info',
          reason: `Нет ConfigDumpInfo.xml в ${target.configRoot}: без него захваты не сопоставить с объектами выгрузки.`,
        };
      }
      const user = binding.repoUser.trim();
      const mapped = mapServerLocksToUnits(result.records, parseConfigDumpInfoUnitIds(dumpInfo), target, user);
      const applied = lockState.applyServerLocks(target, {
        user,
        syncedAt: toLocalTimestamp(this.deps.now()),
        serverVersion: result.serverVersion,
        basedOnRevision: revision,
        foreign: mapped.foreign,
        own: mapped.own,
      });
      if (!applied) {
        return { status: 'stale' };
      }
      return {
        status: 'synced',
        foreign: Object.keys(mapped.foreign).length,
        own: Object.keys(mapped.own).length,
        unmatched: mapped.unmatched,
        ...applied,
      };
    } catch (error) {
      return error instanceof RepositoryLockStatusError
        ? { status: 'failed', code: error.code, reason: error.message }
        : { status: 'failed', code: 'unknown', reason: String(error) };
    }
  }
}

/**
 * Захваты сервера → единицы выгрузки: uuid → имя записи ConfigDumpInfo.xml → fullName.
 * Объекты, которых нет в выгрузке проекта, считаются в `unmatched` и пропускаются. Имя
 * пользователя сравнивается без учёта регистра и крайних пробелов (collation CI у USERS.NAME).
 */
export function mapServerLocksToUnits(
  records: readonly RepositoryServerLockRecord[],
  unitIds: ReadonlyMap<string, string>,
  target: RepositoryTarget,
  selfUser: string
): { foreign: Record<string, RepositoryLockHolder>; own: Record<string, { lockedAt?: string }>; unmatched: number } {
  const self = normalizeUser(selfUser);
  const foreign: Record<string, RepositoryLockHolder> = {};
  const own: Record<string, { lockedAt?: string }> = {};
  let unmatched = 0;
  for (const record of records) {
    const owner = unitIds.get(record.objectId.toLowerCase());
    const fullName = owner ? dumpInfoOwnerToRepositoryFullName(owner, target) : null;
    if (!fullName) {
      unmatched += 1;
    } else if (normalizeUser(record.user) === self) {
      own[fullName] = { lockedAt: record.lockedAt };
    } else {
      foreign[fullName] = { user: record.user, lockedAt: record.lockedAt };
    }
  }
  return { foreign, own, unmatched };
}

function normalizeUser(user: string): string {
  return user.trim().toLowerCase();
}

async function readDumpInfo(target: RepositoryTarget): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(target.configRoot, 'ConfigDumpInfo.xml'), 'utf-8');
  } catch {
    return null;
  }
}
