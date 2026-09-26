import * as path from 'path';

/**
 * Роль вкладки относительно файла: обычный редактор, правая (изменяемая) или левая
 * сторона сравнения. Readonly-команды VS Code действуют только на основную сторону
 * активного редактора — у сравнения это правая, поэтому левую сторону нельзя
 * переключить активацией самого сравнения.
 */
export type ReadonlyTabRole = 'text' | 'diff-modified' | 'diff-original';

export interface ReadonlyTabCandidate {
  path: string;
  role: ReadonlyTabRole;
  visible: boolean;
  viewColumn: number;
}

/**
 * `activate` — активировать саму вкладку; `temporary` — файл открыт только левой
 * стороной сравнения, нужна временная обычная вкладка; `defer` — применить при
 * следующей активации скрытой вкладки.
 */
export type ReadonlyApplyRoute<T extends ReadonlyTabCandidate> =
  | { kind: 'activate'; tab: T }
  | { kind: 'temporary'; tab: T }
  | { kind: 'defer'; tab: T };

/**
 * Левая сторона сравнения применяется сразу даже в скрытом сравнении: событие
 * активации для сравнения приходит по правой стороне, отложенный переход левой
 * не сработал бы никогда.
 */
export function isImmediatelyApplicable(tab: Pick<ReadonlyTabCandidate, 'role' | 'visible'>): boolean {
  return tab.role === 'diff-original' || tab.visible;
}

function normalizeKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

/**
 * Видимая основная вкладка активируется без побочных эффектов, поэтому она важнее
 * временной вкладки для левой стороны сравнения; скрытая основная без левой
 * стороны ждёт собственной активации.
 */
export function selectReadonlyApplyRoute<T extends ReadonlyTabCandidate>(
  tabs: readonly T[],
  filePath: string
): ReadonlyApplyRoute<T> | undefined {
  const key = normalizeKey(filePath);
  const matches = tabs.filter((tab) => normalizeKey(tab.path) === key);
  const primary = matches.filter((tab) => tab.role !== 'diff-original');
  const visiblePrimary = primary.find((tab) => tab.visible);
  if (visiblePrimary) {
    return { kind: 'activate', tab: visiblePrimary };
  }
  const originals = matches.filter((tab) => tab.role === 'diff-original');
  const original = originals.find((tab) => tab.visible) ?? originals.find((tab) => !tab.visible);
  if (original) {
    return { kind: 'temporary', tab: original };
  }
  return primary.length > 0 ? { kind: 'defer', tab: primary[0] } : undefined;
}
