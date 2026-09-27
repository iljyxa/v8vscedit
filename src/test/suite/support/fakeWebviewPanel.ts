import * as vscode from 'vscode';

/**
 * Панель, которую отдаёт подменённый `vscode.window.createWebviewPanel`.
 * Настоящую `WebviewPanel` в headless-хосте получить нельзя: сообщения из её webview
 * приходят только от исполняемого в ней Vue-приложения. Поэтому семантика воспроизведена
 * вручную: `dispose` один раз стреляет `onDidDispose`, `html` хранит историю присваиваний,
 * сообщения webview доставляются через тот же `onDidReceiveMessage`.
 */
export interface FakeWebviewPanel {
  readonly panel: vscode.WebviewPanel;
  /** Все значения, присвоенные `webview.html`, по порядку. */
  readonly htmlHistory: string[];
  readonly isDisposed: () => boolean;
  readonly revealCount: () => number;
  /** Доставляет провайдеру сообщение так, как его прислал бы webview. */
  readonly receive: (message: unknown) => void;
}

export interface FakeWebviewPanelFactory {
  readonly panels: FakeWebviewPanel[];
  /** Вызывается при каждом присваивании `webview.html` — момент, когда webview начинает загрузку. */
  onHtml: (panel: FakeWebviewPanel) => void;
  readonly restore: () => void;
}

/** Состояние, встроенное в HTML webview (`#v8vscedit-initial-state`). */
export function readInitialState(html: string): unknown {
  const match = /id="v8vscedit-initial-state">([^<]*)<\/script>/.exec(html);
  if (!match) {
    throw new Error('В HTML нет начального состояния webview');
  }
  return (JSON.parse(match[1]) as { state: unknown }).state;
}

function createFakePanel(onHtml: (panel: FakeWebviewPanel) => void): FakeWebviewPanel {
  const messages = new vscode.EventEmitter<unknown>();
  const disposeEmitter = new vscode.EventEmitter<void>();
  const htmlHistory: string[] = [];
  let disposed = false;
  let reveals = 0;

  const webview = {
    options: {},
    cspSource: 'vscode-webview://fake',
    get html(): string {
      return htmlHistory[htmlHistory.length - 1] ?? '';
    },
    set html(value: string) {
      htmlHistory.push(value);
      onHtml(fake);
    },
    onDidReceiveMessage: messages.event,
    postMessage: () => Promise.resolve(true),
    asWebviewUri: (uri: vscode.Uri) => uri,
  } as unknown as vscode.Webview;

  const panel = {
    webview,
    onDidDispose: disposeEmitter.event,
    reveal: () => { reveals += 1; },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeEmitter.fire();
    },
  } as unknown as vscode.WebviewPanel;

  const fake: FakeWebviewPanel = {
    panel,
    htmlHistory,
    isDisposed: () => disposed,
    revealCount: () => reveals,
    receive: (message) => messages.fire(message),
  };
  return fake;
}

/** Подменяет `vscode.window.createWebviewPanel`; `restore()` возвращает оригинал. */
export function installFakeWebviewPanels(): FakeWebviewPanelFactory {
  const windowRef = vscode.window as Pick<typeof vscode.window, 'createWebviewPanel'>;
  const original = windowRef.createWebviewPanel;
  const factory: FakeWebviewPanelFactory = {
    panels: [],
    onHtml: () => undefined,
    restore: () => { windowRef.createWebviewPanel = original; },
  };
  windowRef.createWebviewPanel = () => {
    const fake = createFakePanel((panel) => factory.onHtml(panel));
    factory.panels.push(fake);
    return fake.panel;
  };
  return factory;
}
