import * as assert from 'assert';
import * as fs from 'fs';
import {
  isRepositoryBindNotEmptyFailure,
  parseRepositoryBindUnmarkedLocks,
  resolveBindReportedUnits,
} from '../../infra/repository/RepositoryLockOutputParser';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { decodeLogFile } from '../../ui/commands/repository/RepositoryCommandRunner';
import {
  BIND_LOCKS_ROOT,
  EXAMPLE_CF_221,
  LOCK_FIXTURE_VERSIONS,
  lockFixturePath,
  must,
  readBindScenario,
  scenarioFixturePath,
  type LockFixtureVersion,
} from './support/repositoryLockFixtures';

/**
 * Вывод /ConfigurationRepositoryBindCfg (issue #106) — реальные bind-own-locks.out.txt и
 * bind-not-empty.out.txt обеих платформ (example/repository/2.21-bind).
 */

const TRADE: RepositoryTarget = { configRoot: EXAMPLE_CF_221, configKind: 'cf', displayName: 'ТорговыйУчет' };
const EMPTY: RepositoryTarget = { configRoot: EXAMPLE_CF_221, configKind: 'cf', displayName: 'Пустая' };
const FORM_ITEM = 'Справочник.Контрагенты.Форма.ФормаЭлемента';
const FORM_LIST = 'Справочник.Контрагенты.Форма.ФормаСписка';

function readBindOutput(version: LockFixtureVersion, file: string): string {
  return decodeLogFile(fs.readFileSync(scenarioFixturePath(BIND_LOCKS_ROOT, version, file)));
}

const expectedUnmarked = must(readBindScenario().binds[0].expect.unmarked, 'binds[0].expect.unmarked');

for (const version of LOCK_FIXTURE_VERSIONS) {
  suite(`parseRepositoryBindUnmarkedLocks — вывод привязки платформы ${version} (issue #106)`, () => {
    test('блок непомеченных захватов равен сценарию, порядок — как в выводе', () => {
      const output = readBindOutput(version, 'bind-own-locks.out.txt');
      assert.ok(output.includes('\r\n\t'), 'реальный вывод — CRLF, строки блока начинаются с таба');
      assert.deepStrictEqual(parseRepositoryBindUnmarkedLocks(output), expectedUnmarked);
    });

    test('LF вместо CRLF — тот же результат; строка «успешно завершено» в список не попадает', () => {
      const output = readBindOutput(version, 'bind-own-locks.out.txt').replace(/\r\n/g, '\n');
      const names = parseRepositoryBindUnmarkedLocks(output);
      assert.deepStrictEqual(names, expectedUnmarked);
      assert.ok(!names.some((name) => name.includes('успешно')));
    });

    test('без блока — []: отказ привязки, отказ захвата, пустой вывод', () => {
      assert.deepStrictEqual(parseRepositoryBindUnmarkedLocks(readBindOutput(version, 'bind-not-empty.out.txt')), []);
      assert.deepStrictEqual(parseRepositoryBindUnmarkedLocks(decodeLogFile(fs.readFileSync(lockFixturePath(version, 'lock-refused.out.txt')))), []);
      assert.deepStrictEqual(parseRepositoryBindUnmarkedLocks(''), []);
    });

    test('isRepositoryBindNotEmptyFailure: true только на отказе непустой конфигурации', () => {
      assert.strictEqual(isRepositoryBindNotEmptyFailure(readBindOutput(version, 'bind-not-empty.out.txt')), true);
      assert.strictEqual(isRepositoryBindNotEmptyFailure(readBindOutput(version, 'bind-own-locks.out.txt')), false);
      assert.strictEqual(isRepositoryBindNotEmptyFailure(decodeLogFile(fs.readFileSync(lockFixturePath(version, 'lock-refused.out.txt')))), false);
    });

    test('resolveBindReportedUnits: цель ТорговыйУчет — корень-сентинел и две формы, нераспознанных нет', () => {
      const resolved = resolveBindReportedUnits(parseRepositoryBindUnmarkedLocks(readBindOutput(version, 'bind-own-locks.out.txt')), TRADE);
      assert.deepStrictEqual(resolved, {
        fullNames: [getRootLockName(TRADE), FORM_LIST, FORM_ITEM].sort((left, right) => left.localeCompare(right, 'ru')),
        unrecognized: [],
      });
    });

    test('resolveBindReportedUnits: у пустого проекта корень хранилища — нераспознанный', () => {
      const resolved = resolveBindReportedUnits(parseRepositoryBindUnmarkedLocks(readBindOutput(version, 'bind-own-locks.out.txt')), EMPTY);
      assert.deepStrictEqual(resolved, { fullNames: [FORM_LIST, FORM_ITEM], unrecognized: ['ТорговыйУчет'] });
    });
  });
}

suite('resolveBindReportedUnits — повторы (issue #106)', () => {
  test('повторы распознанных и нераспознанных схлопываются', () => {
    assert.deepStrictEqual(resolveBindReportedUnits([FORM_ITEM, 'ТорговыйУчет', FORM_ITEM, 'ТорговыйУчет'], EMPTY), {
      fullNames: [FORM_ITEM],
      unrecognized: ['ТорговыйУчет'],
    });
  });

  test('повтор имени внутри блока вывода не дублируется', () => {
    const header = 'Обнаружены объекты, захваченные в хранилище, но непомеченные как захваченные в конфигурации:';
    assert.deepStrictEqual(parseRepositoryBindUnmarkedLocks(`${header}\r\n\t${FORM_ITEM}\r\n\t${FORM_ITEM}\r\n`), [FORM_ITEM]);
  });
});
