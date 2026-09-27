import type { RepositoryLockInfo } from '../../infra/repository/RepositoryLockState';

/**
 * Подсказка иконки состояния захвата: кто и когда захватил объект. Чистая функция без
 * vscode — дерево вызывает её в getTreeItem, поэтому без I/O.
 */

const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})$/;

/** `YYYY-MM-DDTHH:mm:ss` → `ДД.ММ.ГГГГ ЧЧ:ММ:СС`; нераспознанное значение — как есть. */
export function formatLockTimestamp(value: string): string {
  const match = TIMESTAMP_RE.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}` : value;
}

export function formatRepositoryLockTitle(info: RepositoryLockInfo): string {
  switch (info.state) {
    case 'free':
      return 'Не захвачено в хранилище';
    case 'own':
      if (info.syncedAt === undefined || info.user === undefined) {
        return 'Захвачено в хранилище';
      }
      if (!info.confirmed) {
        return `Захвачено в хранилище; сервер не подтверждает захват на ${formatLockTimestamp(info.syncedAt)}`;
      }
      return withDate(`Захвачено: ${info.user}`, info.lockedAt);
    case 'own-elsewhere':
      return `${withDate(`Захвачено вашим пользователем ${info.user} вне проекта`, info.lockedAt)} — захватите объект, чтобы редактировать`;
    case 'foreign':
      if (info.lockedAt === undefined && info.observedAt !== undefined) {
        return `Захвачено: ${info.user} (по отказу захвата ${formatLockTimestamp(info.observedAt)})`;
      }
      return withDate(`Захвачено: ${info.user}`, info.lockedAt);
  }
}

function withDate(text: string, lockedAt: string | undefined): string {
  return lockedAt === undefined ? text : `${text}, ${formatLockTimestamp(lockedAt)}`;
}
