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
 *    появления единиц-подчинённых) по-прежнему покрывает подчинённых своего владельца;
 *  - `foreignLocks`/`serverOwnLocks`/`lockSync` — статусы захватов с сервера (issue #6).
 *    Чужой захват сильнее локальной записи: объект не редактируется, но запись и снимок
 *    захвата сохраняются — решает пользователь штатными командами.
 */
interface RepositoryScopeState {
  connected?: boolean;
  lockedFullNames: string[];
  rootRecursive?: boolean;
  lockGroups?: Record<string, string[]>;
  releasedUnderRoot?: string[];
  lockModes?: Record<string, RepositoryLockMode>;
  /** Чужие захваты по последнему опросу сервера и по отказам захвата (issue #6). */
  foreignLocks?: Record<string, RepositoryLockHolder>;
  /** Захваты нашего пользователя по данным сервера — в том числе сделанные вне проекта. */
  serverOwnLocks?: Record<string, { lockedAt?: string }>;
  lockSync?: { syncedAt: string; user: string; serverVersion?: string };
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
  /**
   * Единицы, в захвате которых сервер отказал (частичный отказ, issue #87): не
   * записываются даже якорем; при recursiveRoot — в releasedUnderRoot.
   */
  refused?: readonly string[];
}

export interface RepositoryUnlockRequest {
  anchor: string;
  members: readonly string[];
  recursive: boolean;
  isRoot: boolean;
}

/** Держатель захвата на сервере: пользователь, время захвата (опрос) или время отказа захвата. */
export interface RepositoryLockHolder {
  readonly user: string;
  readonly lockedAt?: string;
  readonly observedAt?: string;
}

export type RepositoryLockInfo =
  | { readonly state: 'free' }
  | { readonly state: 'own'; readonly user?: string; readonly lockedAt?: string; readonly confirmed?: boolean; readonly syncedAt?: string }
  | { readonly state: 'own-elsewhere'; readonly user: string; readonly lockedAt?: string }
  | { readonly state: 'foreign'; readonly user: string; readonly lockedAt?: string; readonly observedAt?: string };

export interface RepositoryServerLockSync {
  readonly user: string;
  readonly syncedAt: string;
  readonly serverVersion?: string;
  /** Ревизия состояния на момент начала опроса: изменилась — результат устарел. */
  readonly basedOnRevision: number;
  readonly foreign: Readonly<Record<string, RepositoryLockHolder>>;
  readonly own: Readonly<Record<string, { lockedAt?: string }>>;
}

export interface RepositoryServerLockApplyResult {
  changed: string[];
  ownElsewhere: string[];
  unconfirmed: string[];
}

/** Локальное время `YYYY-MM-DDTHH:mm:ss` — в том же виде, в каком сервер отдаёт время захвата. */
export function toLocalTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
  /**
   * Счётчик записей состояния в этом процессе: опрос сервера сверяет его до и после
   * чтения, чтобы не затереть захват, сделанный во время опроса.
   */
  private revision = 0;

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
    return scope !== undefined && !isForeignLocked(scope, fullName) && isLockedLocally(scope, fullName);
  }

  isRootLocked(target: RepositoryTarget): boolean {
    const scope = this.readScope(target);
    const root = getRootLockName(target);
    return scope !== undefined && !isForeignLocked(scope, root) && scope.lockedFullNames.includes(root);
  }

  isRootRecursiveLocked(target: RepositoryTarget): boolean {
    return this.readScope(target)?.rootRecursive === true;
  }

  getLockGroup(target: RepositoryTarget, anchor: string): readonly string[] | undefined {
    return this.readScope(target)?.lockGroups?.[anchor];
  }

  applyLock(target: RepositoryTarget, request: RepositoryLockRequest): void {
    const refused = new Set(request.refused ?? []);
    const members = [...new Set([request.anchor, ...request.members])].filter((fullName) => !refused.has(fullName));
    this.updateScope(target, (scope) => {
      const locked = new Set(scope.lockedFullNames);
      members.forEach((fullName) => locked.add(fullName));
      const lockGroups = { ...(scope.lockGroups ?? {}) };
      if (members.length > 1) {
        lockGroups[request.anchor] = sortNames(members);
      }
      const kept = (scope.releasedUnderRoot ?? []).filter((fullName) => !members.includes(fullName));
      // Рекурсивный корень покрывает всё, кроме освобождённых: отказанные сервером единицы
      // обязаны остаться вне захвата, поэтому прежний список не обнуляется, а дополняется.
      const released = !request.recursiveRoot
        ? kept
        : refused.size === 0
          ? []
          : sortNames([...new Set([...kept, ...[...refused].filter((fullName) => !isRootLockName(fullName))])]);
      const lockModes = withoutKeys(scope.lockModes, members);
      if (request.mode) {
        const mode = request.mode;
        members.forEach((fullName) => { lockModes[fullName] = mode; });
      }
      // Сервер только что выдал захват: чужая отметка устарела, а свой захват подтверждён
      // (иначе до следующего опроса узел показывал бы «сервер не подтверждает»).
      const serverOwnLocks = { ...(scope.serverOwnLocks ?? {}) };
      if (scope.lockSync) {
        members.forEach((fullName) => { serverOwnLocks[fullName] = serverOwnLocks[fullName] ?? {}; });
      }
      return {
        ...scope,
        lockedFullNames: sortNames([...locked]),
        rootRecursive: request.recursiveRoot ? true : scope.rootRecursive,
        lockGroups,
        releasedUnderRoot: released,
        lockModes,
        foreignLocks: withoutKeys(scope.foreignLocks, members),
        serverOwnLocks,
      };
    });
    this.emit(target, members);
  }

  /**
   * Снимает захват и возвращает fullName, чьё состояние изменилось. Рекурсивная
   * отмена снимает группу якоря целиком (по составу на момент захвата и текущему
   * составу из XML — объекты могли быть включены или исключены). Нерекурсивная
   * отмена якоря группы убирает из неё только освобождённые единицы: подчинённые
   * на сервере остаются захваченными. Освобождённые единицы уходят и из групп
   * с чужим якорем: сервер их освободил, и оставшаяся запись в чужой группе
   * продолжала бы показывать их захваченными.
   */
  applyUnlock(target: RepositoryTarget, request: RepositoryUnlockRequest): string[] {
    let removed: string[] = [];
    this.updateScope(target, (scope) => {
      if (request.isRoot && request.recursive) {
        removed = sortNames([...new Set([...scope.lockedFullNames, ...request.members, request.anchor])]);
        // Данные опроса не относятся к локальным захватам: чужие захваты остаются в силе.
        return {
          connected: scope.connected,
          lockedFullNames: [],
          foreignLocks: scope.foreignLocks,
          serverOwnLocks: withoutKeys(scope.serverOwnLocks, removed),
          lockSync: scope.lockSync,
        };
      }
      const affected = new Set<string>([request.anchor, ...request.members]);
      if (request.recursive) {
        (scope.lockGroups?.[request.anchor] ?? []).forEach((fullName) => affected.add(fullName));
      }
      const lockGroups: Record<string, string[]> = {};
      for (const [anchor, members] of Object.entries(scope.lockGroups ?? {})) {
        const rest = anchor !== request.anchor
          ? members.filter((fullName) => !affected.has(fullName))
          : members.filter((fullName) => !request.recursive && !affected.has(fullName));
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
        serverOwnLocks: withoutKeys(scope.serverOwnLocks, [...affected]),
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
      return {
        ...scope,
        lockedFullNames: sortNames([...items]),
        serverOwnLocks: locked ? scope.serverOwnLocks : withoutKeys(scope.serverOwnLocks, fullNames),
      };
    });
    this.emit(target, fullNames);
  }

  getRevision(): number {
    return this.revision;
  }

  /** Версия сервера последнего успешного опроса — первая попытка рукопожатия следующего. */
  getServerVersion(target: RepositoryTarget): string | undefined {
    return this.readScope(target)?.lockSync?.serverVersion;
  }

  /**
   * Состояние захвата объекта для отображения. Порядок: чужой захват сильнее локального;
   * локальный — подтверждён сервером или нет (если опрос был); захват нашего
   * пользователя только на сервере — `own-elsewhere`.
   */
  getLockInfo(target: RepositoryTarget, fullName: string): RepositoryLockInfo {
    const scope = this.readScope(target);
    if (!scope) {
      return { state: 'free' };
    }
    const foreign = scope.foreignLocks?.[fullName];
    if (foreign) {
      return { state: 'foreign', user: foreign.user, lockedAt: foreign.lockedAt, observedAt: foreign.observedAt };
    }
    const serverOwn = scope.serverOwnLocks?.[fullName];
    const sync = scope.lockSync;
    if (isLockedLocally(scope, fullName)) {
      if (!sync) {
        return { state: 'own' };
      }
      return serverOwn
        ? { state: 'own', user: sync.user, lockedAt: serverOwn.lockedAt, confirmed: true, syncedAt: sync.syncedAt }
        : { state: 'own', user: sync.user, confirmed: false, syncedAt: sync.syncedAt };
    }
    return serverOwn && sync ? { state: 'own-elsewhere', user: sync.user, lockedAt: serverOwn.lockedAt } : { state: 'free' };
  }

  /**
   * Результат опроса сервера целиком заменяет чужие и свои серверные захваты цели.
   * `null` — состояние менялось во время опроса (ревизия), результат устарел.
   */
  applyServerLocks(target: RepositoryTarget, sync: RepositoryServerLockSync): RepositoryServerLockApplyResult | null {
    if (sync.basedOnRevision !== this.revision) {
      return null;
    }
    const before = this.readScope(target);
    const foreign = { ...sync.foreign };
    const own = { ...sync.own };
    let scope: RepositoryScopeState = { lockedFullNames: [] };
    this.updateScope(target, (current) => {
      scope = {
        ...current,
        foreignLocks: foreign,
        serverOwnLocks: own,
        lockSync: { syncedAt: sync.syncedAt, user: sync.user, serverVersion: sync.serverVersion },
      };
      return scope;
    });
    const changed = sortNames([...new Set([
      ...changedKeys(before?.foreignLocks, foreign),
      ...changedKeys(before?.serverOwnLocks, own),
    ])]);
    const localNames = collectLocalLockNames(scope);
    const result: RepositoryServerLockApplyResult = {
      changed,
      ownElsewhere: sortNames(Object.keys(own).filter((fullName) => !isLockedLocally(scope, fullName))),
      unconfirmed: sortNames(localNames.filter((fullName) => !(fullName in own) && !(fullName in foreign))),
    };
    this.emit(target, changed);
    return result;
  }

  /**
   * Отметки «захвачено другим» из вывода отказа захвата. Время захвата пакетный режим не
   * выводит: у того же держателя сохраняется время из опроса, у нового — только `observedAt`.
   */
  applyLockRefusals(target: RepositoryTarget, refusals: readonly { fullName: string; user: string }[], observedAt: string): string[] {
    if (refusals.length === 0) {
      return [];
    }
    this.updateScope(target, (scope) => {
      const foreignLocks = { ...(scope.foreignLocks ?? {}) };
      for (const refusal of refusals) {
        const known = foreignLocks[refusal.fullName] as RepositoryLockHolder | undefined;
        foreignLocks[refusal.fullName] = known?.user === refusal.user
          ? { ...known, observedAt }
          : { user: refusal.user, observedAt };
      }
      return { ...scope, foreignLocks };
    });
    const changed = sortNames([...new Set(refusals.map((refusal) => refusal.fullName))]);
    this.emit(target, changed);
    return changed;
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
    Object.keys(scope?.foreignLocks ?? {}).forEach((fullName) => allObjects.add(fullName));
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
    this.revision += 1;
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
  if (isRecord(raw.foreignLocks)) {
    scope.foreignLocks = sanitizeRecord(raw.foreignLocks, (value) =>
      isRecord(value) && typeof value.user === 'string'
        ? { user: value.user, ...optionalText('lockedAt', value.lockedAt), ...optionalText('observedAt', value.observedAt) }
        : undefined);
  }
  if (isRecord(raw.serverOwnLocks)) {
    scope.serverOwnLocks = sanitizeRecord(raw.serverOwnLocks, (value) =>
      isRecord(value) ? optionalText('lockedAt', value.lockedAt) : undefined);
  }
  const sync = raw.lockSync;
  if (isRecord(sync) && typeof sync.syncedAt === 'string' && typeof sync.user === 'string') {
    scope.lockSync = { syncedAt: sync.syncedAt, user: sync.user, ...optionalText('serverVersion', sync.serverVersion) };
  }
  return scope;
}

function sanitizeRecord<T>(raw: Record<string, unknown>, sanitize: (value: unknown) => T | undefined): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    const item = sanitize(value);
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

function optionalText<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === 'string' ? ({ [key]: value } as Partial<Record<K, string>>) : {};
}

/** Имена с явной локальной записью захвата (без раскрытия рекурсивного корня). */
function collectLocalLockNames(scope: RepositoryScopeState): string[] {
  return [...new Set([...scope.lockedFullNames, ...Object.values(scope.lockGroups ?? {}).flat()])];
}

/** Ключи, у которых значение появилось, исчезло или изменилось. */
function changedKeys(before: Readonly<Record<string, unknown>> | undefined, after: Readonly<Record<string, unknown>>): string[] {
  const previous = before ?? {};
  return [...new Set([...Object.keys(previous), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(after[key]));
}

function isForeignLocked(scope: RepositoryScopeState, fullName: string): boolean {
  return scope.foreignLocks?.[fullName] !== undefined;
}

/** Локальный захват без учёта чужих: явная запись, рекурсивный корень или старая запись владельца. */
function isLockedLocally(scope: RepositoryScopeState, fullName: string): boolean {
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

function isLockMode(value: unknown): value is RepositoryLockMode {
  return value === 'recursive' || value === 'object';
}

/** Явный захват или участие в группе рекурсивного захвата. */
function isLockedDirectly(scope: RepositoryScopeState, fullName: string): boolean {
  return scope.lockedFullNames.includes(fullName)
    || Object.values(scope.lockGroups ?? {}).some((members) => members.includes(fullName));
}

function withoutKeys<T>(record: Readonly<Record<string, T>> | undefined, keys: readonly string[]): Record<string, T> {
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
  if (scope.foreignLocks && Object.keys(scope.foreignLocks).length > 0) {
    result.foreignLocks = scope.foreignLocks;
  }
  if (scope.serverOwnLocks && Object.keys(scope.serverOwnLocks).length > 0) {
    result.serverOwnLocks = scope.serverOwnLocks;
  }
  if (scope.lockSync) {
    result.lockSync = scope.lockSync;
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
