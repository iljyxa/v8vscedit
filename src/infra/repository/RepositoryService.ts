import * as fs from 'fs';
import * as path from 'path';
import type { MetaKind } from '../../domain/MetaTypes';
import type { ProjectSecretStorage } from '../environment/ProjectSecretStorage';
import { findObjectXmlInFolder } from '../fs/ObjectLocation';
import { escapeXmlAttribute as escapeXml, parseConfigXml, parseObjectXml } from '../xml';
import { RepositoryBindingStore } from './RepositoryBindingStore';
import { buildRepositoryScopeKey, RepositoryLockState } from './RepositoryLockState';
import { RepositoryLockSnapshotStore } from './RepositoryLockSnapshotStore';
import {
  getRootLockName,
  isRepositorySubordinateTag,
  ONE_C_TYPE_NAMES,
  parseRepositoryUnit,
  subordinateUnitFullName,
} from './RepositoryObjectNames';
import type { RepositorySubordinateTag } from './RepositoryObjectNames';
import { resolveLockUnitByRelativePath, resolveUnitSuffixByRelativePath } from './RepositoryObjectScope';

export interface RepositoryBinding {
  repoPath: string;
  repoUser: string;
  /** Пароль используется только в памяти для текущего запуска команды; в `env.json` не сохраняется. */
  repoPassword: string;
}

/**
 * Привязка хранилища, как она отдаётся наружу (в webview) после чтения из
 * `env.json`. Пароль сюда не попадает — он хранится в `ProjectSecretStorage`.
 */
export interface StoredRepositoryBinding {
  repoPath: string;
  repoUser: string;
}

export interface RepositoryTarget {
  configRoot: string;
  configKind: 'cf' | 'cfe';
  extensionName?: string;
  displayName: string;
}

export interface RepositoryNodeRef {
  nodeKind?: string;
  label?: string;
  xmlPath?: string;
  metaContext?: {
    rootMetaKind: string;
    tabularSectionName?: string;
    ownerObjectXmlPath?: string;
  };
}

/**
 * Событие изменения захватов в том виде, в каком его получают подписчики фасада:
 * им (например, контроллеру readonly редакторов) нужен только корень цели.
 */
export interface RepositoryLocksChangedNotice {
  readonly target: { readonly configRoot: string };
  readonly fullNames: readonly string[];
  readonly allObjects: readonly string[];
}

interface CachedFileValue<T> {
  mtimeMs: number;
  value: T;
}

interface CachedTarget {
  mtimeMs: number;
  target: RepositoryTarget | null;
}

const REPOSITORY_NAMESPACE = 'http://v8.1c.ru/8.3/config/objects';

/**
 * Виды дочерних узлов (ChildTag + Column), у которых нет собственного XML корневого
 * объекта и полное имя выводится из владельца. Подчинённые с собственным объектом
 * хранилища (`REPOSITORY_SUBORDINATE_LAYOUT`: формы, макеты) адресуются своей единицей
 * `Владелец.Форма.Имя`, так как нерекурсивный захват владельца их не захватывает;
 * остальные (реквизиты, ТЧ, команды и т.п.) хранятся внутри объекта и адресуются владельцем.
 */
const CHILD_LIKE_KINDS: ReadonlySet<string> = new Set([
  'Attribute',
  'AddressingAttribute',
  'TabularSection',
  'Form',
  'Command',
  'Template',
  'Dimension',
  'Resource',
  'EnumValue',
  'Column',
]);

/**
 * Виды узлов, у которых нет собственного XML-файла объекта: корень конфигурации/расширения
 * и узлы группировки дерева. У них не бывает полного имени объекта (`resolveFullName`).
 */
const ROOT_OR_GROUP_KINDS_WITHOUT_OWN_XML: ReadonlySet<string> = new Set([
  'configuration',
  'extension',
  'extensions-root',
  'group-common',
  'group-type',
  'NumeratorsBranch',
  'SequencesBranch',
]);

/**
 * Узел — самостоятельная подчинённая единица хранилища (`Владелец.Форма.Имя`,
 * `Владелец.Макет.Имя`), а не часть XML владельца. Правило совпадает с тем, по
 * которому `resolveFullName` строит полное имя единицы: захват такой единицы
 * независим от нерекурсивного захвата владельца, поэтому признак редактируемости
 * её содержимого нужно считать по ней самой. Чистая функция без I/O — годится для
 * hot path дерева.
 */
export function isSubordinateUnitNode(node: Pick<RepositoryNodeRef, 'nodeKind' | 'metaContext'>): boolean {
  const kind = node.nodeKind;
  return kind !== undefined
    && CHILD_LIKE_KINDS.has(kind)
    && isRepositorySubordinateTag(kind)
    && Boolean(node.metaContext?.ownerObjectXmlPath);
}

/**
 * Фасад хранилища для команд и UI: резолвинг цели по файлам выгрузки, привязка
 * (`RepositoryBindingStore`), состояние захватов (`RepositoryLockState`), снимки
 * захвата (`RepositoryLockSnapshotStore`) и генерация `Objects.xml`.
 */
export class RepositoryService {
  private readonly targetCache = new Map<string, CachedTarget>();
  private readonly rootFullNameCache = new Map<string, CachedFileValue<string | null>>();
  /**
   * Кэш `findConfigRoot` по нормализованному ключу директории. Каждый
   * `xmlPath` в `getTreeItem` без кэша требовал бы 1 `statSync` + цепочку
   * `existsSync` вверх до корня workspace — десятки тысяч syscall на
   * 10000 видимых узлов. Кэш заполняется на ходу: при подъёме по дереву
   * каждая промежуточная директория получает свою запись. Инвалидация
   * выполняется через `invalidateConfigRootCache()` из reloadEntries.
   */
  private readonly configRootByDirCache = new Map<string, string | null>();
  private readonly bindings: RepositoryBindingStore;
  private readonly lockStateStore: RepositoryLockState;
  private readonly snapshotStore: RepositoryLockSnapshotStore;

  constructor(
    private readonly workspaceRoot: string,
    secrets: ProjectSecretStorage
  ) {
    this.bindings = new RepositoryBindingStore(workspaceRoot, secrets);
    this.lockStateStore = new RepositoryLockState(workspaceRoot);
    this.snapshotStore = new RepositoryLockSnapshotStore(workspaceRoot);
  }

  get lockState(): RepositoryLockState {
    return this.lockStateStore;
  }

  get snapshots(): RepositoryLockSnapshotStore {
    return this.snapshotStore;
  }

  /**
   * Сбрасывает кэш `findConfigRoot`. Вызывается при изменении набора
   * корней конфигураций (`reloadEntries`/`updateEntries`).
   */
  invalidateConfigRootCache(): void {
    this.configRootByDirCache.clear();
  }

  /**
   * Возвращает количество записей в кэше `findConfigRoot`. Нужно тестам
   * для проверки того, что мемоизация действительно работает (модуль `fs`
   * в тест-окружении не подменяется через `Object.defineProperty`).
   */
  getConfigRootCacheSize(): number {
    return this.configRootByDirCache.size;
  }

  getEnvJsonPath(): string {
    return this.bindings.getEnvJsonPath();
  }

  resolveTargetByXmlPath(xmlPath: string): RepositoryTarget | null {
    const configRoot = this.findConfigRoot(xmlPath);
    if (!configRoot) {
      return null;
    }

    return this.resolveTargetByConfigRoot(configRoot);
  }

  /**
   * Определяет цель хранилища по корню выгрузки, чтобы UI мог проверять
   * ограничения на создание объектов ещё до появления их XML-файлов.
   */
  resolveTargetByConfigRoot(configRoot: string): RepositoryTarget | null {
    const configurationXmlPath = path.join(configRoot, 'Configuration.xml');
    const mtimeMs = getFileMtimeMs(configurationXmlPath);
    if (mtimeMs === undefined) {
      return null;
    }

    const cacheKey = normalizePathKey(configRoot);
    const cached = this.targetCache.get(cacheKey);
    if (cached?.mtimeMs === mtimeMs) {
      return cached.target;
    }

    const info = parseConfigXml(configurationXmlPath);
    const target = {
      configRoot,
      configKind: info.kind,
      extensionName: info.kind === 'cfe' ? info.name : undefined,
      displayName: info.name || path.basename(configRoot),
    };
    this.targetCache.set(cacheKey, { mtimeMs, target });
    return target;
  }

  /**
   * Читает привязку хранилища для отдачи наружу (webview); legacy-пароль из `env.json`
   * при этом мигрирует в `ProjectSecretStorage`. Пароль в результат не попадает.
   */
  loadBinding(target: RepositoryTarget): Promise<StoredRepositoryBinding | null> {
    return this.bindings.loadBinding(target);
  }

  /** Новая привязка начинается с чистого состояния захватов и подключения. */
  async saveBinding(target: RepositoryTarget, binding: RepositoryBinding): Promise<void> {
    await this.bindings.saveBinding(target, binding);
    this.lockStateStore.resetScope(target, true);
  }

  async clearBinding(target: RepositoryTarget): Promise<void> {
    await this.bindings.clearBinding(target);
    this.lockStateStore.clearScope(target);
  }

  /** Возвращает `true`, если для цели сохранён пароль хранилища в SecretStorage. */
  hasStoredRepoPassword(target: RepositoryTarget): Promise<boolean> {
    return this.bindings.hasStoredRepoPassword(target);
  }

  /**
   * Полная привязка (с паролем из SecretStorage) для запуска команды 1С.
   * Пароль остаётся только в памяти процесса и в `env.json` не пишется.
   */
  resolveBindingForCommand(target: RepositoryTarget): Promise<RepositoryBinding | null> {
    return this.bindings.resolveBindingForCommand(target);
  }

  hasBinding(target: RepositoryTarget): boolean {
    return this.bindings.hasBinding(target);
  }

  isConnected(target: RepositoryTarget): boolean {
    return this.hasBinding(target) && this.lockStateStore.isConnected(target);
  }

  setConnected(target: RepositoryTarget, connected: boolean): void {
    this.lockStateStore.setConnected(target, connected);
  }

  isLocked(target: RepositoryTarget, fullName: string): boolean {
    return this.lockStateStore.isLocked(target, fullName);
  }

  /**
   * Возвращает `true`, если локально отмечен захват корня конфигурации или
   * расширения. Это нужно для операций создания новых корневых объектов.
   */
  isRootLocked(target: RepositoryTarget): boolean {
    return this.lockStateStore.isRootLocked(target);
  }

  setLocked(target: RepositoryTarget, fullNames: string[], locked: boolean): void {
    this.lockStateStore.setLocked(target, fullNames, locked);
  }

  onDidChangeLocks(listener: (event: RepositoryLocksChangedNotice) => void): { dispose(): void } {
    return this.lockStateStore.onDidChangeLocks(listener);
  }

  /**
   * Возвращает `true`, если редактирование файла должно быть запрещено из-за
   * активного подключения к хранилищу без локального захвата объекта. Файлы
   * подчинённых единиц (форм, макетов и т.п.) проверяются по захвату самой единицы:
   * нерекурсивный захват владельца их не захватывает.
   */
  isEditRestricted(filePath: string): boolean {
    const ownerObjectXmlPath = this.resolveOwnerObjectXmlPath(filePath);
    if (!ownerObjectXmlPath) {
      return false;
    }

    const target = this.resolveTargetByXmlPath(ownerObjectXmlPath);
    if (!target || !this.isConnected(target)) {
      return false;
    }

    const suffix = resolveUnitSuffixByRelativePath(path.relative(target.configRoot, filePath));
    const ownerFullName = suffix.length > 0 ? this.resolveRootObjectFullName(ownerObjectXmlPath) : null;
    if (!ownerFullName) {
      return this.isMetadataEditRestricted(target, ownerObjectXmlPath);
    }
    let unit = ownerFullName;
    for (const segment of suffix) {
      // Каталог с точкой в имени даёт нераспознанного родителя единицы: захват такой
      // единицы проверить нельзя, а бросать отсюда нельзя — вызывается из guard'а
      // редактора на каждом открытии документа. Безопасный дефолт — «ограничено».
      if (!parseRepositoryUnit(unit)) {
        return true;
      }
      unit = subordinateUnitFullName(unit, segment.tag, segment.name);
    }
    return !this.isLocked(target, unit);
  }

  /**
   * Проверяет, можно ли менять метаданные внутри цели хранилища.
   * Для существующих объектов используется их локальный захват (в том числе через
   * рекурсивный захват подсистемы или корня), а для операций создания корневых
   * объектов — явный захват корня конфигурации.
   */
  isMetadataEditRestricted(target: RepositoryTarget, ownerObjectXmlPath?: string): boolean {
    if (!this.isConnected(target)) {
      return false;
    }

    const fullName = ownerObjectXmlPath ? this.resolveRootObjectFullName(ownerObjectXmlPath) : null;
    if (!fullName) {
      return !this.isRootLocked(target);
    }

    return !this.isLocked(target, fullName);
  }

  resolveFullName(node: RepositoryNodeRef): string | null {
    const kind = node.nodeKind as MetaKind | undefined;
    if (!kind) {
      return null;
    }

    if (ROOT_OR_GROUP_KINDS_WITHOUT_OWN_XML.has(kind)) {
      return null;
    }

    if (CHILD_LIKE_KINDS.has(kind)) {
      const ownerXmlPath = node.metaContext?.ownerObjectXmlPath;
      if (!ownerXmlPath) {
        return null;
      }

      const ownerFullName = this.resolveRootObjectFullName(ownerXmlPath);
      if (!ownerFullName || !isRepositorySubordinateTag(kind)) {
        return ownerFullName;
      }
      return this.buildSubordinateUnitFullName(ownerFullName, kind, node.label);
    }

    const nestedSubsystemFullName = kind === 'Subsystem' && node.xmlPath
      ? this.resolveNestedSubsystemFullName(node.xmlPath)
      : null;
    return nestedSubsystemFullName ?? this.buildRootObjectFullName(kind, node.xmlPath, node.label);
  }

  createObjectsFileForNode(node: RepositoryNodeRef, recursive: boolean): { filePath: string; fullNames: string[] } {
    const target = node.xmlPath ? this.resolveTargetByXmlPath(node.xmlPath) : null;
    if (!target) {
      throw new Error('Не удалось определить корень конфигурации для выбранного узла.');
    }

    const kind = node.nodeKind as MetaKind | undefined;
    if (!kind) {
      throw new Error('У выбранного узла не определён тип.');
    }

    if (kind === 'configuration' || kind === 'extension') {
      const xml = [
        `<Objects xmlns="${REPOSITORY_NAMESPACE}" version="1.0">`,
        `  <Configuration includeChildObjects="${recursive ? 'true' : 'false'}"/>`,
        `</Objects>`,
      ].join('\n');
      return {
        filePath: this.writeObjectsFile(target, xml),
        fullNames: [getRootLockName(target)],
      };
    }

    const fullName = this.resolveFullName(node);
    if (!fullName) {
      throw new Error('Для выбранного узла не удалось сформировать полное имя объекта.');
    }

    const lines = [
      `<Objects xmlns="${REPOSITORY_NAMESPACE}" version="1.0">`,
      `  <Object fullName="${escapeXml(fullName)}" includeChildObjects="${recursive ? 'true' : 'false'}">`,
    ];
    if (kind === 'Subsystem') {
      lines.push(
        `    <Subsystem includeObjectsFromSubordinateSubsystems="${recursive ? 'true' : 'false'}"/>`
      );
    }
    lines.push('  </Object>', '</Objects>');

    return {
      filePath: this.writeObjectsFile(target, lines.join('\n')),
      fullNames: [fullName],
    };
  }

  private buildRootObjectFullName(kind: MetaKind, xmlPath: string | undefined, fallbackLabel: string | undefined): string | null {
    const rootKindName = ONE_C_TYPE_NAMES[kind];
    if (!rootKindName) {
      return null;
    }

    const objectName = fallbackLabel ?? (xmlPath ? parseObjectXml(xmlPath)?.name : undefined);
    if (!objectName) {
      return null;
    }

    return `${rootKindName}.${objectName}`;
  }

  /**
   * Вложенная подсистема — подчинённая единица `Подсистема.A.Подсистема.B`: label узла
   * содержит только собственное имя, а короткое `Подсистема.B` платформа отклоняет.
   * Цепочка родителей читается из пути XML (`Subsystems/A/Subsystems/B.xml`) тем же
   * правилом, что и единица файла для readonly. Подсистема верхнего уровня — `null`.
   */
  private resolveNestedSubsystemFullName(xmlPath: string): string | null {
    const target = this.resolveTargetByXmlPath(xmlPath);
    if (!target) {
      return null;
    }
    const rel = path.relative(target.configRoot, xmlPath);
    return resolveUnitSuffixByRelativePath(rel).length > 0 ? resolveLockUnitByRelativePath(rel, target) : null;
  }

  /**
   * Полное имя подчинённой единицы хранилища. Вызывается из `getTreeItem` на горячем
   * пути дерева, поэтому не бросает: при невалидном входе — `null`.
   */
  private buildSubordinateUnitFullName(ownerFullName: string, tag: RepositorySubordinateTag, name: string | undefined): string | null {
    if (!name) {
      return null;
    }
    // Имя владельца берётся из <Name> и точек не содержит; защита от испорченного XML,
    // чтобы subordinateUnitFullName не бросил из getTreeItem (зеркало isEditRestricted).
    /* c8 ignore next 3 */
    if (!parseRepositoryUnit(ownerFullName)) {
      return null;
    }
    return subordinateUnitFullName(ownerFullName, tag, name);
  }

  private resolveRootObjectFullName(xmlPath: string): string | null {
    const mtimeMs = getFileMtimeMs(xmlPath);
    if (mtimeMs === undefined) {
      return null;
    }

    const cacheKey = normalizePathKey(xmlPath);
    const cached = this.rootFullNameCache.get(cacheKey);
    if (cached?.mtimeMs === mtimeMs) {
      return cached.value;
    }

    const objectInfo = parseObjectXml(xmlPath);
    const fullName = objectInfo
      ? this.buildRootObjectFullName(objectInfo.tag as MetaKind, undefined, objectInfo.name || path.basename(xmlPath, '.xml'))
      : null;
    this.rootFullNameCache.set(cacheKey, { mtimeMs, value: fullName });
    return fullName;
  }

  private resolveOwnerObjectXmlPath(filePath: string): string | null {
    const configRoot = this.findConfigRoot(filePath);
    if (!configRoot) {
      return null;
    }

    const relativeParts = path.relative(configRoot, filePath).split(path.sep).filter(Boolean);
    if (relativeParts.length < 2) {
      return null;
    }

    const folderName = relativeParts[0];
    const objectSegment = relativeParts[1];
    if (!folderName || !objectSegment) {
      return null;
    }

    if (objectSegment.toLowerCase().endsWith('.xml')) {
      const flatXmlPath = path.join(configRoot, folderName, objectSegment);
      return fs.existsSync(flatXmlPath) ? flatXmlPath : null;
    }

    return findObjectXmlInFolder(configRoot, folderName, objectSegment);
  }

  private findConfigRoot(startPath: string): string | null {
    let current: string;
    try {
      current = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
    } catch {
      return null;
    }

    // Быстрый путь: ровно эта директория уже резолвилась раньше.
    const startKey = normalizePathKey(current);
    if (this.configRootByDirCache.has(startKey)) {
      return this.configRootByDirCache.get(startKey) ?? null;
    }

    const workspaceRoot = path.resolve(this.workspaceRoot).toLowerCase();
    // Подъём по дереву с накоплением промежуточных директорий. После того
    // как корень найден (или подъём завершился), все посещённые директории
    // получают одно и то же значение — следующие запросы для соседних
    // файлов того же объекта не делают повторных syscall.
    const visited: string[] = [];
    let resolved: string | null = null;
    while (current.toLowerCase().startsWith(workspaceRoot)) {
      const cached = this.configRootByDirCache.get(normalizePathKey(current));
      if (cached !== undefined) {
        resolved = cached;
        break;
      }
      visited.push(current);
      if (fs.existsSync(path.join(current, 'Configuration.xml'))) {
        resolved = current;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    for (const dir of visited) {
      this.configRootByDirCache.set(normalizePathKey(dir), resolved);
    }
    return resolved;
  }

  private writeObjectsFile(target: RepositoryTarget, xml: string): string {
    const scopeKey = buildRepositoryScopeKey(target);
    const filePath = path.join(
      this.workspaceRoot,
      '.v8vscedit',
      'repository',
      'objects',
      `${scopeKey}-${String(Date.now())}.xml`
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${xml}\n`, 'utf-8');
    return filePath;
  }
}

function getFileMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

function normalizePathKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}
