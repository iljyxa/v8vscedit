import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { META_TYPES, type MetaKind } from '../../domain/MetaTypes';
import type { ProjectSecretStorage } from '../environment/ProjectSecretStorage';
import { escapeXmlAttribute as escapeXml, parseConfigXml, parseObjectXml } from '../xml';
import { getObjectLocationFromXml } from '../fs/ObjectLocation';
import { SubsystemXmlService, type SubsystemInfo } from '../xml/SubsystemXmlService';

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
 * Результат сравнения файлов объекта с их снапшотом, снятым на момент захвата
 * (`captureLockSnapshot`). `hasSnapshot: false` — снапшота нет (объект не захватывался
 * через этот механизм, либо для узла снапшот не поддерживается — см. `captureLockSnapshot`).
 */
export interface RepositorySnapshotDiff {
  hasSnapshot: boolean;
  /** Пути (относительно `configRoot`) файлов, изменившихся или удалённых после захвата. */
  changedFiles: string[];
}

interface RepositorySnapshotManifest {
  /** Пути файлов относительно `configRoot`, зафиксированные снапшотом (POSIX-разделители). */
  files: string[];
}

/**
 * План частичной выгрузки объектов из БД в файлы после захвата/получения из
 * хранилища. `rootCaptureFull=true` означает, что был захвачен/получен корень
 * конфигурации/расширения целиком — в этом случае частичная выгрузка равна
 * полной, и вызывающая сторона должна выполнить обычный полный импорт вместо
 * частичного (см. {@link RepositoryService.buildPartialDumpPlan}).
 */
export interface RepositoryPartialDumpPlan {
  readonly rootCaptureFull: boolean;
  readonly fullNames: readonly string[];
}

interface RepositoryScopeState {
  connected?: boolean;
  lockedFullNames: string[];
}

interface RepositoryStateFile {
  version: 2;
  scopes: Record<string, RepositoryScopeState>;
}

interface CachedFileValue<T> {
  mtimeMs: number;
  value: T;
}

interface CachedTarget {
  mtimeMs: number;
  target: RepositoryTarget | null;
}

const REPOSITORY_STATE_VERSION = 2;
const REPOSITORY_NAMESPACE = 'http://v8.1c.ru/8.3/config/objects';
const CONFIGURATION_ROOT_LOCK_NAME = '__configuration_root__';
const EXTENSION_ROOT_LOCK_NAME = '__extension_root__';

/**
 * Внутренние имена типов объектов 1С, используемые для формирования полного имени
 * при захвате/освобождении в хранилище. Это НЕ человекочитаемые метки (label из META_TYPES),
 * а технические идентификаторы платформы 1С (например, «БизнесПроцесс» без дефиса).
 */
const ONE_C_TYPE_NAMES: Partial<Record<MetaKind, string>> = {
  Subsystem: 'Подсистема',
  CommonModule: 'ОбщийМодуль',
  SessionParameter: 'ПараметрСеанса',
  CommonAttribute: 'ОбщийРеквизит',
  Role: 'Роль',
  CommonForm: 'ОбщаяФорма',
  CommonCommand: 'ОбщаяКоманда',
  CommandGroup: 'ГруппаКоманд',
  CommonPicture: 'ОбщаяКартинка',
  CommonTemplate: 'ОбщийМакет',
  XDTOPackage: 'XDTOPackage',
  StyleItem: 'ЭлементСтиля',
  DefinedType: 'ОпределяемыйТип',
  FunctionalOption: 'ФункциональнаяОпция',
  FunctionalOptionsParameter: 'ПараметрФункциональнойОпции',
  SettingsStorage: 'ХранилищеНастроек',
  Style: 'Стиль',
  WSReference: 'WSСсылка',
  WebSocketClient: 'WebSocketКлиент',
  IntegrationService: 'СервисИнтеграции',
  Bot: 'Бот',
  Interface: 'Интерфейс',
  PaletteColor: 'ЦветПалитры',
  Language: 'Язык',
  HTTPService: 'HTTPСервис',
  WebService: 'WebСервис',
  Constant: 'Константа',
  Catalog: 'Справочник',
  Document: 'Документ',
  DocumentNumerator: 'НумераторДокументов',
  Enum: 'Перечисление',
  InformationRegister: 'РегистрСведений',
  AccumulationRegister: 'РегистрНакопления',
  AccountingRegister: 'РегистрБухгалтерии',
  CalculationRegister: 'РегистрРасчета',
  Report: 'Отчет',
  DataProcessor: 'Обработка',
  BusinessProcess: 'БизнесПроцесс',
  Task: 'Задача',
  ExchangePlan: 'ПланОбмена',
  ChartOfCharacteristicTypes: 'ПланВидовХарактеристик',
  ChartOfAccounts: 'ПланСчетов',
  ChartOfCalculationTypes: 'ПланВидовРасчета',
  DocumentJournal: 'ЖурналДокументов',
  ScheduledJob: 'РегламентноеЗадание',
  EventSubscription: 'ПодпискаНаСобытие',
  FilterCriterion: 'КритерийОтбора',
  Sequence: 'Последовательность',
  ExternalDataSource: 'ВнешнийИсточникДанных',
};

/**
 * Обратное отображение {@link ONE_C_TYPE_NAMES}: технический русский префикс
 * fullName → вид метаданных. Нужно для {@link RepositoryService.resolveXmlPathByFullName},
 * которая по fullName (например, `Справочник.Номенклатура`) находит локальный XML —
 * обратная задача по отношению к `resolveRootObjectFullName`.
 */
const ONE_C_TYPE_NAMES_BY_PREFIX: ReadonlyMap<string, MetaKind> = new Map(
  (Object.entries(ONE_C_TYPE_NAMES) as [MetaKind, string][]).map(
    ([kind, typeName]): [string, MetaKind] => [typeName, kind]
  )
);

/**
 * Виды дочерних узлов (ChildTag + Column), для которых захват идёт
 * через владельца, а не напрямую. Используется только для проверки
 * принадлежности — логика блокировки/разблокировки всегда работает
 * с полным именем корневого объекта-владельца.
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
 * и узлы группировки дерева. У них не бывает ни полного имени объекта (`resolveFullName`),
 * ни файлов для снапшота захвата (`resolveObjectXmlPathForSnapshot`).
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
 * Инфраструктурный сервис хранилища: хранит настройки в `env.json`,
 * локальный кэш захваченных объектов и генерирует `Objects.xml`.
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
  private envCache: CachedFileValue<Record<string, unknown>> | undefined;
  private stateCache: CachedFileValue<RepositoryStateFile> | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly secrets: ProjectSecretStorage
  ) {}

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
    return path.join(this.workspaceRoot, 'env.json');
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
   * Читает привязку хранилища для отдачи наружу (webview) и, если в `env.json`
   * остался legacy-пароль (`--repo-pwd`/`repo-pwd`), мигрирует его в
   * `ProjectSecretStorage` и затирает в файле. Пароль в результат не попадает.
   */
  async loadBinding(target: RepositoryTarget): Promise<StoredRepositoryBinding | null> {
    const raw = this.readBindingRaw(target);
    if (!raw) {
      return null;
    }

    if (raw.legacyPassword.trim()) {
      await this.secrets.setRepoPassword(this.buildScopeKey(target), raw.legacyPassword);
      this.eraseLegacyRepoPassword(target);
    }

    return { repoPath: raw.repoPath, repoUser: raw.repoUser };
  }

  async saveBinding(target: RepositoryTarget, binding: RepositoryBinding): Promise<void> {
    const env = this.readEnvFile();
    const defaults = this.getDefaultSection(env);
    if (target.configKind === 'cfe') {
      const extensionName = target.extensionName ?? '';
      const extensionSection = this.getExtensionSection(defaults);
      extensionSection[extensionName] = {
        'repo-path': binding.repoPath,
        'repo-user': binding.repoUser,
      };
      defaults.extension = extensionSection;
    } else {
    defaults['--repo-path'] = binding.repoPath;
    defaults['--repo-user'] = binding.repoUser;
    delete defaults['--repo-pwd'];
    }

    env.default = defaults;
    this.writeEnvFile(env);
    // Пароль хранилища уходит в SecretStorage; непустой ввод обновляет секрет,
    // пустой — трактуется как удаление (внутри setRepoPassword).
    if (binding.repoPassword.trim()) {
      await this.secrets.setRepoPassword(this.buildScopeKey(target), binding.repoPassword);
    }
    this.saveScopeState(target, {
      connected: true,
      lockedFullNames: [],
    });
  }

  async clearBinding(target: RepositoryTarget): Promise<void> {
    const env = this.readEnvFile();
    const defaults = this.getDefaultSection(env);
    if (target.configKind === 'cfe') {
      const extensionName = target.extensionName ?? '';
      const extensionSection = this.getExtensionSection(defaults);
      defaults.extension = Object.fromEntries(
        Object.entries(extensionSection).filter(([name]) => name !== extensionName)
      );
    } else {
      delete defaults['--repo-path'];
      delete defaults['--repo-user'];
      delete defaults['--repo-pwd'];
    }
    env.default = defaults;
    this.writeEnvFile(env);
    await this.secrets.setRepoPassword(this.buildScopeKey(target), '');
    this.clearScopeState(target);
  }

  /**
   * Возвращает `true`, если для цели сохранён пароль хранилища в SecretStorage.
   */
  async hasStoredRepoPassword(target: RepositoryTarget): Promise<boolean> {
    return this.secrets.hasRepoPassword(this.buildScopeKey(target));
  }

  /**
   * Полная привязка (с паролем из SecretStorage) для запуска команды 1С.
   * Пароль остаётся только в памяти процесса и в `env.json` не пишется.
   */
  async resolveBindingForCommand(target: RepositoryTarget): Promise<RepositoryBinding | null> {
    const stored = await this.loadBinding(target);
    if (!stored) {
      return null;
    }
    const repoPassword = await this.secrets.getRepoPassword(this.buildScopeKey(target));
    return {
      repoPath: stored.repoPath,
      repoUser: stored.repoUser,
      repoPassword: repoPassword ?? '',
    };
  }

  hasBinding(target: RepositoryTarget): boolean {
    return this.readBindingRaw(target) !== null;
  }

  /**
   * Синхронное чтение привязки из `env.json` без обращения к SecretStorage.
   * Отдаёт repoPath/repoUser и оставшийся legacy-пароль (если есть) — нужен для
   * проверок наличия привязки (hot path) и последующей асинхронной миграции.
   */
  private readBindingRaw(
    target: RepositoryTarget
  ): { repoPath: string; repoUser: string; legacyPassword: string } | null {
    const env = this.readEnvFile();
    const defaults = this.getDefaultSection(env);
    if (target.configKind === 'cfe') {
      const extensionSection = this.getRawExtensionSection(defaults);
      const extensionName = target.extensionName ?? '';
      const item = extensionSection[extensionName] as Record<string, unknown> | undefined;
      const repoPath = this.readString(item?.['repo-path']);
      if (!repoPath) {
        return null;
      }

      return {
        repoPath,
        repoUser: this.readString(item?.['repo-user']) ?? '',
        legacyPassword: this.readString(item?.['repo-pwd']) ?? '',
      };
    }

    const repoPath = this.readString(defaults['--repo-path']);
    if (!repoPath) {
      return null;
    }

    return {
      repoPath,
      repoUser: this.readString(defaults['--repo-user']) ?? '',
      legacyPassword: this.readString(defaults['--repo-pwd']) ?? '',
    };
  }

  private eraseLegacyRepoPassword(target: RepositoryTarget): void {
    const env = this.readEnvFile();
    const defaults = this.getDefaultSection(env);
    if (target.configKind === 'cfe') {
      const extensionName = target.extensionName ?? '';
      const rawSection = defaults.extension;
      if (rawSection && typeof rawSection === 'object' && !Array.isArray(rawSection)) {
        const item = (rawSection as Record<string, unknown>)[extensionName];
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          delete (item as Record<string, unknown>)['repo-pwd'];
        }
      }
    } else {
      delete defaults['--repo-pwd'];
    }
    env.default = defaults;
    this.writeEnvFile(env);
  }

  isConnected(target: RepositoryTarget): boolean {
    if (!this.hasBinding(target)) {
      return false;
    }

    const state = this.loadStateFile();
    const scope = state.scopes[this.buildScopeKey(target)] as RepositoryScopeState | undefined;
    return scope?.connected ?? true;
  }

  setConnected(target: RepositoryTarget, connected: boolean): void {
    const state = this.loadStateFile();
    const scopeKey = this.buildScopeKey(target);
    const scope = state.scopes[scopeKey] ?? { lockedFullNames: [] };
    state.scopes[scopeKey] = {
      ...scope,
      connected,
    };
    this.saveStateFile(state);
  }

  isLocked(target: RepositoryTarget, fullName: string): boolean {
    const state = this.loadStateFile();
    const scope = state.scopes[this.buildScopeKey(target)] as RepositoryScopeState | undefined;
    return scope?.lockedFullNames.includes(fullName) ?? false;
  }

  /**
   * Возвращает `true`, если локально отмечен захват корня конфигурации или
   * расширения. Это нужно для операций создания новых корневых объектов.
   */
  isRootLocked(target: RepositoryTarget): boolean {
    return this.isLocked(target, this.getRootLockName(target));
  }

  setLocked(target: RepositoryTarget, fullNames: string[], locked: boolean): void {
    if (fullNames.length === 0) {
      return;
    }

    const state = this.loadStateFile();
    const scopeKey = this.buildScopeKey(target);
    const scope = state.scopes[scopeKey] ?? { lockedFullNames: [] };
    const items = new Set(scope.lockedFullNames);
    for (const fullName of fullNames) {
      if (locked) {
        items.add(fullName);
      } else {
        items.delete(fullName);
      }
    }
    state.scopes[scopeKey] = {
      lockedFullNames: [...items].sort((left, right) => left.localeCompare(right, 'ru')),
    };
    this.saveStateFile(state);
  }

  /**
   * Возвращает `true`, если редактирование файла должно быть запрещено из-за
   * активного подключения к хранилищу без локального захвата объекта.
   */
  isEditRestricted(filePath: string): boolean {
    const ownerObjectXmlPath = this.resolveOwnerObjectXmlPath(filePath);
    if (!ownerObjectXmlPath) {
      return false;
    }

    const target = this.resolveTargetByXmlPath(ownerObjectXmlPath);
    if (!target || !this.hasBinding(target) || !this.isConnected(target)) {
      return false;
    }

    return this.isMetadataEditRestricted(target, ownerObjectXmlPath);
  }

  /**
   * Проверяет, можно ли менять метаданные внутри цели хранилища.
   * Для существующих объектов используется их локальный захват, а для
   * операций создания корневых объектов — захват корня конфигурации.
   */
  isMetadataEditRestricted(target: RepositoryTarget, ownerObjectXmlPath?: string): boolean {
    if (!this.hasBinding(target) || !this.isConnected(target)) {
      return false;
    }

    if (!ownerObjectXmlPath) {
      return !this.isRootLocked(target);
    }

    const fullName = this.resolveRootObjectFullName(ownerObjectXmlPath);
    if (!fullName) {
      return !this.isRootLocked(target);
    }

    return !this.isLocked(target, fullName);
  }

  clearLocks(target: RepositoryTarget): void {
    const state = this.loadStateFile();
    const scopeKey = this.buildScopeKey(target);
    const scope = state.scopes[scopeKey] as RepositoryScopeState | undefined;
    if (!scope) {
      return;
    }
    scope.lockedFullNames = [];
    state.scopes[scopeKey] = scope;
    this.saveStateFile(state);
  }

  /**
   * Снимает снапшот файлов объекта в момент его локального захвата (`v8vscedit.repository.lock`).
   * Снапшот не зависит от git — он нужен, чтобы `unlock` мог предложить откат к состоянию
   * на момент захвата (issue #2), даже если в проекте нет `.git` или изменения уже закоммичены.
   *
   * Для узлов, у которых нет собственного XML-файла объекта (корень конфигурации/расширения,
   * узлы группировки) снапшот не снимается — откатывать нечего, т.к. `createObjectsFileForNode`
   * в этом случае не привязывает захват к конкретным файлам на диске.
   */
  captureLockSnapshot(target: RepositoryTarget, node: RepositoryNodeRef): void {
    const xmlPath = this.resolveObjectXmlPathForSnapshot(node);
    const fullName = this.resolveFullName(node);
    if (!xmlPath || !fullName || !fs.existsSync(xmlPath)) {
      return;
    }

    const files = this.collectObjectFiles(xmlPath);
    const snapshotDir = this.getSnapshotDir(target, fullName);
    // Затираем возможный снапшот от предыдущего захвата этого же объекта — актуален только
    // снапшот, снятый последним `lock`.
    fs.rmSync(snapshotDir, { recursive: true, force: true });

    const filesDir = path.join(snapshotDir, 'files');
    const relativeFiles: string[] = [];
    for (const file of files) {
      const relative = path.relative(target.configRoot, file).split(path.sep).join('/');
      relativeFiles.push(relative);
      const destination = path.join(filesDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file, destination);
    }

    const manifest: RepositorySnapshotManifest = { files: relativeFiles };
    fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  }

  /**
   * Сравнивает текущее содержимое файлов объекта со снапшотом, снятым при захвате.
   * Отсутствующий снапшот (объект не захватывался, либо снапшот уже израсходован
   * `discardLockSnapshot`) отдаётся как `hasSnapshot: false`, а не как «изменений нет» —
   * вызывающая сторона не должна путать эти два случая.
   */
  getLockSnapshotDiff(target: RepositoryTarget, node: RepositoryNodeRef): RepositorySnapshotDiff {
    const fullName = this.resolveFullName(node);
    if (!fullName) {
      return { hasSnapshot: false, changedFiles: [] };
    }

    const snapshotDir = this.getSnapshotDir(target, fullName);
    const manifest = this.readSnapshotManifest(snapshotDir);
    if (!manifest) {
      return { hasSnapshot: false, changedFiles: [] };
    }

    const changedFiles: string[] = [];
    for (const relative of manifest.files) {
      const currentPath = path.join(target.configRoot, relative);
      const snapshotPath = path.join(snapshotDir, 'files', relative);
      if (!fs.existsSync(currentPath) || !filesAreEqual(currentPath, snapshotPath)) {
        changedFiles.push(relative);
      }
    }

    return { hasSnapshot: true, changedFiles };
  }

  /**
   * Восстанавливает файлы объекта из снапшота, снятого при захвате. Возвращает
   * абсолютные пути восстановленных файлов (для лога вызывающей стороны).
   * Файлы, появившиеся после захвата и не входившие в снапшот, не удаляются —
   * известное ограничение (см. issue #2, вариант A).
   */
  restoreLockSnapshot(target: RepositoryTarget, node: RepositoryNodeRef): string[] {
    const fullName = this.resolveFullName(node);
    if (!fullName) {
      return [];
    }

    const snapshotDir = this.getSnapshotDir(target, fullName);
    const manifest = this.readSnapshotManifest(snapshotDir);
    if (!manifest) {
      return [];
    }

    const restored: string[] = [];
    for (const relative of manifest.files) {
      const destination = path.join(target.configRoot, relative);
      const source = path.join(snapshotDir, 'files', relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      restored.push(destination);
    }
    return restored;
  }

  /**
   * Удаляет снапшот объекта. Вызывается после `unlock` независимо от решения
   * пользователя об откате — снапшот, снятый предыдущим захватом, теряет смысл,
   * как только объект снова свободен.
   */
  discardLockSnapshot(target: RepositoryTarget, node: RepositoryNodeRef): void {
    const fullName = this.resolveFullName(node);
    if (!fullName) {
      return;
    }
    fs.rmSync(this.getSnapshotDir(target, fullName), { recursive: true, force: true });
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

      return this.resolveRootObjectFullName(ownerXmlPath);
    }

    return this.buildRootObjectFullName(kind, node.xmlPath, node.label);
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
        fullNames: [this.getRootLockName(target)],
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

  /**
   * Строит план частичной выгрузки для объектов, только что захваченных/полученных
   * из хранилища (`objects` — результат {@link createObjectsFileForNode} для того же
   * узла и того же `recursive`). Локальный захват хранит только fullName самого узла
   * (см. комментарий у {@link createObjectsFileForNode}) — сервер хранилища при
   * `includeChildObjects`/`includeObjectsFromSubordinateSubsystems` раскрывает состав
   * сам, и это раскрытие нигде локально не сохраняется. Поэтому:
   *  - для захвата корня конфигурации/расширения целиком частичная выгрузка
   *    бессмысленна (она была бы равна полной) — вызывающая сторона должна
   *    выполнить обычный полный импорт;
   *  - для рекурсивного захвата Подсистемы состав участников нужно раскрыть самим
   *    через {@link resolveSubsystemMemberFullNames} (их fullName не выводится из
   *    одного имени подсистемы, в отличие от дочерних артефактов обычного объекта);
   *  - для остальных случаев (обычный объект, в том числе с рекурсивным захватом
   *    собственных форм/реквизитов/макетов) достаточно fullName самого узла — его
   *    дочерние артефакты и так резолвятся к тому же fullName в `isMetadataEditRestricted`.
   */
  buildPartialDumpPlan(
    node: RepositoryNodeRef,
    objects: { fullNames: string[] },
    recursive: boolean
  ): RepositoryPartialDumpPlan {
    const [firstFullName] = objects.fullNames;
    if (firstFullName === CONFIGURATION_ROOT_LOCK_NAME || firstFullName === EXTENSION_ROOT_LOCK_NAME) {
      return { rootCaptureFull: true, fullNames: [] };
    }

    if (node.nodeKind === 'Subsystem' && recursive && node.xmlPath) {
      return { rootCaptureFull: false, fullNames: this.resolveSubsystemMemberFullNames(node.xmlPath, true) };
    }

    return { rootCaptureFull: false, fullNames: objects.fullNames };
  }

  /**
   * Раскрывает состав подсистемы для частичной выгрузки: fullName самой подсистемы
   * плюс fullName каждого объекта из её `<Content>`. При `recursive=true` (соответствует
   * `includeObjectsFromSubordinateSubsystems` в {@link createObjectsFileForNode}) рекурсивно
   * обходит дочерние подсистемы тем же способом, каким это делает дерево подсистем
   * в `SubsystemToolsService` (`<Папка>/<Имя>/<Имя>.xml`, иначе `<Папка>/<Имя>.xml`).
   */
  resolveSubsystemMemberFullNames(subsystemXmlPath: string, recursive: boolean): string[] {
    const subsystemXmlService = new SubsystemXmlService();
    const result = new Set<string>();
    const visited = new Set<string>();

    const visit = (xmlPath: string): void => {
      const key = normalizePathKey(xmlPath);
      if (visited.has(key) || !fs.existsSync(xmlPath)) {
        return;
      }
      visited.add(key);

      let subsystem: SubsystemInfo;
      try {
        subsystem = subsystemXmlService.readSubsystem(xmlPath);
      } catch {
        // Повреждённый/нечитаемый XML подсистемы не должен ронять весь план дампа —
        // просто пропускаем эту ветку, как и остальные best-effort резолверы в этом файле.
        return;
      }

      const ownFullName = this.buildRootObjectFullName('Subsystem', undefined, subsystem.name);
      if (ownFullName) {
        result.add(ownFullName);
      }
      // ВАЖНО: `<Content>` хранит ссылки с английским префиксом вида `Catalog.Товары`
      // (см. SubsystemToolsService.KNOWN_SINGULAR_TYPES = Object.keys(META_TYPES)) —
      // это другой алфавит имён, чем русский технический fullName хранилища
      // (`Справочник.Товары`, ONE_C_TYPE_NAMES), который ожидают `-Objects`/`-listFile`.
      // Просто копировать contentRefs как есть — значит передать конфигуратору
      // несуществующие имена объектов.
      for (const ref of subsystem.contentRefs) {
        const repositoryFullName = convertContentRefToRepositoryFullName(ref);
        if (repositoryFullName) {
          result.add(repositoryFullName);
        }
      }

      if (!recursive) {
        return;
      }
      for (const child of subsystem.childSubsystems) {
        const nested = path.join(subsystem.homeDir, 'Subsystems', child, `${child}.xml`);
        const flat = path.join(subsystem.homeDir, 'Subsystems', `${child}.xml`);
        visit(fs.existsSync(nested) ? nested : flat);
      }
    };

    visit(subsystemXmlPath);
    return [...result];
  }

  /**
   * Обратная задача к {@link resolveRootObjectFullName}: по fullName объекта
   * (например, `Справочник.Номенклатура`) находит его локальный XML-файл внутри
   * `configRoot`. Нужна для частичной выгрузки — `-Objects`/`-listFile` работают с
   * fullName, а мёрж результата в проект — с относительными путями файлов.
   * Возвращает `null`, если тип не распознан или файл не найден (например, участник
   * подсистемы ещё не выгружен локально).
   */
  resolveXmlPathByFullName(configRoot: string, fullName: string): string | null {
    const dotIndex = fullName.indexOf('.');
    if (dotIndex <= 0 || dotIndex === fullName.length - 1) {
      return null;
    }

    const typeName = fullName.slice(0, dotIndex);
    const objectName = fullName.slice(dotIndex + 1);
    const kind = ONE_C_TYPE_NAMES_BY_PREFIX.get(typeName);
    const folder = kind ? META_TYPES[kind]?.folder : undefined;
    if (!folder) {
      return null;
    }

    const typeDir = path.join(configRoot, folder);
    const nested = path.join(typeDir, objectName, `${objectName}.xml`);
    if (fs.existsSync(nested)) {
      return nested;
    }
    const flat = path.join(typeDir, `${objectName}.xml`);
    return fs.existsSync(flat) ? flat : null;
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

  /**
   * Путь к XML корневого объекта-владельца для целей снапшота захвата. Повторяет маршрутизацию
   * `resolveFullName`: для дочерних узлов (реквизит/ТЧ/форма/…) снапшотится не сам узел,
   * а владелец — именно владелец захватывается и именно его файлы могут быть изменены.
   * Для корня конфигурации/расширения и узлов группировки собственного XML-файла нет — `null`.
   */
  private resolveObjectXmlPathForSnapshot(node: RepositoryNodeRef): string | null {
    const kind = node.nodeKind as MetaKind | undefined;
    if (!kind) {
      return null;
    }

    if (CHILD_LIKE_KINDS.has(kind)) {
      return node.metaContext?.ownerObjectXmlPath ?? null;
    }

    if (ROOT_OR_GROUP_KINDS_WITHOUT_OWN_XML.has(kind)) {
      return null;
    }

    return node.xmlPath ?? null;
  }

  /**
   * Файлы, относящиеся к объекту: сам XML + всё содержимое его каталога (Ext/, Forms/,
   * Templates/ и т.п.), если каталог существует (выгрузка в «глубоком» формате).
   * Для «плоской» выгрузки (XML без соседнего каталога) — только сам XML-файл.
   */
  private collectObjectFiles(xmlPath: string): string[] {
    const files = new Set<string>();
    files.add(path.resolve(xmlPath));

    const { objectDir } = getObjectLocationFromXml(xmlPath);
    if (isExistingDirectory(objectDir)) {
      this.walkFilesInto(objectDir, files);
    }

    return [...files];
  }

  private walkFilesInto(dir: string, out: Set<string>): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkFilesInto(fullPath, out);
      } else if (entry.isFile()) {
        out.add(path.resolve(fullPath));
      }
    }
  }

  private getSnapshotDir(target: RepositoryTarget, fullName: string): string {
    const scopeKey = this.buildScopeKey(target);
    const fullNameHash = crypto.createHash('sha1').update(fullName).digest('hex');
    return path.join(this.workspaceRoot, '.v8vscedit', 'repository', 'snapshots', scopeKey, fullNameHash);
  }

  private readSnapshotManifest(snapshotDir: string): RepositorySnapshotManifest | null {
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<RepositorySnapshotManifest>;
      if (!Array.isArray(parsed.files)) {
        return null;
      }
      return { files: parsed.files };
    } catch {
      return null;
    }
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

    const deepXmlPath = path.join(configRoot, folderName, objectSegment, `${objectSegment}.xml`);
    if (fs.existsSync(deepXmlPath)) {
      return deepXmlPath;
    }

    const flatXmlPath = path.join(configRoot, folderName, `${objectSegment}.xml`);
    return fs.existsSync(flatXmlPath) ? flatXmlPath : null;
  }

  private readEnvFile(): Record<string, unknown> {
    const envPath = this.getEnvJsonPath();
    const mtimeMs = getFileMtimeMs(envPath) ?? -1;
    if (this.envCache?.mtimeMs === mtimeMs) {
      return this.envCache.value;
    }

    if (mtimeMs < 0) {
      const empty = { default: {} };
      this.envCache = { mtimeMs, value: empty };
      return empty;
    }

    const raw = fs.readFileSync(envPath, 'utf-8');
    // Пустой env.json — легитимное состояние (создан инициализацией, но ещё не
    // заполнен / очищен). Не должен ронять навигатор через JSON.parse('').
    if (raw.trim().length === 0) {
      const empty = { default: {} };
      this.envCache = { mtimeMs, value: empty };
      return empty;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`env.json повреждён (${envPath}): ${reason}`, { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`env.json повреждён (${envPath}): ожидался объект`);
    }

    const value = parsed as Record<string, unknown>;
    this.envCache = { mtimeMs, value };
    return value;
  }

  private writeEnvFile(env: Record<string, unknown>): void {
    const envPath = this.getEnvJsonPath();
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${JSON.stringify(env, null, 2)}\n`, 'utf-8');
    this.envCache = {
      mtimeMs: getFileMtimeMs(envPath) ?? Date.now(),
      value: env,
    };
  }

  private getDefaultSection(env: Record<string, unknown>): Record<string, unknown> {
    const defaults = env.default;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
      return {};
    }
    return { ...(defaults as Record<string, unknown>) };
  }

  private getExtensionSection(defaults: Record<string, unknown>): Record<string, Record<string, string>> {
    const raw = defaults.extension;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }

    const result: Record<string, Record<string, string>> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      const item = value as Record<string, unknown>;
      result[key] = {
        'repo-path': this.readString(item['repo-path']) ?? '',
        'repo-user': this.readString(item['repo-user']) ?? '',
      };
    }
    return result;
  }

  /**
   * Сырое чтение секции расширений с сохранением `repo-pwd` — нужно для
   * миграции legacy-пароля (обычный `getExtensionSection` пароль отбрасывает).
   */
  private getRawExtensionSection(
    defaults: Record<string, unknown>
  ): Record<string, Record<string, unknown>> {
    const raw = defaults.extension;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    const result: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = value as Record<string, unknown>;
      }
    }
    return result;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
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

  private loadStateFile(): RepositoryStateFile {
    const filePath = this.getStateFilePath();
    const mtimeMs = getFileMtimeMs(filePath) ?? -1;
    if (this.stateCache?.mtimeMs === mtimeMs) {
      return this.stateCache.value;
    }

    if (mtimeMs < 0) {
      const empty: RepositoryStateFile = {
        version: REPOSITORY_STATE_VERSION,
        scopes: {},
      };
      this.stateCache = { mtimeMs, value: empty };
      return empty;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<RepositoryStateFile>;
      if (parsed.version !== REPOSITORY_STATE_VERSION || !parsed.scopes) {
        const empty: RepositoryStateFile = {
          version: REPOSITORY_STATE_VERSION,
          scopes: {},
        };
        this.stateCache = { mtimeMs, value: empty };
        return empty;
      }
      const state: RepositoryStateFile = {
        version: REPOSITORY_STATE_VERSION,
        scopes: parsed.scopes,
      };
      this.stateCache = { mtimeMs, value: state };
      return state;
    } catch {
      const empty: RepositoryStateFile = {
        version: REPOSITORY_STATE_VERSION,
        scopes: {},
      };
      this.stateCache = { mtimeMs, value: empty };
      return empty;
    }
  }

  private saveStateFile(state: RepositoryStateFile): void {
    const filePath = this.getStateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    this.stateCache = {
      mtimeMs: getFileMtimeMs(filePath) ?? Date.now(),
      value: state,
    };
  }

  private saveScopeState(target: RepositoryTarget, scope: RepositoryScopeState): void {
    const state = this.loadStateFile();
    state.scopes[this.buildScopeKey(target)] = scope;
    this.saveStateFile(state);
  }

  private clearScopeState(target: RepositoryTarget): void {
    const state = this.loadStateFile();
    const scopeKey = this.buildScopeKey(target);
    state.scopes = Object.fromEntries(
      Object.entries(state.scopes).filter(([key]) => key !== scopeKey)
    );
    this.saveStateFile(state);
  }

  private getStateFilePath(): string {
    return path.join(this.workspaceRoot, '.v8vscedit', 'repository', 'state.json');
  }

  private buildScopeKey(target: RepositoryTarget): string {
    const raw = `${target.configKind}|${path.resolve(target.configRoot)}|${target.extensionName ?? ''}`;
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  private writeObjectsFile(target: RepositoryTarget, xml: string): string {
    const scopeKey = this.buildScopeKey(target);
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

  private getRootLockName(target: RepositoryTarget): string {
    return target.configKind === 'cfe' ? EXTENSION_ROOT_LOCK_NAME : CONFIGURATION_ROOT_LOCK_NAME;
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

function filesAreEqual(leftPath: string, rightPath: string): boolean {
  try {
    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
  } catch {
    return false;
  }
}

/**
 * `existsSync` + `statSync(...).isDirectory()` в одну проверку без промежуточного гонки
 * TOCTOU-исключения (`objectDir` мог исчезнуть между вызовами). Ветка "существует, но не
 * каталог" (коллизия имени объекта с одноимённым файлом) недостижима при штатной выгрузке
 * 1С — `stat` в остальном либо кидает ENOENT (нет пути), либо подтверждает каталог.
 */
function isExistingDirectory(dirPath: string): boolean {
  try {
    /* c8 ignore next */
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Переводит ссылку из `<Content>` подсистемы (английский префикс вида
 * `Catalog.Товары`, см. {@link resolveSubsystemMemberFullNames}) в технический
 * fullName хранилища (`Справочник.Товары`, {@link ONE_C_TYPE_NAMES}). Возвращает
 * `null` для нераспознанного префикса — например, UUID-ссылки на ещё не
 * переименованный/удалённый объект, которую платформа кладёт в Content вместо
 * имени.
 */
function convertContentRefToRepositoryFullName(ref: string): string | null {
  const dotIndex = ref.indexOf('.');
  if (dotIndex <= 0 || dotIndex === ref.length - 1) {
    return null;
  }
  const englishType = ref.slice(0, dotIndex) as MetaKind;
  const objectName = ref.slice(dotIndex + 1);
  const russianType = ONE_C_TYPE_NAMES[englishType];
  return russianType ? `${russianType}.${objectName}` : null;
}
