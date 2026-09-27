import * as fs from 'fs';

/**
 * Примитив удаления файлов и каталогов, общий для операций хранилища и временных
 * каталогов операций Конфигуратора: на Windows удаление регулярно упирается в чужие
 * дескрипторы (антивирус, индексатор, watcher LSP-сервера), и повтор попыток нужен везде.
 */

/** Примитив удаления файла/каталога; внедряется ради сбоев совместного доступа Windows. */
export type RemoveTree = (targetPath: string) => void;

/**
 * На Windows EPERM/EBUSY/ENOTEMPTY при удалении обычно временные — файл держит антивирус,
 * индексатор или LSP-сервер; `rmSync` повторяет попытку только при заданных `maxRetries`.
 */
export const FS_RM_MAX_RETRIES = 3;
export const FS_RM_RETRY_DELAY_MS = 100;

/** Удаление файла или каталога целиком; отсутствие пути — не ошибка. */
export function removePathWithRetries(targetPath: string): void {
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: FS_RM_MAX_RETRIES,
    retryDelay: FS_RM_RETRY_DELAY_MS,
  });
}

/**
 * Код ошибки ФС ('EPERM') вместо message: в message Node путь приходит в неверной кодировке
 * (`\\?\c:\Ïðîåêòû\…`), поэтому вызывающий подставляет свой путь. Error без строкового
 * code — message; не-Error — String().
 */
export function describeFsError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : error.message;
  }
  return String(error);
}
