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

/**
 * Отказы только по объектам, которые пытались захватить: члены захвата; при рекурсивном
 * захвате — и их подчинённые единицы; рекурсивный корень — любые.
 */
export function selectAttemptedRefusals(
  refusals: readonly RepositoryLockRefusal[],
  target: RepositoryTarget,
  attempt: { readonly members: readonly string[]; readonly recursive: boolean; readonly isRoot: boolean }
): { fullName: string; user: string }[] {
  const members = new Set(attempt.members);
  const attempted = (fullName: string): boolean => members.has(fullName)
    || (attempt.recursive && (attempt.isRoot || getRepositoryUnitAncestors(fullName).some((ancestor) => members.has(ancestor))));
  const selected: { fullName: string; user: string }[] = [];
  for (const refusal of refusals) {
    const fullName = resolveRefusedUnit(refusal.objectName, target);
    if (fullName && attempted(fullName)) {
      selected.push({ fullName, user: refusal.user });
    }
  }
  return selected;
}
