import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConfigurationDumpRequest } from '../../../infra/agent';
import type { RepositoryDumpToTempResult, RepositoryFileSyncServices } from '../../../ui/commands/repository/RepositoryFileSyncShared';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';

/**
 * Имитация частичной выгрузки платформой 1С (см. план архитектора, раздел 10.5 и
 * 10.12): по списку `-listFile` копирует РОВНО основной XML единицы и её каталог,
 * БЕЗ подкаталогов Forms/Templates/Recalculations/Tables/Cubes/DimensionTables/
 * Subsystems (единица-подчинённый выгружается САМА отдельной строкой списка —
 * платформа не докладывает вложенные единицы в выгрузку владельца, дефект D2).
 * Имя, которого нет в фикстуре, — вся выгрузка `{ok:false}` (rc=1 роняет весь
 * вызов целиком, ни один файл не появляется).
 *
 * НЕ импортирует production-логику (`RepositoryObjectNames`/`RepositoryObjectScope`):
 * раскладка путей — независимый литеральный эталон, чтобы тест не мог «случайно
 * совпасть» с багом в реализации через общий код.
 */

const OWNER_FOLDER_BY_RU_KIND: Readonly<Record<string, string>> = {
  Справочник: 'Catalogs',
  РегистрРасчета: 'CalculationRegisters',
  ВнешнийИсточникДанных: 'ExternalDataSources',
};

const SUBORDINATE_FOLDER_BY_RU_TAG: Readonly<Record<string, string>> = {
  Форма: 'Forms',
  Макет: 'Templates',
  Перерасчет: 'Recalculations',
  Таблица: 'Tables',
  Куб: 'Cubes',
  ТаблицаИзмерения: 'DimensionTables',
  Подсистема: 'Subsystems',
};

const ALL_SUBORDINATE_FOLDERS: ReadonlySet<string> = new Set(Object.values(SUBORDINATE_FOLDER_BY_RU_TAG));

interface UnitLocation {
  /** Путь к основному XML единицы относительно корня выгрузки/конфигурации. */
  xmlRel: string;
  /** Путь к каталогу единицы (может не существовать — например, объект без Ext). */
  dirRel: string;
}

/**
 * Разбирает fullName хранилища (`Тип.Имя(.ПодТипRu.Имя)*`) в путь по РЕАЛЬНОЙ
 * раскладке `example/2.21/src/cf`: и владелец, и каждая единица-подчинённый —
 * «плоский» файл `<parent>/<Name>.xml` + одноимённый каталог `<parent>/<Name>/`.
 */
function resolveUnitLocation(fullName: string): UnitLocation | null {
  const segments = fullName.split('.');
  if (segments.length < 2) {
    return null;
  }
  const folder = OWNER_FOLDER_BY_RU_KIND[segments[0]];
  if (!folder) {
    return null;
  }
  let dirRel = `${folder}/${segments[1]}`;
  for (let i = 2; i + 1 < segments.length; i += 2) {
    const subFolder = SUBORDINATE_FOLDER_BY_RU_TAG[segments[i]];
    if (!subFolder) {
      return null;
    }
    dirRel = `${dirRel}/${subFolder}/${segments[i + 1]}`;
  }
  const lastSlash = dirRel.lastIndexOf('/');
  const parentDir = dirRel.slice(0, lastSlash);
  const name = dirRel.slice(lastSlash + 1);
  return { xmlRel: `${parentDir}/${name}.xml`, dirRel };
}

/** Копирует каталог единицы, ИСКЛЮЧАЯ подкаталоги вложенных единиц (сама суть D2). */
function copyUnitDirExcludingSubordinates(sourceDir: string, destDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && ALL_SUBORDINATE_FOLDERS.has(entry.name)) {
      continue;
    }
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyUnitDirExcludingSubordinates(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

export interface PartialDumpCall {
  readonly names: readonly string[];
  /** `guard.isBusy` (или другой переданный пробник) в момент вызова. */
  readonly busy: boolean;
}

export interface PartialDumpFixture {
  readonly calls: PartialDumpCall[];
  /** Совместима с `RepositoryFileSyncDeps.dumpToTemp`, но только для `mode:'partial'`. */
  dumpToTemp(
    target: RepositoryTarget,
    request: ConfigurationDumpRequest,
    services: RepositoryFileSyncServices
  ): Promise<RepositoryDumpToTempResult>;
  /** Пробник занятости, вызываемый на каждом обращении (по умолчанию — всегда false). */
  probeBusy: () => boolean;
  /** Удаляет все временные каталоги, созданные за время жизни фикстуры. */
  disposeAll(): void;
}

/**
 * `sourceRoot` — корень реальной выгрузки-эталона (копия `example/2.21/src/cf`
 * или её часть); `rootDisplayName` — имя конфигурации для распознавания корневого
 * токена `Конфигурация.<Имя>` в списке (см. `buildRootDumpListName`).
 */
export function createPartialDumpFixture(sourceRoot: string, rootDisplayName: string): PartialDumpFixture {
  const tempDirs: string[] = [];
  const calls: PartialDumpCall[] = [];
  let probeBusy: () => boolean = () => false;

  return {
    calls,
    get probeBusy() {
      return probeBusy;
    },
    set probeBusy(probe: () => boolean) {
      probeBusy = probe;
    },
    // Не async: вся работа синхронна (fs.*Sync), интерфейс требует Promise —
    // результат оборачивается явно, чтобы не тянуть бессмысленный await (require-await).
    dumpToTemp(_target, request): Promise<RepositoryDumpToTempResult> {
      if (request.mode !== 'partial') {
        throw new Error(`partialDumpFixture поддерживает только mode:'partial', получено "${request.mode}" — используйте отдельный дабл для update-info/full.`);
      }
      calls.push({ names: [...request.fullNames], busy: probeBusy() });

      const rootToken = `Конфигурация.${rootDisplayName}`;
      const resolved: ({ rootDir: true } | { rootDir: false; location: UnitLocation })[] = [];
      for (const name of request.fullNames) {
        if (name === rootToken) {
          resolved.push({ rootDir: true });
          continue;
        }
        const location = resolveUnitLocation(name);
        if (!location || !fs.existsSync(path.join(sourceRoot, location.xmlRel))) {
          // rc=1: одна нераспознанная строка списка роняет весь вызов, файлов не появляется.
          return Promise.resolve({ ok: false, reason: `rc=1: объект "${name}" не найден в выгрузке (эмуляция rc=1 частичной выгрузки)` });
        }
        resolved.push({ rootDir: false, location });
      }

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-partial-dump-'));
      tempDirs.push(dir);
      for (const item of resolved) {
        if (item.rootDir) {
          fs.copyFileSync(path.join(sourceRoot, 'Configuration.xml'), path.join(dir, 'Configuration.xml'));
          const extSrc = path.join(sourceRoot, 'Ext');
          if (fs.existsSync(extSrc)) {
            fs.cpSync(extSrc, path.join(dir, 'Ext'), { recursive: true });
          }
          continue;
        }
        const { xmlRel, dirRel } = item.location;
        const xmlDest = path.join(dir, xmlRel);
        fs.mkdirSync(path.dirname(xmlDest), { recursive: true });
        fs.copyFileSync(path.join(sourceRoot, xmlRel), xmlDest);
        const dirSrc = path.join(sourceRoot, dirRel);
        if (fs.existsSync(dirSrc) && fs.statSync(dirSrc).isDirectory()) {
          fs.mkdirSync(path.join(dir, dirRel), { recursive: true });
          copyUnitDirExcludingSubordinates(dirSrc, path.join(dir, dirRel));
        }
      }
      return Promise.resolve({ ok: true, dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) });
    },
    disposeAll(): void {
      tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    },
  };
}

/** Имена единиц реальных фикстур Контрагенты/Начисления/ИнтернетМагазин (для параметризации тестов). */
export const KNOWN_FIXTURE_UNITS = {
  kontragenty: 'Справочник.Контрагенты',
  kontragentyFormaSpiska: 'Справочник.Контрагенты.Форма.ФормаСписка',
  kontragentyFormaElementa: 'Справочник.Контрагенты.Форма.ФормаЭлемента',
  kontragentyMaket: 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла',
  nachisleniya: 'РегистрРасчета.Начисления',
  nachisleniyaPererashchety: 'РегистрРасчета.Начисления.Перерасчет.Перерасчеты',
  internetMagazin: 'ВнешнийИсточникДанных.ИнтернетМагазин',
  internetMagazinZakazy: 'ВнешнийИсточникДанных.ИнтернетМагазин.Таблица.Заказы',
  internetMagazinZakazyFormaSpiska: 'ВнешнийИсточникДанных.ИнтернетМагазин.Таблица.Заказы.Форма.ФормаСписка',
  internetMagazinProdazhi: 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи',
  internetMagazinTovary: 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары',
  internetMagazinRegiony: 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Регионы',
} as const;
