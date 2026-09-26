import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getRepositoryUnitAncestors, getRootLockName, isRootLockName } from './RepositoryObjectNames';
import type { RepositoryTarget } from './RepositoryService';

/**
 * Состояние цели в `state.json`. Формат остаётся `version: 2`: новые поля
 * необязательны, поэтому файлы, записанные прежними версиями, читаются без потерь.
 *  - `rootRecursive` — рекурсивный захват корня: захваченным считается любой объект,
 *    кроме точечно освобождённых (`releasedUnderRoot`);
 *  - `lockGroups` — якорь рекурсивного захвата → его состав на момент захвата;
 *  - `lockModes` — режим последнего захвата единицы. Запись без режима (сделанная до
 *    появления единиц-подчинённых) по-прежнему покрывает подчинённых своего владельца.
 */
interface RepositoryScopeState {
  connected?: boolean;
  lockedFullNames: string[];
  rootRecursive?: boolean;
  lockGroups?: Record<string, string[]>;
  releasedUnderRoot?: string[];
  lockModes?: Record<string, RepositoryLockMode>;
}

export type RepositoryLockMode = 'recursive' | 'object';

interface RepositoryStateFile {
  version: 2;
  scopes: Record<string, RepositoryScopeState>;
}

export interface RepositoryLocksChangedEvent {
  readonly target: RepositoryTarget;
  /** Объекты, чьё состояние захвата изменила операция. */
  readonly fullNames: readonly string[];
  /**
   * Все объекты с явно известным состоянием захвата после операции (захваченные,
   * участники групп, точечно освобождённые) плюс `fullNames`. Потребитель
   * пересчитывает readonly по этому охвату, не перечитывая state.json.
   */
  readonly allObjects: readonly string[];
}

export type RepositoryLocksChangedListener = (event: RepositoryLocksChangedEvent) => void;

export interface RepositoryLockRequest {
  anchor: string;
  members: readonly string[];
  recursiveRoot?: boolean;
  /** Режим захвата для всех `members`; без него запись ведёт себя как старая. */
  mode?: RepositoryLockMode;
}

export interface RepositoryUnlockRequest {
  anchor: string;
  members: readonly string[];
  recursive: boolean;
  isRoot: boolean;
}

const REPOSITORY_STATE_VERSION = 2;

/** Ключ цели: общий для state.json, снимков, пароля хранилища и файлов Objects.xml. */
export function buildRepositoryScopeKey(target: RepositoryTarget): string {
  const raw = `${target.configKind}|${path.resolve(target.configRoot)}|${target.extensionName ?? ''}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * Локальное состояние захватов хранилища (`.v8vscedit/repository/state.json`) и
 * событие его изменения — источник для пересчёта readonly открытых редакторов.
 */
export class RepositoryLockState {
  private cache: { mtimeMs: number; value: RepositoryStateFile } | undefined;
  private readonly listeners = new Set<RepositoryLocksChangedListener>();

  constructor(private readonly workspaceRoot: string) {}

  isConnected(target: RepositoryTarget): boolean {
    return this.readScope(target)?.connected ?? true;
  }

  setConnected(target: RepositoryTarget, connected: boolean): void {
    this.updateScope(target, (scope) => ({ ...scope, connected }));
  }

  /** Заменяет состояние цели целиком (новая привязка хранилища начинается без захватов). */
  resetScope(target: RepositoryTarget, connected: boolean): void {
    this.updateScope(target, () => ({ connected, lockedFullNames: [] }));
  }

  clearScope(target: RepositoryTarget): void {
    const state = this.load();
    const scopeKey = buildRepositoryScopeKey(target);
    state.scopes = Object.fromEntries(Object.entries(state.scopes).filter(([key]) => key !== scopeKey));
    this.save(state);
  }

  isLocked(target: RepositoryTarget, fullName: string): boolean {
    const scope = this.readScope(target);
    if (!scope) {
      return false;
    }
    if (isLockedDirectly(scope, fullName)) {
      return true;
    }
    // Корень считается захваченным только явно: рекурсивный признак раскрывает
    // захват на объекты, но не заменяет собой запись корня.
    if (scope.rootRecursive === true && !isRootLockName(fullName) && !(scope.releasedUnderRoot ?? []).includes(fullName)) {
      return true;
    }
    // Старая запись владельца без режима: подчинённые раньше захватывались вместе с ним.
    return getRepositoryUnitAncestors(fullName)
      .some((ancestor) => isLockedDirectly(scope, ancestor) && scope.lockModes?.[ancestor] === undefined);
  }

  isRootLocked(target: RepositoryTarget): boolean {
    return this.readScope(target)?.lockedFullNames.includes(getRootLockName(target)) ?? false;
  }

  isRootRecursiveLocked(target: RepositoryTarget): boolean {
    return this.readScope(target)?.rootRecursive === true;
  }

  getLockGroup(target: RepositoryTarget, anchor: string): readonly string[] | undefined {
    return this.readScope(target)?.lockGroups?.[anchor];
  }

  applyLock(target: RepositoryTarget, request: RepositoryLockRequest): void {
    const members = [...new Set([request.anchor, ...request.members])];
    this.updateScope(target, (scope) => {
      const locked = new Set(scope.lockedFullNames);
      members.forEach((fullName) => locked.add(fullName));
      const lockGroups = { ...(scope.lockGroups ?? {}) };
      if (members.length > 1) {
        lockGroups[request.anchor] = sortNames(members);
      }
      const released = request.recursiveRoot
        ? []
        : (scope.releasedUnderRoot ?? []).filter((fullName) => !members.includes(fullName));
      const lockModes = withoutKeys(scope.lockModes, members);
      if (request.mode) {
        const mode = request.mode;
        members.forEach((fullName) => { lockModes[fullName] = mode; });
      }
      return {
        ...scope,
        lockedFullNames: sortNames([...locked]),
        rootRecursive: request.recursiveRoot ? true : scope.rootRecursive,
        lockGroups,
        releasedUnderRoot: released,
        lockModes,
      };
    });
    this.emit(target, members);
  }

  /**
   * Снимает захват и возвращает fullName, чьё состояние изменилось. Рекурсивная
   * отмена снимает группу якоря целиком (по составу на момент захвата и текущему
   * составу из XML — объекты могли быть включены или исключены). Нерекурсивная
   * отмена якоря группы убирает из неё только освобождённые единицы: подчинённые
   * на сервере остаются захваченными.
   */
  applyUnlock(target: RepositoryTarget, request: RepositoryUnlockRequest): string[] {
    let removed: string[] = [];
    this.updateScope(target, (scope) => {
      if (request.isRoot && request.recursive) {
        removed = sortNames([...new Set([...scope.lockedFullNames, ...request.members, request.anchor])]);
        return { connected: scope.connected, lockedFullNames: [] };
      }
      const affected = new Set<string>([request.anchor, ...request.members]);
      if (request.recursive) {
        (scope.lockGroups?.[request.anchor] ?? []).forEach((fullName) => affected.add(fullName));
      }
      const lockGroups: Record<string, string[]> = {};
      for (const [anchor, members] of Object.entries(scope.lockGroups ?? {})) {
        const rest = anchor !== request.anchor ? members : members.filter((fullName) => !request.recursive && !affected.has(fullName));
        if (rest.length > 0) {
          lockGroups[anchor] = rest;
        }
      }
      const released = new Set(scope.releasedUnderRoot ?? []);
      if (scope.rootRecursive && !request.isRoot) {
        affected.forEach((fullName) => released.add(fullName));
      }
      removed = sortNames([...affected]);
      return {
        ...scope,
        lockedFullNames: scope.lockedFullNames.filter((fullName) => !affected.has(fullName)),
        lockGroups,
        releasedUnderRoot: sortNames([...released]),
        lockModes: withoutKeys(scope.lockModes, [...affected]),
      };
    });
    this.emit(target, removed);
    return removed;
  }

  /** Совместимость с прежним API: явная установка/снятие захвата без групп. */
  setLocked(target: RepositoryTarget, fullNames: readonly string[], locked: boolean): void {
    if (fullNames.length === 0) {
      return;
    }
    this.updateScope(target, (scope) => {
      const items = new Set(scope.lockedFullNames);
      fullNames.forEach((fullName) => (locked ? items.add(fullName) : items.delete(fullName)));
      return { ...scope, lockedFullNames: sortNames([...items]) };
    });
    this.emit(target, fullNames);
  }

  onDidChangeLocks(listener: RepositoryLocksChangedListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private emit(target: RepositoryTarget, fullNames: readonly string[]): void {
    const scope = this.readScope(target);
    const allObjects = new Set<string>(fullNames);
    scope?.lockedFullNames.forEach((fullName) => allObjects.add(fullName));
    Object.values(scope?.lockGroups ?? {}).forEach((members) => members.forEach((fullName) => allObjects.add(fullName)));
    scope?.releasedUnderRoot?.forEach((fullName) => allObjects.add(fullName));
    const event: RepositoryLocksChangedEvent = { target, fullNames: [...fullNames], allObjects: sortNames([...allObjects]) };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Сбой подписчика (например, UI readonly) не должен отменять уже записанное
        // состояние захвата и мешать остальным подписчикам.
      }
    }
  }

  private readScope(target: RepositoryTarget): RepositoryScopeState | undefined {
    return this.load().scopes[buildRepositoryScopeKey(target)];
  }

  private updateScope(target: RepositoryTarget, update: (scope: RepositoryScopeState) => RepositoryScopeState): void {
    const state = this.load();
    const scopeKey = buildRepositoryScopeKey(target);
    state.scopes[scopeKey] = compactScope(update(state.scopes[scopeKey] ?? { lockedFullNames: [] }));
    this.save(state);
  }

  private getStateFilePath(): string {
    return path.join(this.workspaceRoot, '.v8vscedit', 'repository', 'state.json');
  }

  private load(): RepositoryStateFile {
    const filePath = this.getStateFilePath();
    const mtimeMs = getFileMtimeMs(filePath) ?? -1;
    if (this.cache?.mtimeMs === mtimeMs) {
      return this.cache.value;
    }
    const value = mtimeMs < 0 ? emptyState() : parseStateFile(filePath);
    this.cache = { mtimeMs, value };
    return value;
  }

  private save(state: RepositoryStateFile): void {
    const filePath = this.getStateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    // Файл только что записан; mtime отсутствует лишь при гонке с внешним удалением.
    /* c8 ignore next */
    this.cache = { mtimeMs: getFileMtimeMs(filePath) ?? Date.now(), value: state };
  }
}

function emptyState(): RepositoryStateFile {
  return { version: REPOSITORY_STATE_VERSION, scopes: {} };
}

function parseStateFile(filePath: string): RepositoryStateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return emptyState();
  }
  if (!isRecord(parsed) || parsed.version !== REPOSITORY_STATE_VERSION || !isRecord(parsed.scopes)) {
    return emptyState();
  }
  const scopes: Record<string, RepositoryScopeState> = {};
  for (const [key, raw] of Object.entries(parsed.scopes)) {
    if (isRecord(raw)) {
      scopes[key] = sanitizeScope(raw);
    }
  }
  return { version: REPOSITORY_STATE_VERSION, scopes };
}

/** Поля неверного типа отбрасываются: испорченная запись не должна ронять навигатор. */
function sanitizeScope(raw: Record<string, unknown>): RepositoryScopeState {
  const scope: RepositoryScopeState = { lockedFullNames: toStringArray(raw.lockedFullNames) ?? [] };
  if (typeof raw.connected === 'boolean') {
    scope.connected = raw.connected;
  }
  if (raw.rootRecursive === true) {
    scope.rootRecursive = true;
  }
  if (isRecord(raw.lockGroups)) {
    const lockGroups: Record<string, string[]> = {};
    for (const [anchor, members] of Object.entries(raw.lockGroups)) {
      const list = toStringArray(members);
      if (list) {
        lockGroups[anchor] = list;
      }
    }
    scope.lockGroups = lockGroups;
  }
  const released = toStringArray(raw.releasedUnderRoot);
  if (released) {
    scope.releasedUnderRoot = released;
  }
  if (isRecord(raw.lockModes)) {
    scope.lockModes = Object.fromEntries(
      Object.entries(raw.lockModes).filter((entry): entry is [string, RepositoryLockMode] => isLockMode(entry[1]))
    );
  }
  return scope;
}

function isLockMode(value: unknown): value is RepositoryLockMode {
  return value === 'recursive' || value === 'object';
}

/** Явный захват или участие в группе рекурсивного захвата. */
function isLockedDirectly(scope: RepositoryScopeState, fullName: string): boolean {
  return scope.lockedFullNames.includes(fullName)
    || Object.values(scope.lockGroups ?? {}).some((members) => members.includes(fullName));
}

function withoutKeys(record: Readonly<Record<string, RepositoryLockMode>> | undefined, keys: readonly string[]): Record<string, RepositoryLockMode> {
  return Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !keys.includes(key)));
}

/** Пустые необязательные поля не пишутся — state.json остаётся совместимым по виду со старым. */
function compactScope(scope: RepositoryScopeState): RepositoryScopeState {
  const result: RepositoryScopeState = { lockedFullNames: scope.lockedFullNames };
  if (scope.connected !== undefined) {
    result.connected = scope.connected;
  }
  if (scope.rootRecursive) {
    result.rootRecursive = true;
  }
  if (scope.lockGroups && Object.keys(scope.lockGroups).length > 0) {
    result.lockGroups = scope.lockGroups;
  }
  if (scope.releasedUnderRoot && scope.releasedUnderRoot.length > 0) {
    result.releasedUnderRoot = scope.releasedUnderRoot;
  }
  if (scope.lockModes && Object.keys(scope.lockModes).length > 0) {
    result.lockModes = scope.lockModes;
  }
  return result;
}

function toStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortNames(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right, 'ru'));
}

function getFileMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}
