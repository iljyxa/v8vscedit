/**
 * Issue #39 — явный исход команд конфигурации/расширения
 * (`src/ui/commands/ext/configurationCommandOutcome.ts`).
 *
 * Модуль по контракту архитектора не импортирует `vscode`/`fs`/`path` — чистые
 * функции и дискриминированный союз, единственный реалистичный источник
 * поведения — сам модуль на детерминированных входах (мокать нечего).
 */
import * as assert from 'assert';
import {
  CONFIGURATION_COMMAND_STATUSES,
  type ConfigurationCommandOutcome,
  type ConfigurationCommandStatus,
  failedOutcome,
  isConfigurationCommandSucceeded,
} from '../../ui/commands/ext/configurationCommandOutcome';

/** По одному валидному представителю каждого статуса — форма поля зависит от status. */
function buildOutcome(status: ConfigurationCommandStatus): ConfigurationCommandOutcome {
  switch (status) {
    case 'done':
      return { status: 'done', completed: ['Основная конфигурация'] };
    case 'no-changes':
      return { status: 'no-changes' };
    case 'no-targets':
      return { status: 'no-targets' };
    case 'cancelled':
      return { status: 'cancelled' };
    case 'busy':
      return { status: 'busy', heldBy: 'Импорт конфигураций' };
    case 'failed':
      return { status: 'failed', completed: ['Основная конфигурация'], stoppedAt: 'EVOLC' };
  }
}

suite('configurationCommandOutcome', () => {
  suite('CONFIGURATION_COMMAND_STATUSES', () => {
    test('ровно 6 уникальных статусов в задокументированном порядке', () => {
      assert.deepStrictEqual(
        CONFIGURATION_COMMAND_STATUSES,
        ['done', 'no-changes', 'no-targets', 'cancelled', 'busy', 'failed']
      );
      assert.strictEqual(new Set(CONFIGURATION_COMMAND_STATUSES).size, 6);
    });
  });

  suite('isConfigurationCommandSucceeded', () => {
    const EXPECTED_SUCCESS: Record<ConfigurationCommandStatus, boolean> = {
      done: true,
      'no-changes': true,
      'no-targets': false,
      cancelled: false,
      busy: false,
      failed: false,
    };

    CONFIGURATION_COMMAND_STATUSES.forEach((status: ConfigurationCommandStatus) => {
      test(`"${status}" → result=${String(EXPECTED_SUCCESS[status])}`, () => {
        const outcome = buildOutcome(status);
        assert.strictEqual(isConfigurationCommandSucceeded(outcome), EXPECTED_SUCCESS[status]);
      });
    });
  });

  suite('failedOutcome', () => {
    test('{stoppedAt} — completed сохранён, stoppedAt задан, error отсутствует', () => {
      const outcome = failedOutcome(['Основная конфигурация'], { stoppedAt: 'EVOLC' });
      assert.deepStrictEqual(outcome, {
        status: 'failed',
        completed: ['Основная конфигурация'],
        stoppedAt: 'EVOLC',
      });
      assert.strictEqual((outcome as { error?: unknown }).error, undefined);
    });

    test('{error: Error} — сообщение ошибки, stoppedAt отсутствует', () => {
      const outcome = failedOutcome([], { error: new Error('boom') });
      assert.deepStrictEqual(outcome, { status: 'failed', completed: [], error: 'boom' });
      assert.strictEqual((outcome as { stoppedAt?: unknown }).stoppedAt, undefined);
    });

    test('{error: строка} — сохраняется как есть', () => {
      const outcome = failedOutcome([], { error: 'строка ошибки' });
      assert.deepStrictEqual(outcome, { status: 'failed', completed: [], error: 'строка ошибки' });
    });

    test('{error: число} — приводится через String()', () => {
      const outcome = failedOutcome([], { error: 42 });
      assert.deepStrictEqual(outcome, { status: 'failed', completed: [], error: '42' });
    });

    test('completed с несколькими именами сохраняется в исходном порядке', () => {
      const outcome = failedOutcome(['Основная конфигурация', 'EVOLC'], { stoppedAt: 'ExtraExt' });
      assert.deepStrictEqual((outcome as { completed: readonly string[] }).completed, ['Основная конфигурация', 'EVOLC']);
    });

    test('isConfigurationCommandSucceeded(failedOutcome(...)) всегда false', () => {
      assert.strictEqual(isConfigurationCommandSucceeded(failedOutcome([], { stoppedAt: 'X' })), false);
      assert.strictEqual(isConfigurationCommandSucceeded(failedOutcome([], { error: 'x' })), false);
    });
  });
});
