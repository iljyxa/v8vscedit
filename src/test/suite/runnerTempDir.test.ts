import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withIsolatedTempDir } from '../runnerTempDir';

/**
 * Issue #82: тесты оставляли в `os.tmpdir()` сотни каталогов за прогон, tmpfs
 * переполнялся, и следующие прогоны сыпались на EDQUOT. Раннер отдаёт хосту
 * расширений собственный временный каталог и удаляет его целиком после прогона.
 * Родитель передаётся явно, чтобы тесты не трогали настоящий `os.tmpdir()`.
 */
suite('Изолированный временный каталог тестового прогона (issue #82)', () => {
  let parent: string;

  setup(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-runner-tmp-'));
  });

  teardown(() => {
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('TMPDIR, TMP и TEMP указывают на один новый каталог внутри родителя', async () => {
    let seen: Record<string, string> | undefined;
    await withIsolatedTempDir(async (env) => {
      seen = env;
      await Promise.resolve();
    }, parent);

    assert.ok(seen);
    const dir = seen.TMPDIR;
    assert.deepStrictEqual(seen, { TMPDIR: dir, TMP: dir, TEMP: dir });
    assert.strictEqual(path.dirname(dir), parent);
    assert.ok(path.basename(dir).startsWith('v8t-run-'), path.basename(dir));
  });

  test('каталог существует во время прогона и удаляется со всем содержимым после', async () => {
    let dir = '';
    const result = await withIsolatedTempDir(async (env) => {
      dir = env.TMPDIR;
      assert.ok(fs.statSync(dir).isDirectory());
      const leaked = fs.mkdtempSync(path.join(dir, 'v8-fmt-'));
      fs.writeFileSync(path.join(leaked, 'Configuration.xml'), '<x/>', 'utf-8');
      await Promise.resolve();
      return 42;
    }, parent);

    assert.strictEqual(result, 42);
    assert.strictEqual(fs.existsSync(dir), false);
    assert.deepStrictEqual(fs.readdirSync(parent), []);
  });

  test('при падении прогона каталог тоже удаляется, а ошибка пробрасывается', async () => {
    let dir = '';
    await assert.rejects(
      withIsolatedTempDir(async (env) => {
        dir = env.TMPDIR;
        fs.writeFileSync(path.join(dir, 'leak.txt'), 'x', 'utf-8');
        await Promise.resolve();
        throw new Error('Test run failed with code 1');
      }, parent),
      /Test run failed with code 1/
    );

    assert.strictEqual(fs.existsSync(dir), false);
    assert.deepStrictEqual(fs.readdirSync(parent), []);
  });

  test('сбой удаления не подменяет исход прогона: результат возвращается, в журнал — предупреждение', async function () {
    // Удаление срывается на каталоге без права записи в родителя; под root и на Windows
    // права так не ограничить.
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      this.skip();
    }
    const warnings: string[] = [];
    let dir = '';
    try {
      const result = await withIsolatedTempDir(async (env) => {
        dir = env.TMPDIR;
        fs.chmodSync(parent, 0o500);
        await Promise.resolve();
        return 'passed';
      }, parent, (message) => warnings.push(message));

      assert.strictEqual(result, 'passed');
    } finally {
      fs.chmodSync(parent, 0o700);
    }

    assert.strictEqual(fs.existsSync(dir), true);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes(dir), warnings[0]);
  });

  test('сбой удаления после упавшего прогона: пробрасывается ошибка прогона, а не удаления', async function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      this.skip();
    }
    const warnings: string[] = [];
    let dir = '';
    try {
      await assert.rejects(
        withIsolatedTempDir(async (env) => {
          dir = env.TMPDIR;
          fs.chmodSync(parent, 0o500);
          await Promise.resolve();
          throw new Error('Test run failed with code 1');
        }, parent, (message) => warnings.push(message)),
        /Test run failed with code 1/
      );
    } finally {
      fs.chmodSync(parent, 0o700);
    }

    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes(dir), warnings[0]);
  });
});
