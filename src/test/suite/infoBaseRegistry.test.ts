import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InfoBaseRegistryService,
  parseCommonCfgPaths,
  parseCommonInfoBasePaths,
  parseV8iContent,
} from '../../infra/environment/InfoBaseRegistryService';

suite('InfoBaseRegistryService', () => {
  test('Читает файловую и серверную базу из v8i', () => {
    const bases = parseV8iContent(`
; комментарий перед первой секцией
[БезСоединения]
Connect=

[Разработка]
Connect=File="/Users/test/InfoBases/dev;archive";
ID=dev
OrderInList=20

[Тестовая]
Connect=Srvr="srv01";Ref="Demo_Test";
ID=test
OrderInList=10
`, '/tmp/ibases.v8i');

    assert.strictEqual(bases.length, 2);
    assert.strictEqual(bases[0].name, 'Разработка');
    assert.strictEqual(bases[0].kind, 'file');
    assert.strictEqual(bases[0].connection, '/F/Users/test/InfoBases/dev;archive');
    assert.strictEqual(bases[0].order, 20);
    assert.strictEqual(bases[1].kind, 'server');
    assert.strictEqual(bases[1].connection, '/Ssrv01/Demo_Test');
  });

  suite('Идентификатор базы', () => {
    const dev = '[Разработка]\nConnect=File="/Users/test/InfoBases/dev";\n';
    const test_ = '[Тестовая]\nConnect=Srvr="srv01";Ref="Demo_Test";\n';
    const other = '[Другая]\nConnect=File="/Users/test/InfoBases/other";\n';

    function idOf(content: string, name: string, sourcePath = '/tmp/ibases.v8i'): string {
      const base = parseV8iContent(content, sourcePath).find((item) => item.name === name);
      assert.ok(base, `база ${name} не разобрана`);
      return base.id;
    }

    test('Не меняется, когда лаунчер переставил секции или добавил базу выше', () => {
      // Лаунчер 1С перезаписывает ibases.v8i целиком, в другом порядке и с чужими базами.
      const before = dev + test_;
      const after = other + test_ + dev;

      assert.strictEqual(idOf(after, 'Разработка'), idOf(before, 'Разработка'));
      assert.strictEqual(idOf(after, 'Тестовая'), idOf(before, 'Тестовая'));
    });

    test('Не зависит от файла списка, в котором описана база', () => {
      assert.strictEqual(
        idOf(dev, 'Разработка', '/home/test/.1C/1cestart/ibases.v8i'),
        idOf(dev, 'Разработка', '/opt/1c/common.v8i')
      );
    });

    test('Различает базы с одной строкой подключения и разными именами', () => {
      const sameConnection = dev + '[Разработка копия]\nConnect=File="/Users/test/InfoBases/dev";\n';

      assert.notStrictEqual(idOf(sameConnection, 'Разработка'), idOf(sameConnection, 'Разработка копия'));
    });

    test('scan() схлопывает повторную секцию с тем же именем и подключением в одну базу', () => {
      // Одна и та же база иногда встречается в ibases.v8i дважды (лаунчер не чистит дубликаты) —
      // deduplicateBases должен оставить только первую по ключу имя+подключение.
      // Список пользователя scan() ищет в %APPDATA% на Windows и в домашнем каталоге на Unix —
      // подменяем переменную своей ОС, иначе тест читал бы реальный список баз машины.
      const envKey = process.platform === 'win32' ? 'APPDATA' : 'HOME';
      const listSubPath = process.platform === 'win32' ? ['1C', '1CEStart'] : ['.1C', '1cestart'];
      const previousValue = process.env[envKey];
      const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-ibase-home-'));
      const listDir = path.join(fakeRoot, ...listSubPath);
      fs.mkdirSync(listDir, { recursive: true });
      fs.writeFileSync(path.join(listDir, 'ibases.v8i'), dev + dev);
      process.env[envKey] = fakeRoot;

      try {
        const result = new InfoBaseRegistryService().scan();
        // Фильтр и по подключению: общий список машины (%ALLUSERSPROFILE%, /etc) тест не подменяет.
        const matches = result.bases.filter(
          (base) => base.name === 'Разработка' && base.connection === '/F/Users/test/InfoBases/dev'
        );
        assert.strictEqual(matches.length, 1);
      } finally {
        if (previousValue === undefined) {
          Reflect.deleteProperty(process.env, envKey);
        } else {
          process.env[envKey] = previousValue;
        }
        fs.rmSync(fakeRoot, { recursive: true, force: true });
      }
    });
  });

  test('Разбирает CommonInfoBases из 1cestart.cfg', () => {
    const cfgDir = path.join('/Users/test/.1C/1cestart');
    const cfgPath = path.join(cfgDir, '1cestart.cfg');
    const paths = parseCommonInfoBasePaths(
      'CommonInfoBases=shared.v8i,"/opt/1c/common bases.v8i"',
      cfgPath
    );

    // На Windows path.resolve добавит букву текущего диска к относительному пути;
    // сравниваем через тот же path.resolve, чтобы тест не зависел от ОС-хоста.
    assert.deepStrictEqual(paths, [
      path.resolve(cfgDir, 'shared.v8i'),
      '/opt/1c/common bases.v8i',
    ]);
  });

  test('Разбирает Windows-пути к общему cfg и общему списку баз', () => {
    const previousProgramData = process.env.ProgramData;
    process.env.ProgramData = String.raw`C:\ProgramData`;

    try {
      const cfgPath = String.raw`C:\ProgramData\1C\1CEStart\1cestart.cfg`;
      assert.deepStrictEqual(
        parseCommonCfgPaths(String.raw`CommonCfgLocation=common\1cescmn.cfg`, cfgPath),
        [String.raw`C:\ProgramData\1C\1CEStart\common\1cescmn.cfg`]
      );
      assert.deepStrictEqual(
        parseCommonInfoBasePaths(String.raw`CommonInfoBases=%programdata%\1C\bases\ibases.v8i,\\server\share\common.v8i`, cfgPath),
        [
          String.raw`C:\ProgramData\1C\bases\ibases.v8i`,
          String.raw`\\server\share\common.v8i`,
        ]
      );
    } finally {
      if (previousProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = previousProgramData;
      }
    }
  });
});
