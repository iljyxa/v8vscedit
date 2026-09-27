/**
 * Issue #102: форма «Помещение в хранилище» закрывалась сразу после открытия.
 * Vue-приложение после монтирования шлёт `{ type: 'ready' }`, а провайдер считал
 * отменой любое сообщение, кроме `submit`, поэтому команда помещения получала
 * `undefined` и до Конфигуратора не доходила.
 *
 * HTML собирает настоящий `WebviewHtmlFactory` по реальному `dist/ui/manifest.json`
 * (сборка шагом pretest); подменена только сама панель — см. `fakeWebviewPanel`.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  type RepositoryCommitFormData,
  RepositoryCommitViewProvider,
} from '../../ui/views/RepositoryCommitViewProvider';
import { type FakeWebviewPanelFactory, installFakeWebviewPanels, readInitialState } from './support/fakeWebviewPanel';

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

const FORM_DATA: RepositoryCommitFormData = {
  comment: 'Правка формы элемента',
  recursive: true,
  keepLocked: false,
  force: false,
};

type Outcome = { settled: false } | { settled: true; value: RepositoryCommitFormData | undefined };

/** Следит за промисом, не дожидаясь его: незавершённость — тоже проверяемый результат. */
function track(promise: Promise<RepositoryCommitFormData | undefined>): () => Promise<Outcome> {
  let outcome: Outcome = { settled: false };
  void promise.then((value) => { outcome = { settled: true, value }; });
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return outcome;
  };
}

suite('RepositoryCommitViewProvider — сообщения формы помещения (issue #102)', () => {
  let panels: FakeWebviewPanelFactory;
  let provider: RepositoryCommitViewProvider;

  setup(() => {
    panels = installFakeWebviewPanels();
    provider = new RepositoryCommitViewProvider(vscode.Uri.file(EXTENSION_ROOT));
  });

  teardown(() => {
    provider.dispose();
    panels.restore();
  });

  test('ready после монтирования не закрывает форму, submit возвращает данные формы и закрывает её', async () => {
    const outcome = track(provider.show('Контрагенты', true));
    const [panel] = panels.panels;
    assert.deepStrictEqual(readInitialState(panel.htmlHistory[0]), { targetLabel: 'Контрагенты', initiallyLocked: true });

    panel.receive({ type: 'ready' });

    assert.deepStrictEqual(await outcome(), { settled: false });
    assert.strictEqual(panel.isDisposed(), false);

    panel.receive({ type: 'command', command: 'submit', payload: FORM_DATA });

    assert.deepStrictEqual(await outcome(), { settled: true, value: FORM_DATA });
    assert.strictEqual(panel.isDisposed(), true);
  });

  test('cancel возвращает undefined и закрывает форму', async () => {
    const outcome = track(provider.show('Контрагенты', false));
    const [panel] = panels.panels;
    panel.receive({ type: 'ready' });

    panel.receive({ type: 'command', command: 'cancel' });

    assert.deepStrictEqual(await outcome(), { settled: true, value: undefined });
    assert.strictEqual(panel.isDisposed(), true);
  });

  [
    { name: 'сообщение другого типа', message: { type: 'request', requestId: '1', name: 'browse' } },
    { name: 'неизвестная команда', message: { type: 'command', command: 'refresh' } },
  ].forEach(({ name, message }) => {
    test(`${name} игнорируется: форма остаётся открытой`, async () => {
      const outcome = track(provider.show('Контрагенты', false));
      const [panel] = panels.panels;

      panel.receive(message);

      assert.deepStrictEqual(await outcome(), { settled: false });
      assert.strictEqual(panel.isDisposed(), false);
    });
  });

  test('закрытие вкладки пользователем возвращает undefined', async () => {
    const outcome = track(provider.show('Контрагенты', false));

    panels.panels[0].panel.dispose();

    assert.deepStrictEqual(await outcome(), { settled: true, value: undefined });
  });

  test('повторный show при открытой форме: прежний вызов получает undefined, форма перерисована под новый узел', async () => {
    const first = track(provider.show('Контрагенты', false));
    const second = track(provider.show('Банки', true));

    assert.strictEqual(panels.panels.length, 1);
    const [panel] = panels.panels;
    assert.strictEqual(panel.revealCount(), 1);
    assert.deepStrictEqual(await first(), { settled: true, value: undefined });
    assert.deepStrictEqual(readInitialState(panel.htmlHistory[1]), { targetLabel: 'Банки', initiallyLocked: true });

    panel.receive({ type: 'ready' });
    panel.receive({ type: 'command', command: 'submit', payload: FORM_DATA });

    assert.deepStrictEqual(await second(), { settled: true, value: FORM_DATA });
  });

  test('после закрытия формы show открывает новую панель', async () => {
    const first = track(provider.show('Контрагенты', false));
    panels.panels[0].receive({ type: 'command', command: 'cancel' });
    await first();

    const second = track(provider.show('Банки', false));

    assert.strictEqual(panels.panels.length, 2);
    panels.panels[1].receive({ type: 'command', command: 'submit', payload: FORM_DATA });
    assert.deepStrictEqual(await second(), { settled: true, value: FORM_DATA });
  });

  test('dispose провайдера закрывает открытую форму с результатом undefined', async () => {
    const outcome = track(provider.show('Контрагенты', false));

    provider.dispose();

    assert.strictEqual(panels.panels[0].isDisposed(), true);
    assert.deepStrictEqual(await outcome(), { settled: true, value: undefined });
  });
});
