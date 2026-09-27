import * as assert from 'assert';
import type { RepositoryLockInfo } from '../../infra/repository/RepositoryLockState';
import { formatLockTimestamp, formatRepositoryLockTitle } from '../../ui/tree/repositoryLockTitle';

/** Подсказка иконки состояния захвата для каждого варианта RepositoryLockInfo (issue #6). */
suite('repositoryLockTitle (issue #6)', () => {
  test('formatLockTimestamp: YYYY-MM-DDTHH:mm:ss → ДД.ММ.ГГГГ ЧЧ:ММ:СС; иное — как есть', () => {
    assert.strictEqual(formatLockTimestamp('2026-09-27T10:42:07'), '27.09.2026 10:42:07');
    assert.strictEqual(formatLockTimestamp('вчера'), 'вчера');
  });

  const cases: [string, RepositoryLockInfo, string][] = [
    ['свободен', { state: 'free' }, 'Не захвачено в хранилище'],
    ['свой без опроса', { state: 'own' }, 'Захвачено в хранилище'],
    ['свой с датой', { state: 'own', user: 'Admin', lockedAt: '2026-09-27T10:00:00', confirmed: true, syncedAt: '2026-09-27T12:00:00' }, 'Захвачено: Admin, 27.09.2026 10:00:00'],
    ['свой подтверждён без даты', { state: 'own', user: 'Admin', confirmed: true, syncedAt: '2026-09-27T12:00:00' }, 'Захвачено: Admin'],
    ['свой не подтверждён', { state: 'own', user: 'Admin', confirmed: false, syncedAt: '2026-09-27T12:00:00' }, 'Захвачено в хранилище; сервер не подтверждает захват на 27.09.2026 12:00:00'],
    ['свой вне проекта с датой', { state: 'own-elsewhere', user: 'Admin', lockedAt: '2026-09-27T09:00:00' }, 'Захвачено вашим пользователем Admin вне проекта, 27.09.2026 09:00:00 — захватите объект, чтобы редактировать'],
    ['свой вне проекта без даты', { state: 'own-elsewhere', user: 'Admin' }, 'Захвачено вашим пользователем Admin вне проекта — захватите объект, чтобы редактировать'],
    ['чужой с датой', { state: 'foreign', user: 'Petrov', lockedAt: '2026-09-27T08:00:00' }, 'Захвачено: Petrov, 27.09.2026 08:00:00'],
    ['чужой по отказу захвата', { state: 'foreign', user: 'Petrov', observedAt: '2026-09-27T13:00:00' }, 'Захвачено: Petrov (по отказу захвата 27.09.2026 13:00:00)'],
    ['чужой без дат', { state: 'foreign', user: 'Petrov' }, 'Захвачено: Petrov'],
  ];
  for (const [title, info, expected] of cases) {
    test(title, () => {
      assert.strictEqual(formatRepositoryLockTitle(info), expected);
    });
  }
});
