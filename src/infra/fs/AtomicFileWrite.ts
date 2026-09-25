import * as fs from 'fs';
import * as path from 'path';

/**
 * Записывает текстовый файл атомарно: сначала во временный файл рядом, затем
 * подменяет целевой через rename. Прерывание записи (закрытие окна, падение
 * процесса) не должно оставлять на диске обрезанный JSON служебных кэшей.
 */
export function writeFileAtomicSync(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // pid и метка времени в имени исключают столкновение временных файлов
  // параллельных процессов (расширение и CLI пишут в один каталог кэша).
  const tempPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}
