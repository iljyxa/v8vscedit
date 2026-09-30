import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { findObjectXmlInFolder } from '../fs/ObjectLocation';
import type { Logger } from './Logger';
import { parseParentConfigurations, type ParentConfigurationsInfo } from './ParentConfigurationsParser';

/**
 * Доменный режим поддержки объекта метаданных 1С — НЕ коды файла
 * `ParentConfigurations.bin` (их трактовка — {@link BIN_CODE_TO_MODE}).
 *   - None — объект не на поддержке: его нет в списке поставки, он снят с
 *     поддержки или данных поддержки нет;
 *   - Editable — редактируется с сохранением поддержки;
 *   - Locked — не редактируется.
 *
 * Числовые значения заморожены: они вшиты в суффикс contextValue `-support<n>`
 * (`MetadataTreeProvider`, разбор в `UniversalPanelViewProvider`) и в URI
 * декораций `onec-support:///<n>` (`SupportDecorationProvider`).
 */
export const enum SupportMode {
  None = 0,
  Editable = 1,
  Locked = 2,
}

/**
 * Трактовка кода `a` записи `.bin` в доменный режим — единственное место, где
 * известен смысл кодов файла: 0 — не редактируется, 1 — редактируется с
 * сохранением поддержки, 2 — снят с поддержки. Неизвестный код трактуется как
 * запрет (см. {@link modeOfBinCode}): ошибочно разрешить правку объекта
 * поставщика опаснее, чем ошибочно запретить.
 */
const BIN_CODE_TO_MODE: Readonly<Partial<Record<number, SupportMode>>> = {
  0: SupportMode.Locked,
  1: SupportMode.Editable,
  2: SupportMode.None,
};

/**
 * Строгость режима для разрешения дублей uuid (объект у нескольких поставщиков):
 * берётся самый строгий, т.к. правка допустима, только если её разрешают все.
 */
const MODE_STRICTNESS: Readonly<Record<SupportMode, number>> = {
  [SupportMode.None]: 0,
  [SupportMode.Editable]: 1,
  [SupportMode.Locked]: 2,
};

function modeOfBinCode(code: number): SupportMode {
  return BIN_CODE_TO_MODE[code] ?? SupportMode.Locked;
}

interface ConfigSupportData {
  fileHash: string;
  /** Флаг «изменения запрещены» заголовка `.bin`: вся конфигурация только для чтения. */
  changesForbidden: boolean;
  /** Нормализованный путь к корню конфигурации (нижний регистр, прямые слэши) */
  normalizedRoot: string;
  /** Оригинальный путь (для восстановления регистра) */
  originalRoot: string;
  /** UUID объекта → режим поддержки */
  uuidToMode: Map<string, SupportMode>;
}

/**
 * Дочерние папки объекта, у элементов которых бывает собственный XML со своей
 * строкой в `ParentConfigurations.bin`. Команд здесь нет: в выгрузке команда
 * описана внутри XML владельца, отдельного файла у неё нет.
 */
const CHILD_FOLDERS_WITH_OWN_XML: readonly string[] = ['Forms', 'Templates'];

const UUID_ATTR_RE = /uuid="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/**
 * Разбирает `ParentConfigurations.bin` и по пути к файлу выдаёт режим поддержки.
 *
 * UUID объекта извлекается напрямую из его XML (атрибут `uuid="…"`); это
 * исключает зависимость от `ConfigDumpInfo.xml` и коллизии имён с расширениями.
 * Результаты кэшируются по SHA-1 хешу `ParentConfigurations.bin`.
 */
export class SupportInfoService {
  private readonly cache = new Map<string, ConfigSupportData>();
  private readonly pathUuidCache = new Map<string, string>();
  private readonly log: Logger;

  constructor(logger: Logger) {
    this.log = logger;
  }

  loadConfig(configRoot: string): void {
    const binPath = path.join(configRoot, 'Ext', 'ParentConfigurations.bin');
    if (!fs.existsSync(binPath)) {
      this.cache.delete(configRoot);
      this.log.appendLine(`[support] ${path.basename(configRoot)}: ParentConfigurations.bin не найден — поддержка отсутствует`);
      return;
    }

    const content = fs.readFileSync(binPath);
    const fileHash = this.computeHash(content);
    const configName = path.basename(configRoot);
    const cached = this.cache.get(configRoot);
    if (cached?.fileHash === fileHash) {
      this.log.appendLine(`[support] ${configName}: кэш актуален (hash=${fileHash.slice(0, 8)}…)`);
      return;
    }

    const normalizedRoot = normPath(configRoot);
    const parsed = parseParentConfigurations(content.toString('utf-8'));
    if (!parsed.ok) {
      // Непонятый файл не должен давать ни «всё разрешено», ни ложных режимов
      // от прежнего содержимого — данные корня сбрасываются целиком.
      this.clearPathUuidCacheForRoot(normalizedRoot);
      this.cache.delete(configRoot);
      this.log.appendLine(
        `[support] ${configName}: ParentConfigurations.bin не распознан (${parsed.reason})` +
        ' — режимы поддержки не определяются'
      );
      return;
    }

    const { info } = parsed;
    const uuidToMode = buildUuidToMode(info);
    this.logLoadSummary(configName, info, fileHash);

    this.clearPathUuidCacheForRoot(normalizedRoot);
    this.cache.set(configRoot, {
      fileHash,
      changesForbidden: info.changesForbidden,
      normalizedRoot,
      originalRoot: configRoot,
      uuidToMode,
    });
  }

  invalidate(configRoot: string): void {
    const cached = this.cache.get(configRoot);
    if (cached) {
      this.clearPathUuidCacheForRoot(cached.normalizedRoot);
    }
    this.cache.delete(configRoot);
    this.log.appendLine(`[support] ${path.basename(configRoot)}: кэш сброшен`);
  }

  /**
   * Возвращает режим поддержки по пути к файлу объекта.
   * Для BSL-модулей режим берётся по XML объекта-владельца, который лежит либо в
   * глубокой (`<Тип>/<Имя>/<Имя>.xml`), либо в плоской (`<Тип>/<Имя>.xml`)
   * раскладке выгрузки: модуль всегда в `<Тип>/<Имя>/Ext/`, а XML объекта при
   * плоской выгрузке — уровнем выше. Модули форм и макетов берут режим из
   * собственного XML, если он есть. Команда объекта своего XML не имеет, и её
   * модуль получает режим владельца. Это приближение: у `<Command uuid=…>` в XML
   * владельца есть собственный uuid, и его режим в `ParentConfigurations.bin`
   * может отличаться, но поиск uuid дочернего элемента внутри XML владельца
   * здесь не выполняется — прежнее поведение (всегда `None`) было хуже.
   * При флаге «изменения запрещены» любой файл конфигурации — {@link SupportMode.Locked}
   * сразу, без поиска XML и чтения uuid: это дешевле на горячем пути дерева и
   * запрещает правку даже BSL-модуля, владелец которого не найден.
   * Если конфигурация не имеет данных поддержки — {@link SupportMode.None}.
   */
  getSupportMode(filePath: string): SupportMode {
    const normFilePath = normPath(filePath);

    for (const data of this.cache.values()) {
      if (!normFilePath.startsWith(data.normalizedRoot + '/')) { continue; }
      if (data.changesForbidden) { return SupportMode.Locked; }

      const isBsl = filePath.toLowerCase().endsWith('.bsl');
      const xmlPath = isBsl
        ? this.resolveObjectXmlForBsl(filePath, data.normalizedRoot, data.originalRoot)
        : filePath;

      if (!xmlPath) {
        this.log.appendLine(`[support] не удалось определить XML для: ${path.basename(filePath)}`);
        return SupportMode.None;
      }

      const uuid = this.getUuidForFile(xmlPath);
      if (!uuid) {
        this.log.appendLine(`[support] UUID не найден в: ${xmlPath}`);
        return SupportMode.None;
      }

      const mode = data.uuidToMode.get(uuid) ?? SupportMode.None;
      return mode;
    }
    return SupportMode.None;
  }

  hasConfigData(filePath: string): boolean {
    return this.findConfigData(filePath) !== undefined;
  }

  /**
   * Установлен ли флаг «изменения запрещены» в `.bin` конфигурации, которой
   * принадлежит файл. Это ПРИЧИНА блокировки, а не режим: запрет правки решает
   * {@link getSupportMode} (он уже даёт `Locked`), а этот предикат нужен UI,
   * чтобы отличить закрытую настройками поддержки конфигурацию от объекта
   * поставщика, — у них разные способы снять запрет.
   */
  hasChangesForbidden(filePath: string): boolean {
    return this.findConfigData(filePath)?.changesForbidden === true;
  }

  isLocked(filePath: string): boolean {
    return this.getSupportMode(filePath) === SupportMode.Locked;
  }

  /**
   * Возвращает режим поддержки конкретного UUID в рамках конфигурации,
   * к которой принадлежит filePath. Флаг «изменения запрещены» перекрывает
   * режим записи так же, как в {@link getSupportMode}.
   */
  getSupportModeByUuid(filePath: string, uuid: string): SupportMode {
    const normFilePath = normPath(filePath);
    const normalizedUuid = uuid.toLowerCase();
    for (const data of this.cache.values()) {
      if (!normFilePath.startsWith(data.normalizedRoot + '/')) {
        continue;
      }
      if (data.changesForbidden) { return SupportMode.Locked; }
      return data.uuidToMode.get(normalizedUuid) ?? SupportMode.None;
    }
    return SupportMode.None;
  }

  // ── private ─────────────────────────────────────────────────────────────

  private findConfigData(filePath: string): ConfigSupportData | undefined {
    const normFilePath = normPath(filePath);
    for (const data of this.cache.values()) {
      if (normFilePath.startsWith(data.normalizedRoot + '/')) { return data; }
    }
    return undefined;
  }

  private clearPathUuidCacheForRoot(normalizedRoot: string): void {
    const prefix = normalizedRoot + '/';
    let cleared = 0;
    for (const key of this.pathUuidCache.keys()) {
      if (key.startsWith(prefix)) {
        this.pathUuidCache.delete(key);
        cleared++;
      }
    }
    if (cleared > 0) {
      this.log.appendLine(`[support] очищено ${String(cleared)} записей кэша UUID`);
    }
  }

  private computeHash(content: Buffer): string {
    return crypto.createHash('sha1').update(content).digest('hex');
  }

  private logLoadSummary(configName: string, info: ParentConfigurationsInfo, fileHash: string): void {
    let locked = 0, editable = 0, removed = 0, unknown = 0;
    for (const { code } of info.records) {
      const mode = BIN_CODE_TO_MODE[code];
      if (mode === undefined) { unknown++; }
      else if (mode === SupportMode.Locked) { locked++; }
      else if (mode === SupportMode.Editable) { editable++; }
      else { removed++; }
    }
    const unknownPart = unknown > 0
      ? `, неизвестный код: ${String(unknown)} — трактуется как запрет`
      : '';
    this.log.appendLine(
      `[support] ${configName}: загружено ${String(info.records.length)} записей` +
      ` (не редактируется: ${String(locked)}, редактируется с сохранением поддержки: ${String(editable)},` +
      ` снят с поддержки: ${String(removed)}${unknownPart}) hash=${fileHash.slice(0, 8)}…`
    );
    if (info.changesForbidden) {
      this.log.appendLine(
        `[support] ${configName}: изменения конфигурации запрещены — все объекты только для чтения`
      );
    }
    if (info.vendorCount === 1) {
      if (info.records.length !== info.declaredRecordCount) {
        this.log.appendLine(
          `[support] ${configName}: число записей в заголовке и в теле не совпадает —` +
          ` объявлено ${String(info.declaredRecordCount)}, разобрано ${String(info.records.length)}`
        );
      }
    } else {
      this.log.appendLine(
        `[support] ${configName}: поставщиков: ${String(info.vendorCount)} — разбор нескольких поставщиков` +
        ' не сверен с эталоном платформы; при расхождении режимов объекта берётся самый строгий'
      );
    }
  }

  /**
   * По пути к BSL-модулю находит XML-файл, по uuid которого определяется режим:
   *   - модуль формы/макета `TypeFolder/ObjectName/{Forms|Templates}/Child/Ext/…` →
   *     собственный XML `TypeFolder/ObjectName/{Forms|Templates}/Child.xml`, если он есть;
   *   - иначе (модуль объекта, команда, дочерний без своего XML) → XML владельца в
   *     глубокой или плоской раскладке через {@link findObjectXmlInFolder}.
   * Папка типа берётся из пути, а не из реестра типов: так режим определяется и
   * для папок, которых реестр не знает.
   */
  private resolveObjectXmlForBsl(
    bslPath: string,
    normalizedRoot: string,
    originalRoot: string
  ): string | undefined {
    const normBsl = normPath(bslPath);
    const rel = normBsl.slice(normalizedRoot.length + 1);
    const parts = rel.split('/');

    const extIdx = parts.indexOf('ext');
    if (extIdx < 2) { return undefined; }

    const bslParts = bslPath.replace(/\\/g, '/').split('/');
    const rootDepth = originalRoot.replace(/\\/g, '/').split('/').length;
    const typeFolder = bslParts[rootDepth];
    const objectName = bslParts[rootDepth + 1];
    if (!typeFolder || !objectName) { return undefined; }

    const childFolder = bslParts[rootDepth + 2];
    const childName = bslParts[rootDepth + 3];
    if (childFolder && childName && CHILD_FOLDERS_WITH_OWN_XML.includes(childFolder)) {
      const childXmlPath = path.join(originalRoot, typeFolder, objectName, childFolder, childName + '.xml');
      if (fs.existsSync(childXmlPath)) {
        return childXmlPath;
      }
    }

    const ownerXmlPath = findObjectXmlInFolder(originalRoot, typeFolder, objectName);
    if (!ownerXmlPath) {
      this.log.appendLine(`[support] XML объекта не найден: ${typeFolder}/${objectName}`);
      return undefined;
    }
    return ownerXmlPath;
  }

  private getUuidForFile(filePath: string): string | undefined {
    const key = normPath(filePath);
    const cached = this.pathUuidCache.get(key);
    if (cached !== undefined) {
      const v = cached;
      return v || undefined;
    }

    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(2048);
      const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, bytesRead).toString('utf-8');
      const m = UUID_ATTR_RE.exec(head);
      const uuid = m ? m[1].toLowerCase() : '';
      this.pathUuidCache.set(key, uuid);
      return uuid || undefined;
    } catch {
      this.pathUuidCache.set(key, '');
      return undefined;
    }
  }
}

/** Режим по uuid; дубль uuid (несколько поставщиков) — самый строгий из режимов. */
function buildUuidToMode(info: ParentConfigurationsInfo): Map<string, SupportMode> {
  const uuidToMode = new Map<string, SupportMode>();
  for (const { code, uuid } of info.records) {
    const mode = modeOfBinCode(code);
    const prev = uuidToMode.get(uuid);
    if (prev === undefined || MODE_STRICTNESS[mode] > MODE_STRICTNESS[prev]) {
      uuidToMode.set(uuid, mode);
    }
  }
  return uuidToMode;
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
}
