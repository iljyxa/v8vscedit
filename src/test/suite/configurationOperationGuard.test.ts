/**
 * Issue #10 — общий `ConfigurationOperationGuard` (src/infra/process/ConfigurationOperationGuard.ts).
 *
 * Тест — чистый unit без vscode/фикстур ФС: `ConfigurationOperationGuard` по
 * контракту архитектора не импортирует `vscode`/`fs`/`path`, поэтому единственный
 * реалистичный источник поведения — сам объект и функции-операции/слушатели,
 * которые здесь синхронные детерминированные замыкания (без реальных внешних
 * систем, мокать нечего).
 */
import * as assert from 'assert';
import {
  ConfigurationOperationGuard,
  type ConfigurationOperationExclusiveResult,
} from '../../infra/process/ConfigurationOperationGuard';

suite('ConfigurationOperationGuard', () => {
  test('новый guard свободен: isBusy=false, heldBy=undefined', () => {
    const guard = new ConfigurationOperationGuard();
    assert.strictEqual(guard.isBusy, false);
    assert.strictEqual(guard.heldBy, undefined);
  });

  test('tryAcquire занимает guard, isBusy/heldBy обновляются, подписчик получает [true]', () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    guard.onDidChangeBusy((busy) => events.push(busy));

    const lease = guard.tryAcquire('Импорт конфигураций');

    assert.ok(lease, 'tryAcquire на свободном guard обязан вернуть аренду');
    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'Импорт конфигураций');
    assert.deepStrictEqual(events, [true]);
  });

  test('повторный tryAcquire при занятом guard — undefined, без события, heldBy прежний', () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    guard.tryAcquire('Импорт конфигураций');
    guard.onDidChangeBusy((busy) => events.push(busy));

    const second = guard.tryAcquire('Обновление конфигураций');

    assert.strictEqual(second, undefined);
    assert.strictEqual(guard.heldBy, 'Импорт конфигураций');
    assert.deepStrictEqual(events, []);
  });

  test('release() освобождает guard (событие false), после — можно занять снова', () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    const lease = guard.tryAcquire('Импорт конфигураций');
    guard.onDidChangeBusy((busy) => events.push(busy));

    lease?.release();

    assert.strictEqual(guard.isBusy, false);
    assert.strictEqual(guard.heldBy, undefined);
    assert.deepStrictEqual(events, [false]);

    const relocked = guard.tryAcquire('Обновление конфигураций');
    assert.ok(relocked, 'после release() guard должен снова быть занимаемым');
    assert.strictEqual(guard.heldBy, 'Обновление конфигураций');
  });

  test('двойной release() — второй вызов не порождает повторное событие', () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    const lease = guard.tryAcquire('Импорт конфигураций');
    guard.onDidChangeBusy((busy) => events.push(busy));

    lease?.release();
    lease?.release();

    assert.deepStrictEqual(events, [false]);
    assert.strictEqual(guard.isBusy, false);
  });

  test('протухшая аренда: A занял/освободил, B занял, повторный A.release() не трогает B', () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    const leaseA = guard.tryAcquire('A');
    leaseA?.release();
    const leaseB = guard.tryAcquire('B');
    guard.onDidChangeBusy((busy) => events.push(busy));

    leaseA?.release();

    assert.strictEqual(guard.isBusy, true);
    assert.strictEqual(guard.heldBy, 'B');
    assert.deepStrictEqual(events, [], 'протухший release не должен посылать событие');
    void leaseB;
  });

  test('runExclusive успех: {acquired:true,value}, внутри операции guard занят, после — свободен, события [true,false]', async () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    guard.onDidChangeBusy((busy) => events.push(busy));
    let observedDuringOperation: { isBusy: boolean; heldBy: string | undefined } | undefined;

    const result = await guard.runExclusive('Импорт конфигураций', () => {
      observedDuringOperation = { isBusy: guard.isBusy, heldBy: guard.heldBy };
      return Promise.resolve(42);
    });

    assert.deepStrictEqual(result, { acquired: true, value: 42 });
    assert.deepStrictEqual(observedDuringOperation, { isBusy: true, heldBy: 'Импорт конфигураций' });
    assert.strictEqual(guard.isBusy, false);
    assert.deepStrictEqual(events, [true, false]);
  });

  test('runExclusive при занятом guard — {acquired:false,heldBy}, операция не вызывается, событий нет', async () => {
    const guard = new ConfigurationOperationGuard();
    guard.tryAcquire('Импорт конфигураций');
    const events: boolean[] = [];
    guard.onDidChangeBusy((busy) => events.push(busy));
    let called = false;

    const result = await guard.runExclusive('Обновление конфигураций', () => {
      called = true;
      return Promise.resolve(1);
    });

    assert.deepStrictEqual(result, { acquired: false, heldBy: 'Импорт конфигураций' });
    assert.strictEqual(called, false);
    assert.deepStrictEqual(events, []);
  });

  test('runExclusive пробрасывает исключение (тот же объект) из async-throw, guard освобождается', async () => {
    const guard = new ConfigurationOperationGuard();
    const thrown = new Error('boom-async-throw');

    await assert.rejects(
      // Реальный await внутри — чтобы бросок происходил после микротаска (а не
      // синхронно при вызове), это и отличает сценарий от соседнего теста с
      // прямым Promise.reject ниже.
      guard.runExclusive('X', async () => {
        await Promise.resolve();
        throw thrown;
      }),
      (error: unknown) => {
        assert.strictEqual(error, thrown);
        return true;
      }
    );
    assert.strictEqual(guard.isBusy, false);
  });

  test('runExclusive пробрасывает исключение (тот же объект) из Promise.reject, guard освобождается', async () => {
    const guard = new ConfigurationOperationGuard();
    const thrown = new Error('boom-reject');

    await assert.rejects(
      guard.runExclusive('X', () => Promise.reject(thrown)),
      (error: unknown) => {
        assert.strictEqual(error, thrown);
        return true;
      }
    );
    assert.strictEqual(guard.isBusy, false);
  });

  test('вложенный runExclusive на том же guard — acquired:false', async () => {
    const guard = new ConfigurationOperationGuard();
    let innerResult: ConfigurationOperationExclusiveResult<number> | undefined;

    const outerResult = await guard.runExclusive('Внешняя', async () => {
      innerResult = await guard.runExclusive('Внутренняя', () => Promise.resolve(1));
      return 'outer';
    });

    assert.deepStrictEqual(outerResult, { acquired: true, value: 'outer' });
    assert.deepStrictEqual(innerResult, { acquired: false, heldBy: 'Внешняя' });
  });

  test('гонка Promise.all двух runExclusive в одном тике — занимает ровно одна', async () => {
    const guard = new ConfigurationOperationGuard();

    const [resultA, resultB] = await Promise.all([
      guard.runExclusive('A', async () => {
        await Promise.resolve();
        return 'a';
      }),
      guard.runExclusive('B', async () => {
        await Promise.resolve();
        return 'b';
      }),
    ]);

    const acquiredCount = [resultA, resultB].filter((result) => result.acquired).length;
    assert.strictEqual(acquiredCount, 1, 'ровно одна из двух runExclusive должна была реально выполнить операцию');
    assert.strictEqual(guard.isBusy, false);
  });

  test('onDidChangeBusy(...).dispose() — подписчик больше не вызывается, двойной dispose безопасен', () => {
    const guard = new ConfigurationOperationGuard();
    const events: boolean[] = [];
    const subscription = guard.onDidChangeBusy((busy) => events.push(busy));

    subscription.dispose();
    subscription.dispose();

    const lease = guard.tryAcquire('X');
    lease?.release();

    assert.deepStrictEqual(events, []);
  });

  [
    { label: 'onListenerError задан', withHandler: true },
    { label: 'onListenerError не задан', withHandler: false },
  ].forEach(({ label, withHandler }) => {
    test(`ошибка одного подписчика не мешает второму и не бросает наружу (${label})`, () => {
      const caught: unknown[] = [];
      const guard = withHandler
        ? new ConfigurationOperationGuard((error) => caught.push(error))
        : new ConfigurationOperationGuard();
      const boom = new Error('boom-listener');
      const secondCalls: boolean[] = [];
      guard.onDidChangeBusy(() => {
        throw boom;
      });
      guard.onDidChangeBusy((busy) => secondCalls.push(busy));

      let lease: ReturnType<ConfigurationOperationGuard['tryAcquire']> | undefined;
      assert.doesNotThrow(() => {
        lease = guard.tryAcquire('X');
      });
      assert.strictEqual(guard.isBusy, true);
      assert.deepStrictEqual(secondCalls, [true]);

      assert.doesNotThrow(() => {
        lease?.release();
      });
      assert.strictEqual(guard.isBusy, false);
      assert.deepStrictEqual(secondCalls, [true, false]);

      if (withHandler) {
        assert.strictEqual(caught.length, 2, 'onListenerError должен быть вызван на каждое падение (acquire + release)');
        assert.strictEqual(caught[0], boom);
        assert.strictEqual(caught[1], boom);
      }
    });
  });
});
