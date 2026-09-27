import * as fs from 'fs';
import * as path from 'path';

/**
 * Настоящий исполняемый файл с именем `1cv8`, который записывает свои аргументы
 * построчно и завершается. Нужен, чтобы проверить командную строку запуска
 * конфигуратора через реальный `spawn`, не поднимая платформу 1С с GUI.
 * Запись идёт во временный файл с последующим `mv`: появление итогового файла
 * означает, что аргументы записаны полностью.
 */
export interface ArgsRecordingDesigner {
  readonly executablePath: string;
  waitForArgs(timeoutMs?: number): Promise<string[]>;
}

export function createArgsRecordingDesigner(dir: string): ArgsRecordingDesigner {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const executablePath = path.join(binDir, '1cv8');
  const argsPath = path.join(dir, 'designer-args.txt');
  fs.writeFileSync(
    executablePath,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsPath}.tmp" && mv "${argsPath}.tmp" "${argsPath}"\n`,
    { encoding: 'utf-8', mode: 0o755 }
  );
  return {
    executablePath,
    async waitForArgs(timeoutMs = 10000): Promise<string[]> {
      const deadline = Date.now() + timeoutMs;
      while (!fs.existsSync(argsPath)) {
        if (Date.now() > deadline) {
          throw new Error(`Процесс-заглушка 1cv8 не записал аргументы за ${String(timeoutMs)} мс`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return fs.readFileSync(argsPath, 'utf-8').split('\n').filter((line) => line.length > 0);
    },
  };
}
