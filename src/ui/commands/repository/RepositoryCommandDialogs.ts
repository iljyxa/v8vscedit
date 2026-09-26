import * as vscode from 'vscode';

/** Пункт выбора диалога хранилища; значение отделено от текста, чтобы тексты можно было править свободно. */
export interface RepositoryChoiceItem<T> extends vscode.QuickPickItem {
  readonly value: T;
}

const REPOSITORY_VERSION_ERROR = 'Укажите номер версии хранилища — целое число больше нуля.';

/**
 * Режим «вместе с подчинёнными». Если подчинённых у единицы нет, вопрос не задаётся:
 * оба ответа дали бы одну и ту же операцию.
 */
export async function askRecursiveMode(
  title: string,
  nodeLabel: string,
  canApplyRecursively: boolean
): Promise<boolean | undefined> {
  if (!canApplyRecursively) {
    return false;
  }
  return pickRepositoryChoice(title, `Какие объекты затронуть для «${nodeLabel}»?`, [
    {
      label: 'Только выбранный объект',
      description: 'без подчинённых',
      detail: `Операция только над «${nodeLabel}»; его формы, макеты и другие подчинённые объекты хранилища не затрагиваются.`,
      value: false,
    },
    {
      label: 'Вместе с подчинёнными',
      description: 'рекурсивно',
      detail: 'Формы, макеты, перерасчёты и т.п.; для подсистемы — вложенные подсистемы и объекты её состава; для конфигурации — все объекты.',
      value: true,
    },
  ]);
}

export function pickUnlockForce(nodeLabel: string): Promise<boolean | undefined> {
  return pickRepositoryChoice('Освобождение объектов', `Как освободить «${nodeLabel}»?`, [
    {
      label: 'Освободить',
      description: 'без -force',
      detail: 'Если объект изменён в базе и не помещён, Конфигуратор откажет («Объект … был изменён») и ничего не освободит.',
      value: false,
    },
    {
      label: 'Освободить с отменой изменений',
      description: '-force',
      detail: 'Непомещённые изменения в базе будут потеряны: объект в базе вернётся к версии хранилища.',
      value: true,
    },
  ]);
}

export function pickDisconnectForce(displayName: string): Promise<boolean | undefined> {
  return pickRepositoryChoice('Отключение от хранилища', `Как отключить «${displayName}» от хранилища?`, [
    {
      label: 'Штатно',
      description: 'без -force',
      detail: 'Отключение будет отклонено, если есть захваченные изменённые объекты.',
      value: false,
    },
    {
      label: 'Принудительно',
      description: '-force',
      detail: 'Без аутентификации в хранилище и без проверки захваченных изменённых объектов: непомещённые изменения поместить уже не получится, а объекты остаются захваченными в хранилище — снять захват может администратор хранилища.',
      value: true,
    },
  ]);
}

/** Номер версии без пробелов по краям; `undefined` — пользователь отменил ввод. */
export async function promptRepositoryVersion(title: string): Promise<string | undefined> {
  const version = await vscode.window.showInputBox({
    title,
    prompt: 'Номер версии хранилища, которую нужно получить.',
    placeHolder: 'Например: 125',
    ignoreFocusOut: true,
    validateInput: validateRepositoryVersion,
  });
  return version?.trim();
}

/** Конфигуратор принимает только натуральный номер версии; ведущие нули — признак опечатки. */
export function validateRepositoryVersion(input: string): string | undefined {
  return /^[1-9]\d*$/.test(input.trim()) ? undefined : REPOSITORY_VERSION_ERROR;
}

async function pickRepositoryChoice<T>(
  title: string,
  placeHolder: string,
  items: readonly RepositoryChoiceItem<T>[]
): Promise<T | undefined> {
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true });
  return picked?.value;
}
