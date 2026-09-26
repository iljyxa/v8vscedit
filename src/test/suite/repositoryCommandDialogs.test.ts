import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  askRecursiveMode,
  pickDisconnectForce,
  pickUnlockForce,
  promptRepositoryVersion,
  type RepositoryChoiceItem,
  validateRepositoryVersion,
} from '../../ui/commands/repository/RepositoryCommandDialogs';

/**
 * Issue #61: диалоги команд хранилища. QuickPick/InputBox VS Code в тестовом хосте
 * не управляемы программно, поэтому `vscode.window.showQuickPick`/`showInputBox`
 * подменяются записывающими стабами, которые сразу отвечают выбранным значением;
 * проверяется состав пунктов, тексты и опции — то, что видит пользователь.
 */
suite('RepositoryCommandDialogs — диалоги команд хранилища (issue #61)', () => {
  type Stubs = Pick<typeof vscode.window, 'showQuickPick' | 'showInputBox'>;
  const stubsRef = vscode.window as Stubs;
  let originals: Stubs;
  let quickPicks: { items: readonly RepositoryChoiceItem<boolean>[]; options: vscode.QuickPickOptions | undefined }[];
  let inputBoxes: (vscode.InputBoxOptions | undefined)[];
  let pickAnswer: boolean | undefined;
  let inputAnswer: string | undefined;

  setup(() => {
    quickPicks = [];
    inputBoxes = [];
    pickAnswer = undefined;
    inputAnswer = undefined;
    originals = { showQuickPick: vscode.window.showQuickPick, showInputBox: vscode.window.showInputBox };
    stubsRef.showQuickPick = ((items: readonly RepositoryChoiceItem<boolean>[], options?: vscode.QuickPickOptions) => {
      quickPicks.push({ items, options });
      return Promise.resolve(pickAnswer === undefined ? undefined : items.find((item) => item.value === pickAnswer));
    }) as unknown as typeof vscode.window.showQuickPick;
    stubsRef.showInputBox = ((options?: vscode.InputBoxOptions) => {
      inputBoxes.push(options);
      return Promise.resolve(inputAnswer);
    });
  });

  teardown(() => {
    stubsRef.showQuickPick = originals.showQuickPick;
    stubsRef.showInputBox = originals.showInputBox;
  });

  test('askRecursiveMode: подчинённых нет — false без вопроса', async () => {
    assert.strictEqual(await askRecursiveMode('Захват объектов', 'Банки', false), false);
    assert.strictEqual(quickPicks.length, 0);
  });

  const choiceDialogs: readonly { readonly name: string; readonly subject: string; readonly run: () => Promise<boolean | undefined> }[] = [
    { name: 'askRecursiveMode', subject: 'Контрагенты', run: () => askRecursiveMode('Захват объектов', 'Контрагенты', true) },
    { name: 'pickUnlockForce', subject: 'Контрагенты', run: () => pickUnlockForce('Контрагенты') },
    { name: 'pickDisconnectForce', subject: 'Основная конфигурация', run: () => pickDisconnectForce('Основная конфигурация') },
  ];

  choiceDialogs.forEach(({ name, subject, run }) => {
    ([true, false, undefined] as const).forEach((answer) => {
      test(`${name}: ответ ${String(answer)} возвращается как есть`, async () => {
        pickAnswer = answer;

        assert.strictEqual(await run(), answer);
        assert.strictEqual(quickPicks.length, 1);
      });
    });

    test(`${name}: два пункта, первым безопасный (false), у каждого есть пояснения; опции диалога`, async () => {
      await run();

      const [{ items, options }] = quickPicks;
      assert.deepStrictEqual(items.map((item) => item.value), [false, true]);
      for (const item of items) {
        assert.ok(item.label.trim(), `${name}: пустой label`);
        assert.ok(item.description?.trim(), `${name}: пустой description у «${item.label}»`);
        assert.ok(item.detail?.trim(), `${name}: пустой detail у «${item.label}»`);
      }
      assert.ok(options?.title?.trim(), `${name}: пустой title`);
      assert.ok(options?.placeHolder?.includes(subject), `${name}: placeHolder «${String(options?.placeHolder)}» без «${subject}»`);
      assert.strictEqual(options?.ignoreFocusOut, true);
    });
  });

  test('askRecursiveMode: заголовок диалога — переданный title', async () => {
    await askRecursiveMode('Освобождение объектов', 'Контрагенты', true);

    assert.strictEqual(quickPicks[0].options?.title, 'Освобождение объектов');
  });

  test('pickDisconnectForce: «Принудительно» предупреждает, что захваты остаются на сервере (issue #80)', async () => {
    await pickDisconnectForce('Основная конфигурация');

    const forced = quickPicks[0].items.find((item) => item.value);
    assert.match(forced?.detail ?? '', /остаются захваченными в хранилище/);
  });

  test('promptRepositoryVersion: ввод обрезается по краям', async () => {
    inputAnswer = ' 125 ';

    assert.strictEqual(await promptRepositoryVersion('Получение версии из хранилища'), '125');
  });

  test('promptRepositoryVersion: отмена ввода — undefined', async () => {
    inputAnswer = undefined;

    assert.strictEqual(await promptRepositoryVersion('Получение версии из хранилища'), undefined);
  });

  test('promptRepositoryVersion: опции — title, валидатор номера версии, ignoreFocusOut', async () => {
    inputAnswer = '7';

    await promptRepositoryVersion('Получение версии из хранилища');

    assert.strictEqual(inputBoxes.length, 1);
    assert.strictEqual(inputBoxes[0]?.title, 'Получение версии из хранилища');
    // Сравнивается сама ссылка на валидатор (не вызывается), поэтому берётся через Reflect.
    const validateInput: unknown = Reflect.get(inputBoxes[0] ?? {}, 'validateInput');
    assert.strictEqual(validateInput, validateRepositoryVersion);
    assert.strictEqual(inputBoxes[0]?.ignoreFocusOut, true);
  });

  ['1', '125', ' 42 '].forEach((input) => {
    test(`validateRepositoryVersion('${input}') — допустимо`, () => {
      assert.strictEqual(validateRepositoryVersion(input), undefined);
    });
  });

  ['', '  ', '0', '-1', '1.5', 'abc', '12a', '007'].forEach((input) => {
    test(`validateRepositoryVersion('${input}') — сообщение об ошибке`, () => {
      assert.strictEqual(validateRepositoryVersion(input), 'Укажите номер версии хранилища — целое число больше нуля.');
    });
  });
});
