/**
 * Сравнение двух `ConfigDumpInfo.xml` (проектного и свежего `-configDumpInfoOnly`)
 * с группировкой по объектам-владельцам — основа инкрементального получения корня:
 * выгружаются только владельцы, у которых поменялась хотя бы одна версия.
 */

export interface ConfigDumpInfoDiffResult {
  changedOwners: string[];
  addedOwners: string[];
  removedOwners: string[];
}

export type RootIncrementalStrategy = 'none' | 'partial' | 'full';

/**
 * Порог абсолютного числа владельцев: частичная выгрузка сотен объектов по списку
 * медленнее одной полной выгрузки, поэтому выше порога выбирается полная.
 */
export const ROOT_INCREMENTAL_MAX_OWNERS = 400;
/** Порог доли затронутых владельцев от всех объектов конфигурации (включительно). */
export const ROOT_INCREMENTAL_MAX_SHARE = 0.5;

/** `Catalog.X.Form.Y.Form` → `Catalog.X`: владелец — первые два сегмента имени. */
export function extractDumpInfoOwner(name: string): string {
  const firstDot = name.indexOf('.');
  if (firstDot < 0) {
    return name;
  }
  const secondDot = name.indexOf('.', firstDot + 1);
  return secondDot < 0 ? name : name.slice(0, secondDot);
}

function groupByOwner(map: ReadonlyMap<string, string>): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const [name, version] of map) {
    const owner = extractDumpInfoOwner(name);
    let entries = result.get(owner);
    if (!entries) {
      entries = new Map<string, string>();
      result.set(owner, entries);
    }
    entries.set(name, version);
  }
  return result;
}

function sameEntries(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [name, version] of left) {
    if (right.get(name) !== version) {
      return false;
    }
  }
  return true;
}

export function diffConfigDumpInfo(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>
): ConfigDumpInfoDiffResult {
  const previousOwners = groupByOwner(previous);
  const nextOwners = groupByOwner(next);
  const changedOwners: string[] = [];
  const addedOwners: string[] = [];
  const removedOwners: string[] = [];
  for (const [owner, entries] of nextOwners) {
    const previousEntries = previousOwners.get(owner);
    if (!previousEntries) {
      addedOwners.push(owner);
    } else if (!sameEntries(previousEntries, entries)) {
      changedOwners.push(owner);
    }
  }
  for (const owner of previousOwners.keys()) {
    if (!nextOwners.has(owner)) {
      removedOwners.push(owner);
    }
  }
  const byName = (left: string, right: string): number => left.localeCompare(right);
  return {
    changedOwners: changedOwners.sort(byName),
    addedOwners: addedOwners.sort(byName),
    removedOwners: removedOwners.sort(byName),
  };
}

/**
 * `null` вместо сравнения (нет проектного ConfigDumpInfo.xml, сбой UpdateInfo) —
 * всегда полная выгрузка: без эталона нельзя доказать, что изменений нет.
 */
export function decideRootIncrementalStrategy(
  diff: ConfigDumpInfoDiffResult | null,
  totalOwners: number
): RootIncrementalStrategy {
  if (!diff) {
    return 'full';
  }
  const affected = diff.changedOwners.length + diff.addedOwners.length + diff.removedOwners.length;
  if (affected === 0) {
    return 'none';
  }
  if (affected > ROOT_INCREMENTAL_MAX_OWNERS) {
    return 'full';
  }
  if (totalOwners > 0 && affected / totalOwners > ROOT_INCREMENTAL_MAX_SHARE) {
    return 'full';
  }
  return 'partial';
}
