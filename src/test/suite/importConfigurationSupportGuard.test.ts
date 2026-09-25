/**
 * Issue #19: импорт XML в основную конфигурацию отбивается настройками поддержки
 * только при флаге «изменения запрещены» заголовка `Ext/ParentConfigurations.bin`.
 * Без флага загрузку проверяет сама платформа (объект с кодом 0 отбивается, коды
 * 1 и 2 загружаются), и прежний отказ по одному наличию файла не давал загрузить
 * даже правку редактируемых объектов.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importConfiguration } from '../../cli/commands/importConfiguration';
import { mainConfigurationImportBlockReason } from '../../infra/support/SupportImportGuard';
import {
  CHANGES_FORBIDDEN_BIN_PATH,
  EXAMPLE_CF_ROOTS,
  MALFORMED_BIN_CASES,
} from './support/realConfigFixtures';

const FORBIDDEN_REASON = 'изменения конфигурации запрещены в настройках поддержки';

interface TempLayout {
  readonly tempDir: string;
  readonly configDir: string;
  dispose(): void;
}

/** Каталог выгрузки, в котором гарду нужен только `Ext/ParentConfigurations.bin`. */
function makeConfigDir(bin: { copyFrom: string } | { text: string } | undefined): TempLayout {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-import-guard-'));
  const configDir = path.join(tempDir, 'cf');
  fs.mkdirSync(path.join(configDir, 'Ext'), { recursive: true });
  const binPath = path.join(configDir, 'Ext', 'ParentConfigurations.bin');
  if (bin && 'copyFrom' in bin) {
    fs.copyFileSync(bin.copyFrom, binPath);
  } else if (bin) {
    fs.writeFileSync(binPath, bin.text, 'utf-8');
  }
  return {
    tempDir,
    configDir,
    dispose(): void {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

suite('SupportImportGuard.mainConfigurationImportBlockReason (issue #19)', () => {
  for (const version of ['2.20', '2.21'] as const) {
    test(`example/${version}: на поддержке, флаг «изменения запрещены» = 0 → импорт не запрещается`, () => {
      assert.ok(fs.existsSync(path.join(EXAMPLE_CF_ROOTS[version], 'Ext', 'ParentConfigurations.bin')));

      assert.strictEqual(mainConfigurationImportBlockReason(EXAMPLE_CF_ROOTS[version]), undefined);
    });
  }

  test('флаг «изменения запрещены» = 1 (example/support/changes-forbidden) → запрет с причиной', () => {
    const layout = makeConfigDir({ copyFrom: CHANGES_FORBIDDEN_BIN_PATH });
    try {
      assert.strictEqual(mainConfigurationImportBlockReason(layout.configDir), FORBIDDEN_REASON);
    } finally {
      layout.dispose();
    }
  });

  test('без ParentConfigurations.bin → импорт не запрещается', () => {
    const layout = makeConfigDir(undefined);
    try {
      assert.strictEqual(mainConfigurationImportBlockReason(layout.configDir), undefined);
    } finally {
      layout.dispose();
    }
  });

  for (const malformed of MALFORMED_BIN_CASES) {
    test(`нераспознанный .bin (${malformed.label}) → запрет с причиной разбора`, () => {
      const layout = makeConfigDir({ text: malformed.text });
      try {
        assert.strictEqual(
          mainConfigurationImportBlockReason(layout.configDir),
          `ParentConfigurations.bin не распознан (${malformed.reason}), настройки поддержки не определены`
        );
      } finally {
        layout.dispose();
      }
    });
  }
});

/**
 * Команда проверяется до запуска Конфигуратора. Вместо платформы подставлен
 * исполняемый `1cv8`-скрипт, который записывает свои аргументы и завершается
 * с ошибкой: тесту нужно лишь знать, дошла ли команда до запуска, а настоящая
 * загрузка XML требует базы и платформы, которых в общем окружении тестов нет.
 * Скрипт — POSIX sh, поэтому на Windows эти тесты пропускаются.
 */
suite('import-configuration: проверка поддержки перед загрузкой (issue #19)', () => {
  async function withDesignerStub(
    bin: { copyFrom: string } | { text: string },
    run: (args: { configDir: string; designerArgsOf: () => string[] | undefined; baseArgs: Record<string, string> }) => Promise<void>
  ): Promise<void> {
    const layout = makeConfigDir(bin);
    const stubDir = path.join(layout.tempDir, 'platform');
    fs.mkdirSync(stubDir);
    const argsFile = path.join(layout.tempDir, 'designer-args.txt');
    const stubPath = path.join(stubDir, '1cv8');
    fs.writeFileSync(stubPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 1\n`, { mode: 0o755 });
    const baseArgs = {
      ProjectRoot: layout.tempDir,
      ConfigDir: layout.configDir,
      InfoBasePath: path.join(layout.tempDir, 'ib'),
      V8Path: stubPath,
    };
    const designerArgsOf = (): string[] | undefined =>
      fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf-8').split('\n').filter(Boolean) : undefined;
    try {
      await run({ configDir: layout.configDir, designerArgsOf, baseArgs });
    } finally {
      layout.dispose();
    }
  }

  setup(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  test('основная конфигурация, флаг = 1 → отказ до запуска Конфигуратора', async () => {
    await withDesignerStub({ copyFrom: CHANGES_FORBIDDEN_BIN_PATH }, async ({ designerArgsOf, baseArgs }) => {
      await assert.rejects(
        importConfiguration({ ...baseArgs, Target: 'cf' }),
        { message: `Обновление основной конфигурации запрещено: ${FORBIDDEN_REASON}` }
      );
      assert.strictEqual(designerArgsOf(), undefined, 'Конфигуратор не должен запускаться');
    });
  });

  test('основная конфигурация, нераспознанный .bin → отказ до запуска Конфигуратора', async () => {
    // Порча реального файла, а не произвольный мусор: ближе к тому, что может встретиться в выгрузке.
    const malformed = MALFORMED_BIN_CASES.find((item) => item.label.startsWith('неизвестное значение флага'));
    assert.ok(malformed);
    await withDesignerStub({ text: malformed.text }, async ({ designerArgsOf, baseArgs }) => {
      await assert.rejects(
        importConfiguration({ ...baseArgs, Target: 'cf' }),
        {
          message: 'Обновление основной конфигурации запрещено: ' +
            `ParentConfigurations.bin не распознан (${malformed.reason}), настройки поддержки не определены`,
        }
      );
      assert.strictEqual(designerArgsOf(), undefined);
    });
  });

  test('основная конфигурация, реальный .bin с флагом = 0 → загрузка передаётся Конфигуратору', async () => {
    const realBin = path.join(EXAMPLE_CF_ROOTS['2.21'], 'Ext', 'ParentConfigurations.bin');
    await withDesignerStub({ copyFrom: realBin }, async ({ configDir, designerArgsOf, baseArgs }) => {
      const exitCode = await importConfiguration({ ...baseArgs, Target: 'cf' });

      assert.strictEqual(exitCode, 1, 'код возврата — от заглушки Конфигуратора');
      const designerArgs = designerArgsOf();
      assert.ok(designerArgs, 'Конфигуратор должен запускаться');
      const loadAt = designerArgs.indexOf('/LoadConfigFromFiles');
      assert.deepStrictEqual(designerArgs.slice(loadAt, loadAt + 2), ['/LoadConfigFromFiles', configDir]);
    });
  });

  test('расширение не проверяется по поддержке основной конфигурации даже при флаге = 1', async () => {
    await withDesignerStub({ copyFrom: CHANGES_FORBIDDEN_BIN_PATH }, async ({ designerArgsOf, baseArgs }) => {
      const exitCode = await importConfiguration({ ...baseArgs, Target: 'cfe', Extension: 'EVOLC' });

      assert.strictEqual(exitCode, 1);
      assert.ok(designerArgsOf()?.includes('/LoadConfigFromFiles'), 'Конфигуратор должен запускаться');
    });
  });
});
