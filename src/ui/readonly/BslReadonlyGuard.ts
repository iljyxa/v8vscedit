import * as path from 'path';
import * as vscode from 'vscode';
import type { RepositoryService } from '../../infra/repository/RepositoryService';
import type { SupportInfoService } from '../../infra/support/SupportInfoService';

/**
 * Переводит file:// BSL-файлы в readonly, если редактирование запрещено
 * поддержкой или объект не захвачен в хранилище.
 * Несохранённый документ (например, буфер, восстановленный hot exit после перезапуска)
 * не переводится: readonly сессии запрещает сохранение, и правки можно было бы только
 * потерять. Переход откладывается до сохранения или отката правок.
 */
export class BslReadonlyGuard {
  // Отслеживает документы, для которых readonly-статус уже применён в этой
  // сессии, — синхронный путь и fallback-watcher в `register()` теоретически
  // могут пересечься для одного и того же документа (например, при split-editor:
  // документ становится видимым сразу в нескольких группах). `WeakSet` по
  // идентичности `TextDocument`: при реальном закрытии и повторном открытии
  // файла VS Code создаёт новый объект документа — трекинг для него сбрасывается
  // сам собой, readonly-статус применится заново (это корректно и нужно).
  private readonly appliedTo = new WeakSet<vscode.TextDocument>();
  /** Подписки отложенного перехода: документ ждёт сохранения или отката правок. */
  private readonly pendingClean = new Map<vscode.TextDocument, vscode.Disposable>();

  constructor(
    private readonly supportService: SupportInfoService,
    private readonly repositoryService: RepositoryService,
    private readonly log: vscode.OutputChannel
  ) {}

  /** Подписывается на открытия BSL-файлов и помечает редактор readonly в текущей сессии. */
  register(): vscode.Disposable {
    const open = vscode.workspace.onDidOpenTextDocument(async (doc) => {
      if (doc.uri.scheme !== 'file') {
        return;
      }
      if (!doc.fileName.toLowerCase().endsWith('.bsl')) {
        return;
      }

      if (!this.isRestricted(doc.fileName)) {
        return;
      }

      this.log.appendLine(`[readonly] Блокировка file:// BSL: ${path.basename(doc.fileName)}`);

      // Типичный случай: к моменту открытия редактор уже видим. Ставим readonly
      // синхронно, не дожидаясь события смены видимых редакторов.
      const visibleEditor = vscode.window.visibleTextEditors.find(
        (item) => item.document.uri.toString() === doc.uri.toString()
      );
      if (visibleEditor) {
        await this.applyReadonly(visibleEditor);
        return;
      }

      // Запасной путь: редактор может стать видимым позже (например, открытие в фоне).
      const watcher = vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
        const editor = editors.find((item) => item.document.uri.toString() === doc.uri.toString());
        if (!editor) {
          return;
        }

        watcher.dispose();
        await this.applyReadonly(editor);
      });

      setTimeout(() => {
        watcher.dispose();
      }, 5_000);
    });
    return new vscode.Disposable(() => {
      open.dispose();
      for (const pending of this.pendingClean.values()) {
        pending.dispose();
      }
      this.pendingClean.clear();
    });
  }

  private isRestricted(fileName: string): boolean {
    return this.supportService.isLocked(fileName) || this.repositoryService.isEditRestricted(fileName);
  }

  /**
   * Ждёт, пока документ станет чистым (сохранение или откат), и тогда применяет readonly,
   * если запрет к этому моменту ещё действует и документ по-прежнему виден. Закрытие
   * без сохранения VS Code выполняет через откат, поэтому ожидание снимается и в этом случае.
   */
  private deferUntilClean(document: vscode.TextDocument): void {
    if (this.pendingClean.has(document)) {
      return;
    }
    const finish = (): void => {
      this.pendingClean.get(document)?.dispose();
      this.pendingClean.delete(document);
    };
    const onClean = async (): Promise<void> => {
      finish();
      if (!this.isRestricted(document.fileName)) {
        return;
      }
      const editor = vscode.window.visibleTextEditors.find((item) => item.document === document);
      if (editor) {
        await this.applyReadonly(editor);
      }
    };
    this.pendingClean.set(document, vscode.Disposable.from(
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved === document) {
          void onClean();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === document && !document.isDirty) {
          void onClean();
        }
      })
    ));
  }

  /** Делает указанный видимый редактор readonly в текущей сессии. */
  private async applyReadonly(editor: vscode.TextEditor): Promise<void> {
    if (this.appliedTo.has(editor.document)) {
      return;
    }
    // Признак проверяется в момент применения, а не при открытии: к этому моменту
    // восстановленный буфер уже получил свои правки. В `appliedTo` документ не попадает:
    // readonly для него ещё не применён и применится, когда правки сохранят или откатят.
    if (editor.document.isDirty) {
      this.log.appendLine(`[readonly] Только чтение отложено до сохранения правок: ${path.basename(editor.document.fileName)}`);
      this.deferUntilClean(editor.document);
      return;
    }
    this.appliedTo.add(editor.document);

    // `preserveFocus: true` — редактор становится активным (это всё, что нужно
    // команде ниже: она применяется к `window.activeTextEditor`), но фокус
    // клавиатуры не отбирается у текущего фокуса (например, у webview-панели
    // навигатора с открытым контекстным меню). До этой правки `false` безусловно
    // перехватывал фокус на каждое (пере)применение readonly-статуса, включая
    // фоновые срабатывания через `onDidChangeVisibleTextEditors` — см. issue #4.
    await vscode.window.showTextDocument(editor.document, {
      viewColumn: editor.viewColumn,
      preserveFocus: true,
    });
    await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
  }
}
