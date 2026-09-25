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

  test('unlock recursive:true якоря БЕЗ существующей группы (одиночный объект) — снимается только сам якорь (fallback ?? [])', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });

    const removed = state.applyUnlock(target, { anchor: 'Справочник.А', members: ['Справочник.А'], recursive: true, isRoot: false });

    assert.deepStrictEqual(removed, ['Справочник.А']);
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), false);
  });

  test('unlock рекурсивно одной группы не трогает lockGroups ДРУГОЙ, не связанной с ней группы', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Подсистема.Продажи', members: ['Подсистема.Продажи', 'Справочник.Товары'] });
    state.applyLock(target, { anchor: 'Подсистема.Закупки', members: ['Подсистема.Закупки', 'Справочник.Поставщики'] });

    state.applyUnlock(target, { anchor: 'Подсистема.Продажи', members: ['Подсистема.Продажи', 'Справочник.Товары'], recursive: true, isRoot: false });

    assert.strictEqual(state.isLocked(target, 'Подсистема.Продажи'), false);
    assert.strictEqual(state.isLocked(target, 'Подсистема.Закупки'), true, 'Другая группа не должна пострадать от отмены соседней.');
    assert.strictEqual(state.isLocked(target, 'Справочник.Поставщики'), true);
    assert.deepStrictEqual(
      [...(state.getLockGroup(target, 'Подсистема.Закупки') ?? [])].sort(),
      ['Подсистема.Закупки', 'Справочник.Поставщики'].sort()
    );
  });

  test('setLocked с пустым списком — no-op, состояние не меняется', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Справочник.А', members: ['Справочник.А'] });
    state.setLocked(target, [], true);
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), true, 'Пустой список не должен ничего менять.');
  });

  test('setLocked(..., false) снимает явный захват (ветка locked=false)', () => {
    const { state, target } = createState();
    state.setLocked(target, ['Справочник.А'], true);
    assert.strictEqual(state.isLocked(target, 'Справочник.А'), true);

    state.setLocked(target, ['Справочник.А'], false);

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

  test('state.json — не JSON (синтаксически битый файл) → трактуется как пустое состояние', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-notjson-'));
    try {
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      fs.mkdirSync(path.dirname(stateFilePath(workspaceRoot)), { recursive: true });
      fs.writeFileSync(stateFilePath(workspaceRoot), '{ не json вовсе', 'utf-8');

      const state = new RepositoryLockState(workspaceRoot);

      assert.doesNotThrow(() => state.isLocked(target, 'Справочник.Что-либо'));
      assert.strictEqual(state.isLocked(target, 'Справочник.Что-либо'), false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('state.json — валидный JSON неверной формы (версия/scopes) → трактуется как пустое состояние', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-badshape-'));
    try {
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      fs.mkdirSync(path.dirname(stateFilePath(workspaceRoot)), { recursive: true });

      // Корень — массив (не объект).
      fs.writeFileSync(stateFilePath(workspaceRoot), JSON.stringify(['не', 'объект']), 'utf-8');
      assert.strictEqual(new RepositoryLockState(workspaceRoot).isLocked(target, 'Справочник.Что-либо'), false);

      // version не 2.
      fs.writeFileSync(stateFilePath(workspaceRoot), JSON.stringify({ version: 1, scopes: {} }), 'utf-8');
      assert.strictEqual(new RepositoryLockState(workspaceRoot).isLocked(target, 'Справочник.Что-либо'), false);

      // scopes — не объект.
      fs.writeFileSync(stateFilePath(workspaceRoot), JSON.stringify({ version: 2, scopes: ['не', 'объект'] }), 'utf-8');
      assert.strictEqual(new RepositoryLockState(workspaceRoot).isLocked(target, 'Справочник.Что-либо'), false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('запись scope не объект (например, строка) — пропускается, остальные scope читаются', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-badscope-'));
    try {
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      const scopeKey = crypto.createHash('sha1').update(`cf|${path.resolve(target.configRoot)}|`).digest('hex');
      fs.mkdirSync(path.dirname(stateFilePath(workspaceRoot)), { recursive: true });
      fs.writeFileSync(
        stateFilePath(workspaceRoot),
        JSON.stringify({ version: 2, scopes: { 'посторонний-ключ': 'не объект', [scopeKey]: { lockedFullNames: ['Справочник.А'] } } }),
        'utf-8'
      );

      const state = new RepositoryLockState(workspaceRoot);

      assert.strictEqual(state.isLocked(target, 'Справочник.А'), true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('scope без lockedFullNames (fallback ?? []) и с валидными rootRecursive/lockGroups/releasedUnderRoot — читаются корректно', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-fullshape-'));
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
              // lockedFullNames отсутствует вовсе — должен примениться fallback ?? [].
              rootRecursive: true,
              lockGroups: { 'Подсистема.Продажи': ['Подсистема.Продажи', 'Справочник.Товары'] },
              releasedUnderRoot: ['Справочник.Освобождённый'],
            },
          },
        }),
        'utf-8'
      );

      const state = new RepositoryLockState(workspaceRoot);

      assert.strictEqual(state.isRootRecursiveLocked(target), true);
      assert.strictEqual(state.isLocked(target, 'Справочник.ЛюбойОбъект'), true, 'rootRecursive из персистентного файла должен применяться.');
      assert.strictEqual(state.isLocked(target, 'Справочник.Освобождённый'), false, 'releasedUnderRoot из персистентного файла должен применяться.');
      assert.deepStrictEqual(
        [...(state.getLockGroup(target, 'Подсистема.Продажи') ?? [])].sort(),
        ['Подсистема.Продажи', 'Справочник.Товары'].sort()
      );
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

/**
 * Раздел 10, Р7: `lockModes` и единицы хранилища (подчинённые объекты с
 * собственным XML — формы/макеты/…). Решение test-writer по неоднозначной
 * сигнатуре (модуль не существует, план даёт только текстовое описание):
 * `RepositoryLockRequest.mode?: 'recursive' | 'object'` — НЕОБЯЗАТЕЛЬНОЕ поле
 * (в отличие от буквального `mode: 'recursive' | 'object'` из 10.2 Р7, который
 * читаем как «тип значения», а не «обязательность параметра запроса»). Причина:
 * десятки уже существующих вызовов `applyLock`/`applyUnlock` в этом и других
 * файлах (`repositoryUnlockSync.test.ts`, `repositoryService.test.ts`) работают
 * с обычными верхнеуровневыми объектами без единиц и не должны переписываться
 * ради поля, которое для них не имеет смысла. Пропуск `mode` — ТОЧНЫЙ эквивалент
 * критерия 10.1.9 «старая запись без lockModes»: вызывающий код, ещё не знающий
 * о режимах, ведёт себя как раньше.
 * `lockModes` заполняется по ВСЕМ `members` операции (10.2 Р7: «режим последнего
 * захвата для всех members операции»), не только по `anchor`.
 * `isLocked(target, unit)`: явно в lockedFullNames ИЛИ участник lockGroup ИЛИ
 * rootRecursive-правило (без изменений) ИЛИ НОВОЕ «правило старых записей»:
 * есть предок единицы (`getRepositoryUnitAncestors`, поиск от ближайшего к
 * дальнему), который сам заблокирован (явно/через группу) И для него в
 * `lockModes` НЕТ записи — тогда единица тоже считается заблокированной (as
 * before, до появления единиц формы/макета захватывались вместе с владельцем).
 */
suite('RepositoryLockState — lockModes и единицы (issue #1, раздел 10, Р7)', () => {
  test('applyLock БЕЗ mode (старый вызывающий код) — lockModes не пишется, подчинённая единица владельца считается заблокированной (обратная совместимость)', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Справочник.Контрагенты', members: ['Справочник.Контрагенты'] });
    assert.strictEqual(state.isLocked(target, 'Справочник.Контрагенты.Форма.ФормаЭлемента'), true, 'Старая семантика: подчинённые формы считались частью захвата владельца.');
  });

  test('applyLock с mode:"object" (новый нерекурсивный захват) — подчинённая единица НЕ считается заблокированной', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Справочник.Контрагенты', members: ['Справочник.Контрагенты'], mode: 'object' });
    assert.strictEqual(state.isLocked(target, 'Справочник.Контрагенты'), true);
    assert.strictEqual(state.isLocked(target, 'Справочник.Контрагенты.Форма.ФормаЭлемента'), false, 'mode:"object" — правило старых записей не применяется, записан явный режим.');
  });

  test('applyLock с mode:"recursive" и явным составом подчинённых единиц — все они заблокированы напрямую (через lockGroups)', () => {
    const { state, target } = createState();
    const members = [
      'Справочник.Контрагенты',
      'Справочник.Контрагенты.Форма.ФормаЭлемента',
      'Справочник.Контрагенты.Форма.ФормаСписка',
      'Справочник.Контрагенты.Макет.ЗагрузкаИзФайла',
    ];
    state.applyLock(target, { anchor: 'Справочник.Контрагенты', members, mode: 'recursive' });
    members.forEach((unit) => assert.strictEqual(state.isLocked(target, unit), true, `"${unit}" должен быть заблокирован.`));
    assert.deepStrictEqual([...(state.getLockGroup(target, 'Справочник.Контрагенты') ?? [])].sort(), [...members].sort());
  });

  test('правило старых записей учитывает ВСЕ уровни предков (дважды вложенная единица — таблица измерения куба)', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'ВнешнийИсточникДанных.ИнтернетМагазин', members: ['ВнешнийИсточникДанных.ИнтернетМагазин'] });
    assert.strictEqual(
      state.isLocked(target, 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары'),
      true,
      'Правило старых записей должно подниматься до самого дальнего предка (владельца), а не только до ближайшего.'
    );
  });

  test('mode:"object" на владельце с многоуровневой единицей — ancestor-правило не срабатывает (единица считается незаблокированной)', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'ВнешнийИсточникДанных.ИнтернетМагазин', members: ['ВнешнийИсточникДанных.ИнтернетМагазин'], mode: 'object' });
    assert.strictEqual(state.isLocked(target, 'ВнешнийИсточникДанных.ИнтернетМагазин.Куб.Продажи.ТаблицаИзмерения.Товары'), false);
  });

  test('applyUnlock удаляет lockModes у освобождённых единиц: повторный старый захват владельца снова покрывает подчинённые (ancestor-правило вновь срабатывает)', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Справочник.Контрагенты', members: ['Справочник.Контрагенты'], mode: 'object' });
    assert.strictEqual(state.isLocked(target, 'Справочник.Контрагенты.Форма.ФормаЭлемента'), false);

    state.applyUnlock(target, { anchor: 'Справочник.Контрагенты', members: ['Справочник.Контрагенты'], recursive: false, isRoot: false });
    assert.strictEqual(state.isLocked(target, 'Справочник.Контрагенты'), false);

    // Повторный захват уже БЕЗ явного mode — lockModes должен быть удалён освобождением
    // выше, иначе он «прилип» бы к объекту навсегда и ancestor-правило никогда не сработало.
    state.applyLock(target, { anchor: 'Справочник.Контрагенты', members: ['Справочник.Контрагенты'] });
    assert.strictEqual(state.isLocked(target, 'Справочник.Контрагенты.Форма.ФормаЭлемента'), true);
  });

  test('верхнеуровневый объект без подчинённых единиц — правило старых записей не применяется (getRepositoryUnitAncestors пуст), поведение не меняется', () => {
    const { state, target } = createState();
    state.applyLock(target, { anchor: 'Справочник.Товары', members: ['Справочник.Товары'] });
    assert.strictEqual(state.isLocked(target, 'Справочник.Товары'), true);
    assert.strictEqual(state.isLocked(target, 'Справочник.ДругойОбъект'), false);
  });

  test('mode с некорректным значением в state.json (сырой файл) отбрасывается при чтении, не роняет isLocked', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lockstate-badmode-'));
    try {
      const target: RepositoryTarget = { configRoot: path.join(workspaceRoot, 'src', 'cf'), configKind: 'cf', displayName: 'Тест' };
      const scopeKey = crypto.createHash('sha1').update(`cf|${path.resolve(target.configRoot)}|`).digest('hex');
      const filePath = path.join(workspaceRoot, '.v8vscedit', 'repository', 'state.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 2,
          scopes: {
            [scopeKey]: {
              lockedFullNames: ['Справочник.Контрагенты'],
              lockModes: { 'Справочник.Контрагенты': 'НЕ_РЕЖИМ', 'Справочник.Другой': 42 },
            },
          },
        }),
        'utf-8'
      );
      const state = new RepositoryLockState(workspaceRoot);
      assert.doesNotThrow(() => state.isLocked(target, 'Справочник.Контрагенты.Форма.ФормаЭлемента'));
      // Некорректное значение отбрасывается → запись для "Справочник.Контрагенты"
      // в lockModes отсутствует → правило старых записей срабатывает как обычно.
      assert.strictEqual(state.isLocked(target, 'Справочник.Контрагенты.Форма.ФормаЭлемента'), true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
