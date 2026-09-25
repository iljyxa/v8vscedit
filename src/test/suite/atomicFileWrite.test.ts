import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSync } from '../../infra/fs/AtomicFileWrite';

function listTmpFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

suite('AtomicFileWrite', () => {
  test('создаёт вложенные каталоги и атомарно записывает содержимое без временных файлов', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-atomic-write-ok-'));
    try {
      const target = path.join(tempRoot, 'a', 'b', 'c.json');
      writeFileAtomicSync(target, '{"x":1}');

      assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{"x":1}');
      assert.deepStrictEqual(listTmpFiles(path.dirname(target)), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('бросает и не оставляет .tmp, если на месте целевого файла каталог', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-atomic-write-fail-'));
    try {
      const target = path.join(tempRoot, 'dir-as-file');
      fs.mkdirSync(target);

      assert.throws(() => writeFileAtomicSync(target, 'content'));
      assert.ok(fs.statSync(target).isDirectory(), 'целевой каталог должен остаться нетронутым');
      assert.deepStrictEqual(listTmpFiles(tempRoot), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
