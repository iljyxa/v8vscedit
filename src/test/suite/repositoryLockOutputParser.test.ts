import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseRepositoryLockGrants,
  parseRepositoryLockRefusals,
  resolveRefusedUnit,
  selectAttemptedRefusals,
  selectLockedMembers,
  summarizeRepositoryLockOutput,
  type RepositoryLockOutputSummary,
} from '../../infra/repository/RepositoryLockOutputParser';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import { decodeLogFile } from '../../ui/commands/repository/RepositoryCommandRunner';
import {
  EXAMPLE_CF_221,
  LOCK_FIXTURE_VERSIONS,
  lockFixturePath,
  PARTIAL_LOCKS_ROOT,
  PARTIAL_ROOT_ROOT,
  readScenario,
  readScenarioAt,
  scenarioFixturePath,
} from './support/repositoryLockFixtures';

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

/**
 * Issue #87: строки успеха захвата. Реальный вывод обеих платформ: при коде 1 сервер
 * захватывает всё, что может, и печатает строку по каждой вновь захваченной единице.
 */
const GRANT_LOGS: { root: string; log: string }[] = [
  { root: PARTIAL_LOCKS_ROOT, log: 'lock-recursive-subordinate-refused.out.txt' },
  { root: PARTIAL_LOCKS_ROOT, log: 'lock-recursive-anchor-refused.out.txt' },
  { root: PARTIAL_LOCKS_ROOT, log: 'lock-recursive-own-and-refused.out.txt' },
  { root: PARTIAL_ROOT_ROOT, log: 'lock-root-recursive-refused.out.txt' },
];

function readLog(root: string, version: (typeof LOCK_FIXTURE_VERSIONS)[number], log: string): string {
  return decodeLogFile(fs.readFileSync(scenarioFixturePath(root, version, log)));
}

for (const version of LOCK_FIXTURE_VERSIONS) {
  suite(`parseRepositoryLockGrants — вывод захвата платформы ${version} (issue #87)`, () => {
    test('lock-refused.out.txt: единственная строка успеха — Справочник.Валюты', () => {
      const output = decodeLogFile(fs.readFileSync(lockFixturePath(version, 'lock-refused.out.txt')));
      assert.deepStrictEqual(parseRepositoryLockGrants(output), ['Справочник.Валюты']);
    });

    for (const { root, log } of GRANT_LOGS) {
      test(`${path.basename(root)}/${log}: строки успеха и отказа равны expect шага`, () => {
        const step = readScenarioAt(root).steps.find((item) => item.log === log);
        assert.ok(step?.expect, `в сценарии нет expect для ${log}`);
        const output = readLog(root, version, log);
        assert.deepStrictEqual([...parseRepositoryLockGrants(output)].sort(), [...step.expect.grants].sort());
        assert.deepStrictEqual(
          parseRepositoryLockRefusals(output).map((item) => `${item.objectName}=${item.user}`).sort(),
          step.expect.refusals.map((item) => `${item.objectName}=${item.user}`).sort()
        );
      });
    }
  });
}

suite('RepositoryLockOutputParser — строки успеха захвата (issue #87)', () => {
  test('отказ, «не захвачен», «отменён» строками успеха не считаются', () => {
    const output = [
      'Объект захвачен для редактирования другим пользователем: Справочник.Банки (Petrov) ',
      'Объект не захвачен для редактирования: Справочник.Банки',
      'Захват объекта отменен: Отчет.Запасы',
      'Объект захвачен для редактирования: Справочник.Валюты',
    ].join('\n');
    assert.deepStrictEqual(parseRepositoryLockGrants(output), ['Справочник.Валюты']);
  });

  test('CRLF и хвостовой пробел', () => {
    const output = 'Объект захвачен для редактирования: Справочник.Валюты \r\nОбъект захвачен для редактирования: Справочник.Банки\r\n';
    assert.deepStrictEqual(parseRepositoryLockGrants(output), ['Справочник.Валюты', 'Справочник.Банки']);
  });

  test('пустой вывод — пусто', () => {
    assert.deepStrictEqual(parseRepositoryLockGrants(''), []);
  });
});

suite('summarizeRepositoryLockOutput — попытанные единицы (issue #87)', () => {
  const lockRefused = (): string => decodeLogFile(fs.readFileSync(lockFixturePath('8.5.1', 'lock-refused.out.txt')));

  test('нерекурсивно: lock-refused при захвате Валют — выдана, отказов по попытанным нет', () => {
    assert.deepStrictEqual(
      summarizeRepositoryLockOutput(lockRefused(), target, { members: ['Справочник.Валюты'], recursive: false, isRoot: false }),
      { granted: ['Справочник.Валюты'], refused: [] }
    );
  });

  test('нерекурсивно: lock-refused при захвате Банков — ничего не выдано, отказ Банков', () => {
    assert.deepStrictEqual(
      summarizeRepositoryLockOutput(lockRefused(), target, { members: ['Справочник.Банки'], recursive: false, isRoot: false }),
      { granted: [], refused: [{ fullName: 'Справочник.Банки', user: 'Petrov' }] }
    );
  });

  test('нерекурсивно: подчинённая строка успеха не относится к члену', () => {
    const output = 'Объект захвачен для редактирования: Справочник.ПричиныВозврата.Форма.ФормаЭлемента';
    assert.deepStrictEqual(
      summarizeRepositoryLockOutput(output, target, { members: ['Справочник.ПричиныВозврата'], recursive: false, isRoot: false }).granted,
      []
    );
  });

  test('рекурсивно: подчинённые единицы членов (реальный lock-recursive-anchor-refused)', () => {
    const output = readLog(PARTIAL_LOCKS_ROOT, '8.5.1', 'lock-recursive-anchor-refused.out.txt');
    assert.deepStrictEqual(
      summarizeRepositoryLockOutput(output, target, { members: ['Справочник.РолиКонтактныхЛиц'], recursive: true, isRoot: false }),
      {
        granted: ['Справочник.РолиКонтактныхЛиц.Форма.ФормаЭлемента'],
        refused: [{ fullName: 'Справочник.РолиКонтактныхЛиц', user: 'Petrov' }],
      }
    );
  });

  test('рекурсивный корень: любые единицы, голое имя корня — сентинел (реальный lock-root-recursive-refused)', () => {
    const output = readLog(PARTIAL_ROOT_ROOT, '8.5.1', 'lock-root-recursive-refused.out.txt');
    const summary = summarizeRepositoryLockOutput(output, target, { members: [ROOT], recursive: true, isRoot: true });
    const expected = readScenarioAt(PARTIAL_ROOT_ROOT).steps[1].expect;
    assert.ok(expected);
    // Платформа печатает XDTO-пакет русским видом «ПакетXDTO», а ONE_C_TYPE_NAMES знает его
    // только как «XDTOPackage» — строка не распознаётся и отбрасывается как нераспознанный вид
    // (расхождение реестра вне объёма issue #87, для рекурсивного корня на захват не влияет).
    const unrecognized = ['ПакетXDTO.ПакетXDTO1'];
    assert.deepStrictEqual(
      [...summary.granted].sort(),
      expected.grants.filter((name) => !unrecognized.includes(name)).map((name) => (name === 'ТорговыйУчет' ? ROOT : name)).sort()
    );
    assert.ok(summary.granted.includes(ROOT));
    assert.ok(!summary.granted.includes('ТорговыйУчет'));
    assert.ok(summary.granted.includes('Справочник.Валюты'));
    assert.deepStrictEqual(summary.refused, [{ fullName: 'Справочник.Банки', user: 'Petrov' }]);
  });

  test('нераспознанный вид отброшен, повторы схлопнуты', () => {
    const output = [
      'Объект захвачен для редактирования: НеизвестныйВид.Х',
      'Объект захвачен для редактирования: Справочник.Валюты',
      'Объект захвачен для редактирования: Справочник.Валюты',
    ].join('\n');
    assert.deepStrictEqual(
      summarizeRepositoryLockOutput(output, target, { members: [ROOT], recursive: true, isRoot: true }).granted,
      ['Справочник.Валюты']
    );
  });
});

suite('selectLockedMembers — что записать захваченным при частичном отказе (issue #87)', () => {
  const ANCHOR = 'Справочник.ПричиныВозврата';
  const FORM = 'Справочник.ПричиныВозврата.Форма.ФормаЭлемента';
  const summary = (granted: string[], refused: string[]): RepositoryLockOutputSummary =>
    ({ granted, refused: refused.map((fullName) => ({ fullName, user: 'Petrov' })) });

  test('выданная единица записывается, отказанная — нет', () => {
    assert.deepStrictEqual(selectLockedMembers([ANCHOR, FORM], summary([ANCHOR], [FORM])), [ANCHOR]);
  });

  test('потомок отказанного без своей строки не записывается', () => {
    assert.deepStrictEqual(selectLockedMembers([ANCHOR, FORM], summary([], [ANCHOR])), []);
  });

  test('потомок отказанного со своей строкой записывается', () => {
    assert.deepStrictEqual(selectLockedMembers([ANCHOR, FORM], summary([FORM], [ANCHOR])), [FORM]);
  });

  test('кандидат без строки при не отказанном предке записывается (уже был нашим)', () => {
    assert.deepStrictEqual(selectLockedMembers([ANCHOR, FORM], summary([FORM], [])), [ANCHOR, FORM]);
  });

  test('выданная единица вне кандидатов добавляется; порядок детерминирован (ru)', () => {
    assert.deepStrictEqual(
      selectLockedMembers(['Справочник.Товары', 'Справочник.Банки'], summary(['Справочник.Валюты'], [])),
      ['Справочник.Банки', 'Справочник.Валюты', 'Справочник.Товары']
    );
  });
});
