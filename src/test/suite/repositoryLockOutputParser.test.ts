import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseRepositoryLockRefusals,
  resolveRefusedUnit,
  selectAttemptedRefusals,
} from '../../infra/repository/RepositoryLockOutputParser';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { decodeLogFile } from '../../ui/commands/repository/RepositoryCommandRunner';
import { EXAMPLE_CF_221, LOCK_FIXTURE_VERSIONS, lockFixturePath, readScenario } from './support/repositoryLockFixtures';

/** Строки отказа захвата из вывода /Out Конфигуратора (реальный lock-refused.out.txt обеих платформ). */

const target: RepositoryTarget = { configRoot: EXAMPLE_CF_221, configKind: 'cf', displayName: 'ТорговыйУчет' };
const ROOT = getRootLockName(target);

for (const version of LOCK_FIXTURE_VERSIONS) {
  suite(`parseRepositoryLockRefusals — вывод отказа захвата платформы ${version}`, () => {
    test('отказы равны сценарию (строка корня и пробел в конце строки учтены)', () => {
      const output = decodeLogFile(fs.readFileSync(lockFixturePath(version, 'lock-refused.out.txt')));
      assert.ok(/\(Petrov\) \r?\n/.test(output), 'в реальном выводе после скобки стоит пробел');
      const refusals = parseRepositoryLockRefusals(output);
      assert.deepStrictEqual(
        refusals.map((item) => `${item.objectName}=${item.user}`).sort(),
        readScenario().refusals.map((item) => `${item.objectName}=${item.user}`).sort()
      );
    });
  });
}

suite('RepositoryLockOutputParser — разбор и отбор', () => {
  test('прочие строки (захвачен, не захвачен, отменён) игнорируются', () => {
    const output = [
      'Объект захвачен для редактирования: Справочник.Валюты',
      'Объект не захвачен для редактирования: Справочник.Банки',
      'Захват объекта отменен: Отчет.Запасы',
      'Объект захвачен для редактирования другим пользователем: Отчет.Запасы (Иван (бухгалтер))',
    ].join('\n');
    assert.deepStrictEqual(parseRepositoryLockRefusals(output), [{ objectName: 'Отчет.Запасы', user: 'Иван (бухгалтер)' }]);
  });

  const units: [string, string | null][] = [
    ['ТорговыйУчет', ROOT],
    ['Конфигурация.ТорговыйУчет', ROOT],
    ['Справочник.Контрагенты.Макет.ЗагрузкаИзФайла', 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла'],
    ['НеизвестныйВид.Х', null],
  ];
  for (const [objectName, expected] of units) {
    test(`resolveRefusedUnit: ${objectName} → ${String(expected)}`, () => {
      assert.strictEqual(resolveRefusedUnit(objectName, target), expected);
    });
  }

  const refusals = [
    { objectName: 'Справочник.Банки', user: 'Petrov' },
    { objectName: 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла', user: 'Petrov' },
    { objectName: 'ТорговыйУчет', user: 'Petrov' },
    { objectName: 'НеизвестныйВид.Х', user: 'Petrov' },
  ];

  test('нерекурсивно — только члены захвата', () => {
    assert.deepStrictEqual(
      selectAttemptedRefusals(refusals, target, { members: ['Справочник.Банки'], recursive: false, isRoot: false }),
      [{ fullName: 'Справочник.Банки', user: 'Petrov' }]
    );
  });

  test('рекурсивно — члены и их подчинённые единицы, посторонние отброшены', () => {
    assert.deepStrictEqual(
      selectAttemptedRefusals(refusals, target, { members: ['Справочник.Контрагенты'], recursive: true, isRoot: false }),
      [{ fullName: 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла', user: 'Petrov' }]
    );
  });

  test('рекурсивный корень — любые распознанные единицы', () => {
    assert.deepStrictEqual(
      selectAttemptedRefusals(refusals, target, { members: [ROOT], recursive: true, isRoot: true }).map((item) => item.fullName),
      ['Справочник.Банки', 'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла', ROOT]
    );
  });

  test('расширение: корень — имя расширения', () => {
    const extension: RepositoryTarget = { configRoot: path.join(EXAMPLE_CF_221, '..', 'cfe', 'EVOLC'), configKind: 'cfe', extensionName: 'EVOLC', displayName: 'EVOLC' };
    assert.strictEqual(resolveRefusedUnit('EVOLC', extension), getRootLockName(extension));
  });
});
