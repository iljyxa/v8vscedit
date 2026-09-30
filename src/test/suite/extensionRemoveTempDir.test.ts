import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { createWorkspaceTempDir, removeTempDir } from '../../ui/commands/ext/ExtensionCommandRunner';

/**
 * Временный каталог операции Конфигуратора удаляется с повторами (на Windows его держит
 * watcher bsl-analyzer), а сбой логируется кодом ошибки ФС, а не message Node с путём в
 * неверной кодировке. Каталог создаётся настоящим `createWorkspaceTempDir` и наполняется
 * файлами в раскладке выгрузки.
 */

const LANGUAGE_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject><Language><Properties><Name>Русский</Name></Properties></Language></MetaDataObject>\n';

suite('ExtensionCommandRunner — removeTempDir', () => {
  const roots: string[] = [];
  const lockedDirs: string[] = [];

  function makeWorkspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-remove-temp-'));
    roots.push(root);
    return root;
  }

  function createOutput(): { lines: string[]; channel: vscode.OutputChannel } {
    const lines: string[] = [];
    return { lines, channel: { appendLine: (line: string) => lines.push(line) } as unknown as vscode.OutputChannel };
  }

  function makeFilledTempDir(): string {
    const tempRoot = createWorkspaceTempDir(makeWorkspace(), 'import-cf-');
    fs.mkdirSync(path.join(tempRoot, 'Languages'));
    fs.writeFileSync(path.join(tempRoot, 'Languages', 'Русский.xml'), LANGUAGE_XML, 'utf-8');
    fs.writeFileSync(path.join(tempRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
    return tempRoot;
  }

  teardown(() => {
    for (const dir of lockedDirs.splice(0)) {
      fs.chmodSync(dir, 0o700);
    }
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('каталог с файлами выгрузки удаляется, лог пуст', () => {
    const tempRoot = makeFilledTempDir();
    const output = createOutput();
    removeTempDir(tempRoot, output.channel);
    assert.strictEqual(fs.existsSync(tempRoot), false);
    assert.deepStrictEqual(output.lines, []);
  });

  test('отсутствующий каталог — без исключения, лог пуст', () => {
    const tempRoot = path.join(makeWorkspace(), '.v8vscedit', 'import-temp', 'нет-такого');
    const output = createOutput();
    removeTempDir(tempRoot, output.channel);
    assert.deepStrictEqual(output.lines, []);
  });

  test('сбой удаления — одна строка предупреждения с кодом ошибки, без исключения', function () {
    // Запрет записи в каталог через chmod не действует на Windows и для root —
    // там сбой удаления таким способом не воспроизвести.
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      this.skip();
    }
    const tempRoot = makeFilledTempDir();
    const locked = path.join(tempRoot, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'Русский.xml'), LANGUAGE_XML, 'utf-8');
    fs.chmodSync(locked, 0o500);
    lockedDirs.push(locked);
    const output = createOutput();

    removeTempDir(tempRoot, output.channel);

    // Конкретный errno зависит от реализации rmSync в Node хоста (нативная сообщает
    // ENOTEMPTY корня, JS-обход — EACCES вложенного файла); контракт — код, а не message с путём.
    assert.strictEqual(output.lines.length, 1);
    const prefix = `[actions][warn] Не удалось удалить временный каталог ${tempRoot}: `;
    assert.ok(output.lines[0].startsWith(prefix), output.lines[0]);
    assert.match(output.lines[0].slice(prefix.length), /^(ENOTEMPTY|EACCES)$/);
    assert.ok(fs.existsSync(locked), 'заблокированный каталог остаётся на месте');
  });
});
