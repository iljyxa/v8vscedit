import { SupportMode } from '../../infra/support/SupportInfoService';

/**
 * Тексты причины блокировки поддержкой и формат суффиксов поддержки в
 * `contextValue` узла дерева. Без `vscode`: суффикс пишет
 * `MetadataTreeProvider`, а подсказку по нему строит
 * `UniversalPanelViewProvider`, и расхождение их представлений о формате
 * суффикса уже приводило к накоплению `-support<n>`.
 */

/**
 * Маркер причины: вся конфигурация закрыта флагом «изменения запрещены» в
 * настройках поддержки. Дописывается поверх `-support2`, т.к. режим при этом
 * остаётся `Locked`, а отличается лишь способ снять запрет.
 */
export const SUPPORT_CHANGES_FORBIDDEN_SUFFIX = '-supportChangesForbidden';

/**
 * Снимает все суффиксы поддержки. Без якоря `$`: после суффикса поддержки
 * `applyRepositoryDecoration` дописывает суффиксы хранилища, и анкерная
 * регулярка не находила прежний суффикс при повторном `getTreeItem`.
 */
export const SUPPORT_SUFFIX_RE = /-support(?:\d|ChangesForbidden)/g;

/** Единственное место формата суффикса режима поддержки в `contextValue`. */
export function supportModeSuffix(mode: SupportMode): string {
  return `-support${String(mode)}`;
}

/** Форма для встраивания в предложение («Добавление запрещено: …»). */
export const CHANGES_FORBIDDEN_REASON = 'изменения конфигурации запрещены в настройках поддержки';

/** Причина `Locked` без флага: запрет поставщика на конкретный объект. */
export const OBJECT_SUPPORT_LOCKED_REASON = 'объект находится на поддержке с запретом редактирования';

/**
 * Причина отказа для узла в режиме `Locked`, в форме для встраивания в
 * предложение. Флаг проверяется отдельно от режима: при нём `Locked` получает
 * и объект вне поставки, и подсказка «объект на поддержке» ведёт не туда.
 */
export function supportLockedReasonOf(changesForbidden: boolean): string {
  return changesForbidden ? CHANGES_FORBIDDEN_REASON : OBJECT_SUPPORT_LOCKED_REASON;
}

/** Самостоятельная подсказка индикатора. */
export const CHANGES_FORBIDDEN_TITLE = 'Изменения конфигурации запрещены в настройках поддержки';

/**
 * Подсказка режима Removed: объект редактируется так же свободно, как объект вне
 * поставки, поэтому отличие для пользователя — только в потере обновлений.
 */
export const SUPPORT_REMOVED_TITLE = 'Снят с поддержки: обновления поставщика на объект не придут';

export interface SupportIndicator {
  readonly icon: 'support-locked' | 'support-editable' | 'support-none' | 'support-removed';
  readonly title: string;
}

/** Индикатор поддержки узла по суффиксам его `contextValue`; `undefined` — суффикса нет. */
export function supportIndicatorOf(contextValue: string): SupportIndicator | undefined {
  // Маркер проверяется первым: он сопровождает `-support2` и уточняет его причину.
  if (contextValue.includes(SUPPORT_CHANGES_FORBIDDEN_SUFFIX)) {
    return { icon: 'support-locked', title: CHANGES_FORBIDDEN_TITLE };
  }
  if (contextValue.includes(supportModeSuffix(SupportMode.Removed))) {
    return { icon: 'support-removed', title: SUPPORT_REMOVED_TITLE };
  }
  if (contextValue.includes(supportModeSuffix(SupportMode.Locked))) {
    return { icon: 'support-locked', title: 'На поддержке, редактирование запрещено' };
  }
  if (contextValue.includes(supportModeSuffix(SupportMode.Editable))) {
    return { icon: 'support-editable', title: 'На поддержке, редактирование разрешено' };
  }
  if (contextValue.includes(supportModeSuffix(SupportMode.None))) {
    return { icon: 'support-none', title: 'Не на поддержке' };
  }
  return undefined;
}

/** Режим поддержки узла в контракте webview (`TreeNodeDto.supportMode`). */
export type SupportModeDto = 'none' | 'editable' | 'locked' | 'removed';

/** Режим для webview по суффиксу `contextValue`; без суффикса — `'none'`. */
export function supportModeDtoOf(contextValue: string): SupportModeDto {
  if (contextValue.includes(supportModeSuffix(SupportMode.Locked))) {return 'locked';}
  if (contextValue.includes(supportModeSuffix(SupportMode.Editable))) {return 'editable';}
  if (contextValue.includes(supportModeSuffix(SupportMode.Removed))) {return 'removed';}
  return 'none';
}
