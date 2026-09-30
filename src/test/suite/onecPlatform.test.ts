import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  normalizeInfoBasePath,
  resolveV8ExecutablePath,
  resolveV8PathHintFromVersion,
  scanInstalledOnecPlatforms,
} from '../../infra/process/OnecPlatform';

suite('OnecPlatform', () => {
  test('Сохраняет абсолютный путь файловой базы на macOS/Linux', () => {
    assert.strictEqual(
      normalizeInfoBasePath('/Users/test/InfoBases/dev', 'darwin'),
      '/Users/test/InfoBases/dev'
    );
  });

  test('Нормализует Windows-путь файловой базы только на Windows', () => {
    assert.strictEqual(
      normalizeInfoBasePath('C:/InfoBases/dev', 'win32'),
      'C:\\InfoBases\\dev'
    );
  });

  test('Раскрывает домашний каталог на Unix-платформах', () => {
    assert.ok(normalizeInfoBasePath('~/InfoBases/dev', 'linux').endsWith('/InfoBases/dev'));
  });

  test('Берёт бинарник из macOS app, а не ресурс иконки', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-onec-platform-'));
    try {
      const binaryPath = path.join(root, '1cv8.app', 'Contents', 'MacOS', '1cv8');
      const iconPath = path.join(root, '1cv8s.app', 'Contents', 'Resources', '1cv8s.icns');
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.mkdirSync(path.dirname(iconPath), { recursive: true });
      fs.writeFileSync(binaryPath, '');
      fs.writeFileSync(iconPath, '');
      fs.chmodSync(binaryPath, 0o755);
      fs.chmodSync(iconPath, 0o644);

      assert.strictEqual(resolveV8ExecutablePath(root, 'darwin'), binaryPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Предпочитает 1cv8 перед 1cv8c внутри каталога версии', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-onec-priority-'));
    try {
      const thickClient = path.join(root, '1cv8');
      const binClient = path.join(root, 'bin', '1cv8');
      const macOsClient = path.join(root, 'Contents', 'MacOS', '1cv8');
      const thinClient = path.join(root, '1cv8c.app', 'Contents', 'MacOS', '1cv8c');
      fs.mkdirSync(path.dirname(binClient), { recursive: true });
      fs.mkdirSync(path.dirname(macOsClient), { recursive: true });
      fs.mkdirSync(path.dirname(thinClient), { recursive: true });
      fs.writeFileSync(thickClient, '');
      fs.writeFileSync(binClient, '');
      fs.writeFileSync(macOsClient, '');
      fs.writeFileSync(thinClient, '');
      fs.chmodSync(thickClient, 0o755);
      fs.chmodSync(binClient, 0o755);
      fs.chmodSync(macOsClient, 0o755);
      fs.chmodSync(thinClient, 0o755);

      const resolved = resolveV8ExecutablePath(root, 'darwin');
      assert.strictEqual(path.basename(resolved), '1cv8');
      assert.ok(!resolved.includes('1cv8c.app'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Строит macOS-путь к версии платформы из env.json', () => {
    assert.strictEqual(
      resolveV8PathHintFromVersion('8.5.1.1150', 'darwin'),
      '/opt/1cv8/8.5.1.1150'
    );
  });

  suite('Linux: каталог архитектуры в установке платформы', () => {
    let root: string;

    suiteSetup(function () {
      // Набор проверяет Unix-раскладку на реальной ФС: временный каталог Windows-хоста
      // с обратными слэшами не совпадёт с posix-шаблонами поиска.
      if (process.platform === 'win32') {
        this.skip();
      }
    });

    // Раскладка /opt/1cv8 после единого установщика (setup-full-*.run, 8.3.20+):
    // версии лежат под каталогом архитектуры, рядом служебные common/ и conf/.
    function makeExecutable(...segments: string[]): string {
      const filePath = path.join(root, ...segments);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '');
      fs.chmodSync(filePath, 0o755);
      return filePath;
    }

    setup(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-onec-linux-'));
      makeExecutable('common', '1cestart');
      fs.mkdirSync(path.join(root, 'conf'), { recursive: true });
    });

    teardown(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    function scanUnderRoot(): string[] {
      return scanInstalledOnecPlatforms('linux', [root])
        .filter((item) => item.executablePath.startsWith(root))
        .map((item) => item.executablePath);
    }

    test('scanInstalledOnecPlatforms находит версии под x86_64 и i386, свежие первыми', () => {
      const latest = makeExecutable('x86_64', '8.3.27.2342', '1cv8');
      makeExecutable('x86_64', '8.3.27.2342', '1cv8c');
      const older = makeExecutable('x86_64', '8.3.25.1000', '1cv8');
      const x86 = makeExecutable('i386', '8.3.20.1500', '1cv8c');

      assert.deepStrictEqual(scanUnderRoot(), [latest, older, x86]);
    });

    test('scanInstalledOnecPlatforms сохраняет раскладку без каталога архитектуры', () => {
      const flat = makeExecutable('8.3.10.2000', '1cv8');
      const legacyDeb = makeExecutable('x86_64', '1cv8');

      const found = scanUnderRoot();
      assert.ok(found.includes(flat));
      assert.ok(found.includes(legacyDeb));
    });

    test('scanInstalledOnecPlatforms на macOS тоже видит каталог архитектуры', () => {
      const latest = makeExecutable('x86_64', '8.5.1.1150', '1cv8');

      const found = scanInstalledOnecPlatforms('darwin', [root])
        .filter((item) => item.executablePath.startsWith(root))
        .map((item) => item.executablePath);
      assert.deepStrictEqual(found, [latest]);
    });

    test('resolveV8PathHintFromVersion указывает на каталог версии под архитектурой', () => {
      makeExecutable('x86_64', '8.3.27.2342', '1cv8');

      assert.strictEqual(
        resolveV8PathHintFromVersion('8.3.27.2342', 'linux', [root]),
        path.join(root, 'x86_64', '8.3.27.2342')
      );
    });

    test('resolveV8PathHintFromVersion без установленной версии возвращает первый кандидат', () => {
      assert.strictEqual(
        resolveV8PathHintFromVersion('8.3.99.1', 'linux', [root]),
        path.join(root, '8.3.99.1')
      );
    });

    test('resolveV8ExecutablePath по корню установки выбирает самую свежую версию', () => {
      makeExecutable('x86_64', '8.3.25.1000', '1cv8');
      const latest = makeExecutable('x86_64', '8.3.27.2342', '1cv8');

      assert.strictEqual(resolveV8ExecutablePath(root, 'linux'), latest);
    });

    test('resolveV8ExecutablePath по каталогу архитектуры выбирает самую свежую версию', () => {
      makeExecutable('x86_64', '8.3.25.1000', '1cv8');
      const latest = makeExecutable('x86_64', '8.3.27.2342', '1cv8');

      assert.strictEqual(resolveV8ExecutablePath(path.join(root, 'x86_64'), 'linux'), latest);
    });

    test('resolveV8ExecutablePath не трактует символы шаблона в пути как glob', () => {
      // Без экранирования «[x]» стал бы классом символов и совпал бы с каталогом «x».
      makeExecutable('x', 'x86_64', '8.3.27.2342', '1cv8');
      const expected = makeExecutable('[x]', 'x86_64', '8.3.25.1000', '1cv8');

      assert.strictEqual(resolveV8ExecutablePath(path.join(root, '[x]'), 'linux'), expected);
    });
  });
});
