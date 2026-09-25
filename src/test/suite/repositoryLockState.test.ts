import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryLockState } from '../../infra/repository/RepositoryLockState';
import { getRootLockName } from '../../infra/repository/RepositoryObjectNames';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';

/**
 * `RepositoryLockState` — перенос состояния захвата из `state.json` (issue #1,
 * критерий приёмки №11 и таблица переходов в плане архитектора, раздел 2.11).
 *
 * Решение (неоднозначность плана — только 3 поля у `applyLock`, `anchor`/
 * `members`/`recursiveRoot`, без отдельного «признака группы»): `lockGroups`
 * заполняется ТОЛЬКО когда `members.length > 1` (настоящая группа — рекурсивный
 * захват подсистемы или корня); одиночный объект (`members:[fullName]`,
 * `anchor:fullName`) в `lockGroups` не попадает — работает через
 * `lockedFullNames` напрямую. `applyLock` всегда добавляет ВСЕ `members` в
 * `lockedFullNames` и убирает их из `releasedUnderRoot`; `recursiveRoot:true`
 * дополнительно взводит `rootRecursive=true` и ПОЛНОСТЬЮ сбрасывает
 * `releasedUnderRoot` в `[]` (не точечно, а целиком — новый рекурсивный захват
 * корня отменяет все прежние точечные исключения).
 *
 * `applyUnlock` для объекта при активном `rootRecursive` удаляет fullName из
 * `lockedFullNames` (если был там из-за отдельного повторного захвата) И
 * добавляет в `releasedUnderRoot` — оба действия нужны одновременно, иначе
 * `isLocked` продолжил бы возвращать `true` по первому явному условию.
 */

function createState(): { workspaceRoot: string; state: RepositoryLockState; target: RepositoryTarget } {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-'));
  return {
    workspaceRoot,
    state: new RepositoryLockState(workspaceRoot),
    target: { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' },
  };
}

suite('RepositoryLockState — базовые состояния', () => {
  test('свежая цель: ничего не заблокировано', () => {
    const { state, target } = createState();
    assert.strictEqual(state.isLocked(target, 'Справочник.Что-либо'), false);
    assert.strictEqual(state.isRootLocked(target), false);
    assert.strictEqual(state.isRootRecursiveLocked(target), false);
    assert.strictEqual(state.getLockGroup(target, 'Подсистема.Продажи'), undefined);
  });
});

suite('RepositoryLockState — таблица переходов (план архитектора, раздел 2.11)', () => {
  test('lock объекта → явно заблокирован, соседний объект не затронут', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), true);
    assert.strictEqual(state.isLocked(target, 'Справочник.Б'), false);
    assert.strictEqual(state.getLockGroup(target, 'Справочник.А'), undefined, 'Одиночный объект не должен попадать в lockGroups.');
  });

  test('lock подсистемы рекурсивно → якорь и все участники заблокированы, lockGroups[якорь]=участники', () => {
    const { state, target } = createState();
    const members = ['Подсистема.Продажи', 'Справочник.Товары', 'Документ.Заказ'];
    state.applyLock(target, { anchor: 'Подсистема.Продажи', members });

    members.forEach((fullName) => {
      assert.strictEqual(state.isLocked(target, fullName), true, `"${fullName}" должен быть заблокирован.`);
    });
    assert.deepStrictEqual([...state.getLockGroup(target, 'Подсистема.Продажи') ?? []].sort(), [...members].sort());
    assert.strictEqual(state.isLocked(target, 'Справочник.НеУчаствует'), false);
  });

  test('lock корня нерекурсивно → заблокирован только сентинел корня, isRootRecursiveLocked=false', () => {
    const { state, target } = createState();
    const rootName = getRootLockName(target);
    state.applyLock(target, { anchor: rootName, members: [rootName] });

    assert.strictEqual(state.isRootLocked(target), true);
    assert.strictEqual(state.isRootRecursiveLocked(target), false);
    assert.strictEqual(state.isLocked(target, 'Справочник.ЛюбойОбъект'), false, 'Нерекурсивный захват корня не блокирует произвольные объекты.');
  });

  test('lock корня рекурсивно → isRootRecursiveLocked=true, ЛЮБОЙ fullName считается заблокированным', () => {
    const { state, target } = createState();
    const rootName = getRootLockName(target);
    state.applyLock(target, { anchor: rootName, members: [rootName], recursiveRoot: true });

    assert.strictEqual(state.isRootLocked(target), true);
    assert.strictEqual(state.isRootRecursiveLocked(target), true);
    assert.strictEqual(state.isLocked(target, 'Справочник.ЧтоУгодноНеЗахваченноеЯвно'), true);
    assert.strictEqual(state.isLocked(target, 'Документ.ДругойПроизвольныйОбъект'), true);
  });

  test('lock объекта убирает его из releasedUnderRoot (повторный захват после точечного освобождения при рекурсивном корне)', () => {
    const { state, target } = createState();
    const rootName = getRootLockName(target);
    state.applyLock(target, { anchor: rootName, members: [rootName], recursiveRoot: true });
    state.applyUnlock(target, { anchor: 'Справочник.А', members: ['Справочник.А'], recursive: false, isRoot: false });
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), false, 'После точечного unlock объект должен выпасть из-под общего рекурсивного захвата.');

    state.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), true, 'Повторный явный захват должен снова заблокировать объект.');
  });

  test('unlock корня рекурсивно → полная очистка (root, rootRecursive, releasedUnderRoot, произвольные объекты)', () => {
    const { state, target } = createState();
    const rootName = getRootLockName(target);
    state.applyLock(target, { anchor: rootName, members: [rootName], recursiveRoot: true });
    state.applyUnlock(target, { anchor: 'Справочник.А', members: ['Справочник.А'], recursive: false, isRoot: false });

    state.applyUnlock(target, { anchor: rootName, members: [rootName], recursive: true, isRoot: true });

    assert.strictEqual(state.isRootLocked(target), false);
    assert.strictEqual(state.isRootRecursiveLocked(target), false);
    assert.strictEqual(state.isLocked(target, 'Справочник.ПроизвольныйОбъект'), false);
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), false);
  });

  test('unlock корня нерекурсивно → снят только сентинел, остальное состояние не тронуто', () => {
    const { state, target } = createState();
    const rootName = getRootLockName(target);
    state.applyLock(target, { anchor: rootName, members: [rootName] });
    state.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });

    state.applyUnlock(target, { anchor: rootName, members: [rootName], recursive: false, isRoot: true });

    assert.strictEqual(state.isRootLocked(target), false);
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), true, 'Захват отдельного объекта не должен сниматься вместе с корнем.');
  });

  test('unlock подсистемы рекурсивно → снимаются lockGroups[якорь] ∪ переданный текущий состав, лишнее не трогается', () => {
    const { state, target } = createState();
    // На момент захвата состав был {Продажи, Товары}; к моменту unlock состав подсистемы
    // в XML уже другой — {Продажи, Заказ} (Товары исключили, Заказ добавили). Both should
    // be removed, а не только один из двух источников состава.
    state.applyLock(target, { anchor: 'Подсистема.Продажи', members: ['Подсистема.Продажи', 'Справочник.Товары'] });
    state.applyLock(target, { anchor: 'Справочник.Посторонний', members: ['Справочник.Посторонний'] });

    const removed = state.applyUnlock(target, {
      anchor: 'Подсистема.Продажи',
      members: ['Подсистема.Продажи', 'Документ.Заказ'],
      recursive: true,
      isRoot: false,
    });

    assert.deepStrictEqual([...removed].sort(), ['Документ.Заказ', 'Подсистема.Продажи', 'Справочник.Товары'].sort());
    assert.strictEqual(state.isLocked(target, 'Подсистема.Продажи'), false);
    assert.strictEqual(state.isLocked(target, 'Справочник.Товары'), false, 'Объект из старого состава lockGroups тоже должен быть снят.');
    assert.strictEqual(state.isLocked(target, 'Документ.Заказ'), false);
    assert.strictEqual(state.isLocked(target, 'Справочник.Посторонний'), true, 'Не связанный с подсистемой захват не должен пострадать.');
    assert.strictEqual(state.getLockGroup(target, 'Подсистема.Продажи'), undefined);
  });

  test('unlock объекта при активном rootRecursive → объект переходит в releasedUnderRoot, isLocked=false', () => {
    const { state, target } = createState();
    const rootName = getRootLockName(target);
    state.applyLock(target, { anchor: rootName, members: [rootName], recursiveRoot: true });
    assert.strictEqual(state.isLocked(target, 'Справочник.Б'), true);

    const removed = state.applyUnlock(target, { anchor: 'Справочник.Б', members: ['Справочник.Б'], recursive: false, isRoot: false });

    assert.deepStrictEqual(removed, ['Справочник.Б']);
    assert.strictEqual(state.isLocked(target, 'Справочник.Б'), false);
    assert.strictEqual(state.isRootRecursiveLocked(target), true, 'Точечное освобождение не должно снимать признак рекурсивного захвата корня целиком.');
  });

  test('commit без keepLocked эквивалентен unlock (для обычного объекта)', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });
    state.applyUnlock(target, { anchor: 'Справочник.А', members: ['Справочник.А'], recursive: false, isRoot: false });
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), false);
  });
});

suite('RepositoryLockState — миграция и устойчивость state.json', () => {
  function stateFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.v8vscedit', 'repository', 'state.json');
  }

  test('старый state.json v2 без новых полей читается без потерь', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-v2-'));
    try {
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      const scopeKey = crypto.createHash('sha1').update(`cf|${path.resolve(target.configRoot)}|`).digest('hex');
      fs.mkdirSync(path.dirname(stateFilePath(workspaceRoot)), { recursive: true });
      fs.writeFileSync(
        stateFilePath(workspaceRoot),
        JSON.stringify({
          version: 2,
          scopes: { [scopeKey]: { connected: true, lockedFullNames: ['Справочник.Старый'] } },
        }),
        'utf-8'
      );

      const state = new RepositoryLockState(workspaceRoot);
      assert.strictEqual(state.isLocked(target, 'Справочник.Старый'), true);
      assert.strictEqual(state.isRootRecursiveLocked(target), false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('мусорные/некорректные типы новых полей отбрасываются, не роняют чтение', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-garbage-'));
    try {
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      const scopeKey = crypto.createHash('sha1').update(`cf|${path.resolve(target.configRoot)}|`).digest('hex');
      fs.mkdirSync(path.dirname(stateFilePath(workspaceRoot)), { recursive: true });
      fs.writeFileSync(
        stateFilePath(workspaceRoot),
        JSON.stringify({
          version: 2,
          scopes: {
            [scopeKey]: {
              lockedFullNames: ['Справочник.А'],
              rootRecursive: 'да, конечно',
              lockGroups: ['не', 'объект'],
              releasedUnderRoot: { not: 'array' },
            },
          },
        }),
        'utf-8'
      );

      const state = new RepositoryLockState(workspaceRoot);
      assert.doesNotThrow(() => state.isLocked(target, 'Справочник.А'));
      assert.strictEqual(state.isLocked(target, 'Справочник.А'), true);
      assert.strictEqual(state.isRootRecursiveLocked(target), false, 'Некорректный тип rootRecursive должен трактоваться как false.');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('состояние переживает пересоздание RepositoryLockState (персистентность в файле)', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-persist-'));
    try {
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      const first = new RepositoryLockState(workspaceRoot);
      first.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });

      const second = new RepositoryLockState(workspaceRoot);
      assert.strictEqual(second.isLocked(target, 'Справочник.А'), true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

suite('RepositoryLockState — onDidChangeLocks', () => {
  test('applyLock/applyUnlock порождают событие с payload {target, fullNames, allObjects}', () => {
    const { state, target } = createState();
    const events: { target: RepositoryTarget; fullNames: readonly string[]; allObjects: readonly string[] }[] = [];
    const subscription = state.onDidChangeLocks((event: { target: RepositoryTarget; fullNames: readonly string[]; allObjects: readonly string[] }) => events.push(event));

    state.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });
    state.applyUnlock(target, { anchor: 'Справочник.А', members: ['Справочник.А'], recursive: false, isRoot: false });

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].target, target);
    assert.ok(events[0].fullNames.includes('Справочник.А'));
    assert.ok(Array.isArray(events[0].allObjects));
    assert.ok(events[0].allObjects.includes('Справочник.А'), 'allObjects должен включать только что заблокированный объект.');

    subscription.dispose();
    state.applyLock(target, { anchor: 'Справочник.Б', members: ['Справочник.Б'] });
    assert.strictEqual(events.length, 2, 'После dispose() новые события приходить не должны.');
  });

  test('исключение в одном слушателе не мешает остальным и не роняет саму операцию', () => {
    const { state, target } = createState();
    let secondListenerCalls = 0;
    state.onDidChangeLocks(() => {
      throw new Error('сбой первого слушателя');
    });
    state.onDidChangeLocks(() => { secondListenerCalls += 1; });

    assert.doesNotThrow(() => state.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] }));
    assert.strictEqual(secondListenerCalls, 1);
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), true);
  });
});

suite('RepositoryLockState — setConnected/isConnected (перенос существующей семантики)', () => {
  // Решение: RepositoryLockState сам по себе не знает о наличии привязки в
  // env.json (это остаётся заботой RepositoryService.hasBinding) — как и в
  // прежней реализации (`scope?.connected ?? true`), при отсутствии явной
  // записи isConnected по умолчанию true; RepositoryService комбинирует это
  // с hasBinding() при делегировании.
  test('по умолчанию (нет записи scope) — true; после setConnected(false) — false; после true — снова true', () => {
    const { state, target } = createState();
    assert.strictEqual(state.isConnected(target), true);
    state.setConnected(target, false);
    assert.strictEqual(state.isConnected(target), false);
    state.setConnected(target, true);
    assert.strictEqual(state.isConnected(target), true);
  });
});
