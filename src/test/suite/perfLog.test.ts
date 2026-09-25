import * as assert from 'assert';
import { formatPerfLine, measurePerfPhase, PERF_LOG_PREFIX } from '../../infra/support/PerfLog';

suite('PerfLog.formatPerfLine', () => {
  test('без деталей — только метка и длительность с префиксом', () => {
    assert.strictEqual(formatPerfLine('поиск конфигураций', 12), '[perf] поиск конфигураций: 12 мс');
  });

  test('с деталями — детали в скобках', () => {
    assert.strictEqual(formatPerfLine('дерево', 300, 'конфигураций 3'), '[perf] дерево: 300 мс (конфигураций 3)');
  });

  test('пустые детали не добавляют скобки', () => {
    assert.strictEqual(formatPerfLine('дерево', 5, ''), '[perf] дерево: 5 мс');
  });

  const rounding: { input: number; expected: string }[] = [
    { input: 12.4, expected: '12' },
    { input: 12.5, expected: '13' },
    { input: 0, expected: '0' },
  ];
  for (const { input, expected } of rounding) {
    test(`длительность ${String(input)} округляется до ${expected} мс`, () => {
      assert.strictEqual(formatPerfLine('фаза', input), `${PERF_LOG_PREFIX} фаза: ${expected} мс`);
    });
  }
});

suite('PerfLog.measurePerfPhase', () => {
  function clockFrom(values: number[]): () => number {
    const queue = [...values];
    return () => {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('часы прочитаны больше раз, чем ожидалось');
      }
      return next;
    };
  }

  test('возвращает результат фазы и пишет строку с длительностью по внедрённым часам', () => {
    const lines: string[] = [];
    const result = measurePerfPhase(clockFrom([100, 112.5]), (line) => lines.push(line), 'поиск', () => 42);

    assert.strictEqual(result, 42);
    assert.deepStrictEqual(lines, ['[perf] поиск: 13 мс']);
  });

  test('детали строятся из результата фазы', () => {
    const lines: string[] = [];
    measurePerfPhase(clockFrom([0, 5]), (line) => lines.push(line), 'поиск', () => ['a', 'b'], (found) =>
      `найдено ${String(found.length)}`
    );

    assert.deepStrictEqual(lines, ['[perf] поиск: 5 мс (найдено 2)']);
  });

  test('исключение фазы уходит вызывающему тем же объектом, строка не пишется', () => {
    const lines: string[] = [];
    const failure = new Error('сбой фазы');

    assert.throws(
      () => measurePerfPhase(clockFrom([0]), (line) => lines.push(line), 'поиск', () => {
        throw failure;
      }),
      (error: unknown) => error === failure
    );
    assert.deepStrictEqual(lines, []);
  });
});
