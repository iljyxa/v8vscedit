import * as vscode from 'vscode';
import { WebviewHtmlFactory } from './webview/WebviewHtmlFactory';

export interface RepositoryCommitFormData {
  readonly comment: string;
  readonly recursive: boolean;
  readonly keepLocked: boolean;
  readonly force: boolean;
}

type RepositoryCommitMessage =
  | { readonly type: 'command'; readonly command: 'submit'; readonly payload: RepositoryCommitFormData }
  | { readonly type: 'command'; readonly command: 'cancel' }
  | { readonly type: 'ready' };

/**
 * Провайдер панели помещения изменений в хранилище 1С.
 * Использует Vue-приложение для рендеринга формы.
 */
export class RepositoryCommitViewProvider implements vscode.Disposable {
  static readonly viewType = 'v8vsceditRepositoryCommitPanel';

  private panel: vscode.WebviewPanel | undefined;
  private resolvePromise: ((value: RepositoryCommitFormData | undefined) => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri
  ) {}

  /**
   * Показывает панель коммита в хранилище.
   * Повторный вызов при открытой панели перерисовывает форму под новый узел, а прежний
   * вызов получает `undefined`: иначе его промис навсегда остался бы неразрешённым.
   * @returns Promise с данными формы или undefined при отмене.
   */
  show(
    targetLabel: string,
    initiallyLocked: boolean
  ): Promise<RepositoryCommitFormData | undefined> {
    if (this.panel) {
      this.settle(undefined);
      this.renderHtml(this.panel, targetLabel, initiallyLocked);
      this.panel.reveal(vscode.ViewColumn.Active);
      return this.waitForResult();
    }

    const panel = vscode.window.createWebviewPanel(
      RepositoryCommitViewProvider.viewType,
      'Помещение в хранилище',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.panel = panel;

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'ui')],
    };

    this.renderHtml(panel, targetLabel, initiallyLocked);

    panel.webview.onDidReceiveMessage((message: RepositoryCommitMessage) => {
      this.handleMessage(message);
    });

    panel.onDidDispose(() => {
      this.settle(undefined);
      this.panel = undefined;
    });

    return this.waitForResult();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private renderHtml(panel: vscode.WebviewPanel, targetLabel: string, initiallyLocked: boolean): void {
    const factory = new WebviewHtmlFactory(this.extensionUri);
    panel.webview.html = factory.renderVueWebviewHtml({
      webview: panel.webview,
      title: 'Помещение в хранилище',
      entry: 'repository-commit',
      viewKind: 'repository-commit',
      initialState: {
        targetLabel,
        initiallyLocked,
      },
      csp: { allowStyles: true },
    });
  }

  private waitForResult(): Promise<RepositoryCommitFormData | undefined> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  private settle(value: RepositoryCommitFormData | undefined): void {
    const resolve = this.resolvePromise;
    this.resolvePromise = undefined;
    resolve?.(value);
  }

  /**
   * Форму закрывают только `submit`/`cancel`. Webview после монтирования шлёт `ready`,
   * и прежняя трактовка «всё, кроме submit, — отмена» закрывала форму сразу.
   */
  private handleMessage(message: RepositoryCommitMessage): void {
    if (message.type !== 'command') {
      return;
    }
    switch (message.command) {
      case 'submit':
        this.settle(message.payload);
        break;
      case 'cancel':
        this.settle(undefined);
        break;
      default:
        return;
    }
    this.panel?.dispose();
    this.panel = undefined;
  }
}
