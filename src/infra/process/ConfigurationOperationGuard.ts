/**
 * Общая блокировка операций полного импорта/обновления/применения конфигурации
 * к базе в пределах одного окна. Раньше флаг жил модульной переменной
 * `ExtensionCommands`, и синхронизация с хранилищем шла мимо него — два
 * Конфигуратора могли одновременно работать с одной базой.
 */

/** Аренда блокировки; `release()` идемпотентен и не трогает чужую аренду. */
export interface ConfigurationOperationLease {
  release(): void;
}

export type ConfigurationOperationExclusiveResult<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false; readonly heldBy: string };

export interface ConfigurationOperationGuardSubscription {
  dispose(): void;
}

interface HolderToken {
  readonly title: string;
}

export class ConfigurationOperationGuard {
  private holder: HolderToken | undefined;
  private readonly listeners = new Set<(busy: boolean) => void>();

  constructor(private readonly onListenerError?: (error: unknown) => void) {}

  get isBusy(): boolean {
    return this.holder !== undefined;
  }

  get heldBy(): string | undefined {
    return this.holder?.title;
  }

  /**
   * Проверка и захват — одна синхронная операция: между ними нет `await`,
   * поэтому две команды, стартовавшие в одном тике, не займут guard обе.
   */
  tryAcquire(operationTitle: string): ConfigurationOperationLease | undefined {
    if (this.holder) {
      return undefined;
    }
    return this.acquire(operationTitle);
  }

  async runExclusive<T>(
    operationTitle: string,
    operation: () => Promise<T>
  ): Promise<ConfigurationOperationExclusiveResult<T>> {
    const current = this.holder;
    if (current) {
      return { acquired: false, heldBy: current.title };
    }
    const lease = this.acquire(operationTitle);
    try {
      return { acquired: true, value: await operation() };
    } finally {
      lease.release();
    }
  }

  onDidChangeBusy(listener: (busy: boolean) => void): ConfigurationOperationGuardSubscription {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Вызывается только при свободном guard'е — проверку делают вызывающие. */
  private acquire(operationTitle: string): ConfigurationOperationLease {
    const token: HolderToken = { title: operationTitle };
    this.holder = token;
    this.emit(true);
    return {
      release: () => {
        // Сравнение по токену: протухшая аренда (уже отпущенная, guard занят
        // другим) не должна снимать чужую блокировку.
        if (this.holder !== token) {
          return;
        }
        this.holder = undefined;
        this.emit(false);
      },
    };
  }

  private emit(busy: boolean): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(busy);
      } catch (error) {
        // Сбой подписчика (например, setContext) не должен ломать саму
        // операцию и лишать остальных подписчиков уведомления.
        this.onListenerError?.(error);
      }
    }
  }
}
