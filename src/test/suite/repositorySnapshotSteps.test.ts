import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  reportSnapshotFailures,
  trySnapshotStep,
  type SnapshotStepFailure,
  type SnapshotStepKind,
} from '../../ui/commands/repository/RepositorySnapshotSteps';

/**
 * Issue #103 — шаг снимка best-effort: сбой не отменяет уже выполненную операцию хранилища,
 * а превращается в строку журнала и одно сводное предупреждение. Путь в сообщении — свой
 * (из resolve*() хранилища), а не из message Node: на Windows тот приходит в неверной кодировке.
 */

const LOCATION = '/ws/.v8vscedit/repository/snapshots/scope/unit';

function eperm(): Error {
  return Object.assign(new Error("EPERM: operation not permitted, rmdir '\\\\?\\c:\\Ïðîåêòû\\x'"), { code: 'EPERM' });
}

function createOutput(): { lines: string[]; services: { outputChannel: vscode.OutputChannel } } {
  const lines: string[] = [];
  return { lines, services: { outputChannel: { appendLine: (line: string) => lines.push(line) } as unknown as vscode.OutputChannel } };
}

suite('RepositorySnapshotSteps — trySnapshotStep (issue #103)', () => {
  test('шаг выполнен — undefined, журнал пуст', () => {
    const output = createOutput();
    let ran = false;
    const failure = trySnapshotStep(output.services, 'capture', 'Справочник.Валюты', LOCATION, () => { ran = true; }, () => true);
    assert.strictEqual(failure, undefined);
    assert.strictEqual(ran, true);
    assert.deepStrictEqual(output.lines, []);
  });

  const cases: { name: string; kind: SnapshotStepKind; isStale?: () => boolean; stale: boolean; tail: string }[] = [
    { name: 'capture, прошлого снимка нет', kind: 'capture', isStale: () => false, stale: false, tail: 'будет выгружена заново' },
    { name: 'capture, остался снимок прошлого захвата', kind: 'capture', isStale: () => true, stale: true, tail: 'удалите каталог вручную' },
    { name: 'capture без isStale', kind: 'capture', stale: false, tail: 'будет выгружена заново' },
    { name: 'discard', kind: 'discard', stale: false, tail: 'не удалён' },
  ];
  for (const item of cases) {
    test(`сбой шага: ${item.name} — warn в журнале с путём и кодом, без пути из message`, () => {
      const output = createOutput();
      const failure = trySnapshotStep(output.services, item.kind, 'Справочник.Валюты', LOCATION, () => { throw eperm(); }, item.isStale);

      assert.deepStrictEqual(failure, {
        kind: item.kind,
        subject: 'Справочник.Валюты',
        location: LOCATION,
        reason: 'EPERM',
        staleSnapshot: item.stale,
      });
      assert.strictEqual(output.lines.length, 1);
      const [line] = output.lines;
      assert.ok(line.startsWith('[repository][file-sync][warn] '), line);
      assert.ok(line.includes('«Справочник.Валюты»') && line.includes(LOCATION) && line.includes('EPERM'), line);
      assert.ok(line.includes(item.tail), line);
      assert.ok(!line.includes('Ïðîåêòû'), line);
      assert.strictEqual(line.includes('не сохранён'), item.kind === 'capture', line);
    });
  }

  test('шаг бросает не Error — причина = строка', () => {
    const output = createOutput();
    const failure = trySnapshotStep(output.services, 'discard', 'ТорговыйУчет', LOCATION, () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- проверяется разбор не-Error исключения
      throw 'занято';
    });
    assert.strictEqual(failure?.reason, 'занято');
    assert.ok(output.lines[0].includes('занято'));
  });
});

suite('RepositorySnapshotSteps — reportSnapshotFailures (issue #103)', () => {
  function failure(kind: SnapshotStepKind, subject: string, staleSnapshot = false): SnapshotStepFailure {
    return { kind, subject, location: `${LOCATION}/${subject}`, reason: 'EPERM', staleSnapshot };
  }

  function collect(failures: readonly SnapshotStepFailure[]): string[] {
    const warnings: string[] = [];
    reportSnapshotFailures({ notifyWarning: (message) => warnings.push(message) }, 'ФормаСписка', failures);
    return warnings;
  }

  test('сбоев нет — уведомления нет', () => {
    assert.deepStrictEqual(collect([]), []);
  });

  test('сбой снятия — одно уведомление с числом и ссылкой на журнал', () => {
    const warnings = collect([failure('capture', 'A'), failure('capture', 'B')]);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('«ФормаСписка»'), warnings[0]);
    assert.ok(warnings[0].includes('не сохранено снимков захвата: 2'), warnings[0]);
    assert.ok(warnings[0].includes('журнале «1С Редактор»'), warnings[0]);
    assert.ok(!warnings[0].includes('устарел'), warnings[0]);
  });

  test('устаревший снимок — прямо сказано, что снимок устарел, и путь для ручного удаления', () => {
    const warnings = collect([failure('capture', 'A', true), failure('capture', 'B')]);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('не сохранено снимков захвата: 2'), warnings[0]);
    assert.ok(warnings[0].includes('устарел'), warnings[0]);
    assert.ok(warnings[0].includes(`${LOCATION}/A`), warnings[0]);
    assert.ok(!warnings[0].includes(`${LOCATION}/B`), warnings[0]);
  });

  test('сбой удаления — одно уведомление с числом неудалённых', () => {
    const warnings = collect([failure('discard', 'A')]);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('не удалено снимков захвата: 1'), warnings[0]);
    assert.ok(!warnings[0].includes('не сохранено'), warnings[0]);
    assert.ok(warnings[0].includes('журнале «1С Редактор»'), warnings[0]);
  });
});
