import * as path from 'path';

/**
 * Чистое планирование readonly-переходов открытых вкладок после изменения захватов
 * хранилища (без vscode): решает, какие файлы и в какое состояние перевести сейчас
 * (видимые вкладки), а какие — при следующей активации (скрытые вкладки).
 */
export interface ReadonlyTransitionInput {
  openFiles: readonly { path: string; visible: boolean }[];
  /** Объекты, чьё состояние захвата изменило событие. */
  changedOwnerFullNames: readonly string[];
  /** Все объекты с известным состоянием захвата после события. */
  allObjects: readonly string[];
  configRoot: string;
  /** Единица хранилища файла и её предки до владельца верхнего уровня; `[]` — не распознан. */
  ownerChainOf: (filePath: string) => readonly string[];
  /** Желаемое состояние: `true` — редактирование запрещено поддержкой или хранилищем. */
  isRestricted: (filePath: string) => boolean;
}

export interface ReadonlyTransition {
  path: string;
  readonly: boolean;
}

export interface ReadonlyTransitionPlan {
  applyNow: ReadonlyTransition[];
  defer: ReadonlyTransition[];
}

function normalizeKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function isInsideRoot(filePath: string, configRoot: string): boolean {
  const relative = path.relative(normalizeKey(configRoot), normalizeKey(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Файл затронут, если хотя бы одно звено его цепочки владения есть в
 * `changedOwnerFullNames` или `allObjects`: событие владельца касается и его
 * подчинённых единиц, событие единицы — только её файлов. Остальные вкладки не
 * трогаются, чтобы не перебивать чужое состояние readonly.
 * Один файл в нескольких вкладках планируется один раз; видимая вкладка важнее.
 */
export function planReadonlyTransitions(input: ReadonlyTransitionInput): ReadonlyTransitionPlan {
  const affectedOwners = new Set([...input.changedOwnerFullNames, ...input.allObjects]);
  const byKey = new Map<string, { path: string; visible: boolean }>();
  for (const file of input.openFiles) {
    if (!isInsideRoot(file.path, input.configRoot)) {
      continue;
    }
    if (!input.ownerChainOf(file.path).some((owner) => affectedOwners.has(owner))) {
      continue;
    }
    const key = normalizeKey(file.path);
    const known = byKey.get(key);
    byKey.set(key, { path: known?.path ?? file.path, visible: (known?.visible ?? false) || file.visible });
  }
  const plan: ReadonlyTransitionPlan = { applyNow: [], defer: [] };
  for (const file of byKey.values()) {
    const transition = { path: file.path, readonly: input.isRestricted(file.path) };
    (file.visible ? plan.applyNow : plan.defer).push(transition);
  }
  return plan;
}
