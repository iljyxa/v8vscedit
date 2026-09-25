import * as path from 'path';
import type { ConfigEntry } from '../../domain/Configuration';
import { parseConfigXml } from '../xml';
import {
  diffHashSnapshots,
  loadHashCache,
  saveHashCache,
} from '../cache/HashCache';
import {
  buildHashSnapshotWithStatIndex,
  loadFileStatIndex,
  saveFileStatIndex,
  type FileStatIndex,
  type HashSnapshotWithStatIndex,
} from '../cache/FileStatIndex';
import { buildMetadataCacheScopeKey, loadMetadataCache, saveMetadataCacheForEntry } from '../cache/MetadataCache';
import { formatPerfLine } from '../support/PerfLog';

export interface ChangedConfiguration {
  kind: 'cf' | 'cfe';
  rootPath: string;
  name: string;
  changedFilesCount: number;
}

export type ChangeDetectorPhase = 'hash-cache' | 'metadata-cache' | 'detect';

/**
 * Длительность одной фазы по одной конфигурации. Нужна, чтобы по логу реальной
 * выгрузки решать, что именно тормозит активацию, а не гадать.
 */
export interface ChangeDetectorTiming {
  phase: ChangeDetectorPhase;
  configurationName: string;
  durationMs: number;
  /** Есть только у фаз, строящих снапшот хешей. */
  files?: { total: number; hashed: number };
}

/**
 * Приёмник таймингов со своими часами: `now` детектора — время по эпохе для
 * racy-проверки stat-индекса, а для длительностей нужен монотонный секундомер,
 * не прыгающий при коррекции системных часов.
 */
export interface ChangeDetectorTimingObserver {
  report(timing: ChangeDetectorTiming): void;
  clock?: () => number;
}

const PHASE_LABELS: Record<ChangeDetectorPhase, string> = {
  'hash-cache': 'хеш-кэш',
  'metadata-cache': 'кэш метаданных',
  detect: 'проверка изменений',
};

export function formatChangeDetectorTiming(timing: ChangeDetectorTiming): string {
  const details = timing.files
    ? `файлов ${String(timing.files.total)}, перехешировано ${String(timing.files.hashed)}`
    : undefined;
  return formatPerfLine(`${PHASE_LABELS[timing.phase]} «${timing.configurationName}»`, timing.durationMs, details);
}

/**
 * Определяет, в каких XML-исходниках есть изменения относительно локального хеш-кэша.
 */
export class ConfigurationChangeDetector {
  constructor(
    private readonly projectRoot: string,
    private readonly now: () => number = () => Date.now(),
    private readonly timingObserver?: ChangeDetectorTimingObserver
  ) {}

  describe(entry: ConfigEntry, changedFilesCount: number): ChangedConfiguration {
    const scope = this.resolveScope(entry);
    return {
      kind: entry.kind,
      rootPath: entry.rootPath,
      name: scope.name,
      changedFilesCount,
    };
  }

  /**
   * Создаёт первичный хеш-кэш для конфигураций, у которых его ещё нет.
   */
  ensureCaches(entries: ConfigEntry[], reportStatus?: (message: string) => void): number {
    let created = 0;
    for (const entry of entries) {
      const scope = this.resolveScope(entry);
      const previous = loadHashCache(this.projectRoot, scope.scopeKey);
      const metadata = loadMetadataCache(this.projectRoot, scope.scopeKey);
      const hasHashCache = Boolean(previous.generatedAt || Object.keys(previous.files).length > 0);
      if (hasHashCache && metadata) {
        continue;
      }

      let entryCreated = false;
      if (!hasHashCache) {
        reportStatus?.(`Инициализация хеш-кэша: ${scope.name}`);
        const startedAt = this.startTiming();
        const built = this.buildSnapshot(scope.scopeKey, entry.rootPath);
        saveHashCache(this.projectRoot, built.snapshot);
        this.reportTiming('hash-cache', scope.name, startedAt, built);
        entryCreated = true;
      }
      if (!metadata) {
        reportStatus?.(`Инициализация дерева метаданных: ${scope.name}`);
        const startedAt = this.startTiming();
        saveMetadataCacheForEntry(this.projectRoot, scope.scopeKey, entry);
        this.reportTiming('metadata-cache', scope.name, startedAt);
        entryCreated = true;
      }
      if (entryCreated) {
        created += 1;
      }
    }
    return created;
  }

  detect(entries: ConfigEntry[]): ChangedConfiguration[] {
    const result: ChangedConfiguration[] = [];

    for (const entry of entries) {
      const startedAt = this.startTiming();
      const scope = this.resolveScope(entry);
      const previous = loadHashCache(this.projectRoot, scope.scopeKey);
      const built = this.buildSnapshot(scope.scopeKey, entry.rootPath);
      const diff = diffHashSnapshots(previous, built.snapshot);
      this.reportTiming('detect', scope.name, startedAt, built);
      const changedFilesCount = diff.added.length + diff.modified.length + diff.deleted.length;

      if (changedFilesCount === 0) {
        continue;
      }

      result.push({
        kind: entry.kind,
        rootPath: entry.rootPath,
        name: scope.name,
        changedFilesCount,
      });
    }

    return result.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'cf' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  /**
   * Строит снапшот хешей через stat-индекс, чтобы повторные активации без правок
   * выгрузки не читали содержимое всех файлов.
   */
  private buildSnapshot(scopeKey: string, rootPath: string): HashSnapshotWithStatIndex {
    const previous = loadFileStatIndex(this.projectRoot, scopeKey);
    const result = buildHashSnapshotWithStatIndex(scopeKey, rootPath, previous, this.now());
    if (result.indexChanged) {
      this.persistStatIndex(result.index);
    }
    return result;
  }

  private startTiming(): number {
    return this.timingClock();
  }

  private reportTiming(
    phase: ChangeDetectorPhase,
    configurationName: string,
    startedAt: number,
    built?: HashSnapshotWithStatIndex
  ): void {
    if (!this.timingObserver) {
      return;
    }
    const timing: ChangeDetectorTiming = { phase, configurationName, durationMs: this.timingClock() - startedAt };
    if (built) {
      timing.files = { total: Object.keys(built.snapshot.files).length, hashed: built.hashedCount };
    }
    this.timingObserver.report(timing);
  }

  private timingClock(): number {
    return this.timingObserver?.clock?.() ?? performance.now();
  }

  private persistStatIndex(index: FileStatIndex): void {
    try {
      saveFileStatIndex(this.projectRoot, index);
    } catch {
      // Индекс — только ускоритель: без него следующий проход просто перехеширует
      // выгрузку. Раньше detect на диск не писал вовсе, и сбой записи здесь не
      // должен обрывать reloadEntries при активации расширения.
    }
  }

  private resolveScope(entry: ConfigEntry): { name: string; scopeKey: string } {
    const configXmlPath = path.join(entry.rootPath, 'Configuration.xml');
    const info = parseConfigXml(configXmlPath);
    return {
      name: info.name,
      scopeKey: buildMetadataCacheScopeKey(entry, info),
    };
  }
}
