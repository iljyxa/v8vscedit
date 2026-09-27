import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Переменные, по которым `os.tmpdir()` находит временный каталог на Linux/macOS и Windows. */
export type TempDirEnv = Record<'TMPDIR' | 'TMP' | 'TEMP', string>;

/**
 * Выполняет прогон с собственным временным каталогом и удаляет его после прогона,
 * в том числе упавшего. Каталог передаётся хосту расширений через окружение, поэтому
 * всё, что тесты (и сам код расширения) создают в `os.tmpdir()`, уходит вместе с ним.
 * Удалять каталоги поштучно в каждом тесте недостаточно: утечка — сотни каталогов
 * за прогон из десятков сьютов, и любой новый тест вернул бы её (issue #82).
 */
export async function withIsolatedTempDir<T>(
  run: (env: TempDirEnv) => Promise<T>,
  parent: string = os.tmpdir(),
  warn: (message: string) => void = (message) => { console.warn(message); }
): Promise<T> {
  // Префикс короткий: VS Code кладёт в этот каталог IPC-сокеты, а на macOS путь сокета
  // ограничен 104 символами при и без того длинном `TMPDIR`.
  const dir = fs.mkdtempSync(path.join(parent, 'v8t-run-'));
  try {
    return await run({ TMPDIR: dir, TMP: dir, TEMP: dir });
  } finally {
    // Повторы — на случай, когда Windows ещё держит файлы только что завершённого хоста.
    // Неудачная уборка не должна ни подменять ошибку прогона, ни валить зелёный прогон.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`Не удалось удалить временный каталог прогона ${dir}: ${reason}`);
    }
  }
}
