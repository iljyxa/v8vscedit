import {
  buildRootDumpListName,
  getRepositoryUnitAncestors,
  getRootLockName,
  parseRepositoryUnit,
} from './RepositoryObjectNames';
import type { RepositoryTarget } from './RepositoryService';

/**
 * Отказ захвата в выводе /Out Конфигуратора: на каждый чужой объект — строка
 * `Объект захвачен для редактирования другим пользователем: <Имя> (<Пользователь>) `.
 * Пакетный режим не выводит список захватов и дату захвата, поэтому отказ — единственный
 * след чужого захвата при захвате, и используется только для объектов, которые
 * пытались захватить.
 */
export interface RepositoryLockRefusal {
  readonly objectName: string;
  readonly user: string;
}

const REFUSAL_RE = /^Объект захвачен для редактирования другим пользователем: (\S+) \((.*)\)\s*$/gm;

export function parseRepositoryLockRefusals(output: string): RepositoryLockRefusal[] {
  return [...output.replace(/\r\n?/g, '\n').matchAll(REFUSAL_RE)].map((match) => ({ objectName: match[1], user: match[2] }));
}

/**
 * Имя объекта из вывода → fullName state.json. Корень платформа печатает голым именем
 * конфигурации (`ТорговыйУчет`, установлено на 8.3.27 и 8.5.1); форма `Конфигурация.<Имя>`
 * из -listFile тоже принимается. Нераспознанный вид — `null`.
 */
export function resolveRefusedUnit(objectName: string, target: RepositoryTarget): string | null {
  if (objectName === target.displayName || objectName === buildRootDumpListName(target)) {
    return getRootLockName(target);
  }
  return parseRepositoryUnit(objectName) ? objectName : null;
}

/** Что пытались захватить: члены `-Objects`, режим и признак корня. */
export interface RepositoryLockAttempt {
  readonly members: readonly string[];
  readonly recursive: boolean;
  readonly isRoot: boolean;
}

/**
 * Итог /Out захвата с кодом 1 (issue #87): платформа захватывает всё, что может, и
 * печатает строку успеха по каждой вновь захваченной единице — отказ по одной единице
 * не отменяет захват остальных. Уже захваченные нами единицы строки не получают.
 */
export interface RepositoryLockOutputSummary {
  /** fullName попытанных единиц со строкой успеха (корень — сентинел), без повторов. */
  readonly granted: readonly string[];
  /** Отказы по попытанным единицам (как selectAttemptedRefusals). */
  readonly refused: readonly { fullName: string; user: string }[];
}

const GRANT_RE = /^Объект захвачен для редактирования: (\S+)[ \t]*$/gm;

/** Имена объектов из строк `Объект захвачен для редактирования: <Имя>` (CRLF, хвостовые пробелы допустимы). */
export function parseRepositoryLockGrants(output: string): string[] {
  return [...output.replace(/\r\n?/g, '\n').matchAll(GRANT_RE)].map((match) => match[1]);
}

/**
 * Единицу пытались захватить: член захвата; при рекурсивном захвате — и подчинённая
 * единица члена; рекурсивный корень — любая. Посторонние строки вывода не относятся
 * к этой операции и не должны менять состояние.
 */
function createAttemptedPredicate(attempt: RepositoryLockAttempt): (fullName: string) => boolean {
  const members = new Set(attempt.members);
  return (fullName) => members.has(fullName)
    || (attempt.recursive && (attempt.isRoot || getRepositoryUnitAncestors(fullName).some((ancestor) => members.has(ancestor))));
}

/**
 * Отказы только по объектам, которые пытались захватить: члены захвата; при рекурсивном
 * захвате — и их подчинённые единицы; рекурсивный корень — любые.
 */
export function selectAttemptedRefusals(
  refusals: readonly RepositoryLockRefusal[],
  target: RepositoryTarget,
  attempt: RepositoryLockAttempt
): { fullName: string; user: string }[] {
  const attempted = createAttemptedPredicate(attempt);
  const selected: { fullName: string; user: string }[] = [];
  for (const refusal of refusals) {
    const fullName = resolveRefusedUnit(refusal.objectName, target);
    if (fullName && attempted(fullName)) {
      selected.push({ fullName, user: refusal.user });
    }
  }
  return selected;
}

/**
 * Итог вывода захвата по попытанным единицам: строки успеха → fullName (голое имя
 * конфигурации/расширения → сентинел корня), нераспознанные виды и посторонние
 * единицы отброшены; отказы — как selectAttemptedRefusals.
 */
export function summarizeRepositoryLockOutput(
  output: string,
  target: RepositoryTarget,
  attempt: RepositoryLockAttempt
): RepositoryLockOutputSummary {
  const attempted = createAttemptedPredicate(attempt);
  const granted = new Set<string>();
  for (const objectName of parseRepositoryLockGrants(output)) {
    const fullName = resolveRefusedUnit(objectName, target);
    if (fullName && attempted(fullName)) {
      granted.add(fullName);
    }
  }
  return {
    granted: [...granted],
    refused: selectAttemptedRefusals(parseRepositoryLockRefusals(output), target, attempt),
  };
}

/**
 * Какие единицы записать захваченными при частичном отказе: кандидаты без отказанных и
 * без потомков отказанных, у которых нет своей строки успеха, плюс все granted.
 * Подчинённая единица отказанного якоря без строки успеха на сервере не захвачена —
 * у неё нет «своего» захвата, который мог бы удержаться. Сортировка — как в state.json.
 */
export function selectLockedMembers(candidates: readonly string[], summary: RepositoryLockOutputSummary): string[] {
  const refused = new Set(summary.refused.map((item) => item.fullName));
  const granted = new Set(summary.granted);
  const selected = new Set<string>();
  for (const fullName of [...candidates, ...summary.granted]) {
    if (refused.has(fullName)) {
      continue;
    }
    if (granted.has(fullName) || !getRepositoryUnitAncestors(fullName).some((ancestor) => refused.has(ancestor))) {
      selected.add(fullName);
    }
  }
  return [...selected].sort((left, right) => left.localeCompare(right, 'ru'));
}
