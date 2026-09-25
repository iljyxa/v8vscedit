import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_LINE_DIFF_EDIT_DISTANCE, preserveBomAndEol } from '../../infra/xml/LineEndings';
import { hasRealChange, writeTextFilePreservingBomAndEol } from '../../infra/xml/XmlUtils';

/**
 * Юнит-тесты `preserveBomAndEol`/`MAX_LINE_DIFF_EDIT_DISTANCE` (LineEndings.ts): построчное
 * сохранение BOM и EOL неизменённых строк при перезаписи текста и выбор EOL для новых строк
 * (наследование от замещённой строки, стиль заполнения ханка, преобладающий стиль файла).
 * Идемпотентность проверяется на реальных выгрузках example/ со смешанным EOL.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example');

interface MixedEolFixture {
  readonly version: '2.20' | '2.21';
  readonly relPath: string;
}

/** Те же 6 реальных фикстур со смешанным EOL, что и в dataCompositionSchemaMixedEol.test.ts. */
const MIXED_EOL_FIXTURES: readonly MixedEolFixture[] = [
  { version: '2.20', relPath: 'Reports/Пользователи/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml' },
  { version: '2.20', relPath: 'Reports/ПраваДоступа/Templates/МакетПараметров/Ext/Template.xml' },
  { version: '2.20', relPath: 'Reports/Запасы/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml' },
  { version: '2.21', relPath: 'Reports/Пользователи/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml' },
  { version: '2.21', relPath: 'Reports/ПраваДоступа/Templates/МакетПараметров/Ext/Template.xml' },
  { version: '2.21', relPath: 'Reports/Запасы/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml' },
];

function readFixture(fx: MixedEolFixture): string {
  return fs.readFileSync(path.join(EXAMPLE_ROOT, fx.version, 'src', 'cf', fx.relPath), 'utf-8');
}

suite('LineEndings.preserveBomAndEol — построчное сохранение BOM и EOL', () => {
  test('next === original -> возвращается original без построчного анализа', () => {
    const original = 'A\r\nB\nC';
    assert.strictEqual(preserveBomAndEol(original, original), original);
  });

  suite('идемпотентность: normalized-EOL/no-BOM копии реального содержимого возвращают исходный текст байт-в-байт', () => {
    const cases: { readonly label: string; readonly original: string }[] = [
      ...MIXED_EOL_FIXTURES.map((fx) => ({ label: `${fx.version}/${fx.relPath}`, original: readFixture(fx) })),
      {
        label: 'example/2.21/src/cf/Configuration.xml (чистый CRLF, без единой голой LF)',
        original: fs.readFileSync(path.join(EXAMPLE_ROOT, '2.21', 'src', 'cf', 'Configuration.xml'), 'utf-8'),
      },
      { label: 'синтетический чистый LF-файл', original: 'line1\nline2\nline3\n' },
    ];

    for (const { label, original } of cases) {
      test(`${label}: n ∈ {все EOL→LF, все EOL→CRLF, без BOM} — preserveBomAndEol(o,n) === o и hasRealChange(o,n) === false`, () => {
        const normalizedLf = original.replace(/\r\n|\n/g, '\n');
        const asCrlf = normalizedLf.replace(/\n/g, '\r\n');
        const withoutBom = original.charCodeAt(0) === 0xfeff ? original.slice(1) : original;

        for (const next of [normalizedLf, asCrlf, withoutBom]) {
          assert.strictEqual(hasRealChange(original, next), false, 'hasRealChange обязан считать чисто-EOL/BOM отличие "не реальным изменением"');
          assert.strictEqual(preserveBomAndEol(original, next), original);
        }
      });
    }
  });

  suite('пустой original и пустой next', () => {
    test("original='' , next='\\r\\n' -> результат '\\n' (преобладающий стиль original без единого EOL — '\\n')", () => {
      assert.strictEqual(preserveBomAndEol('', '\r\n'), '\n');
    });

    test("original='' , next='\\r' (одиночный CR — тоже разделитель строк) -> результат '\\n'", () => {
      assert.strictEqual(preserveBomAndEol('', '\r'), '\n');
    });

    test("original непустой без BOM, next='' -> результат '' (удаление всего текста, BOM взять неоткуда)", () => {
      assert.strictEqual(preserveBomAndEol('abc\r\n', ''), '');
    });

    test("original с BOM, next='' -> результат состоит из одного BOM (BOM сохраняется даже при полном удалении текста)", () => {
      assert.strictEqual(preserveBomAndEol('\ufeffabc\r\n', ''), '\ufeff');
    });
  });

  suite('BOM — ровно один в результате, если он был хотя бы в одном из аргументов', () => {
    test('без BOM в обоих аргументах -> без BOM в результате', () => {
      assert.strictEqual(preserveBomAndEol('x\r\n', 'y\r\n'), 'y\r\n');
    });

    test('BOM только в original -> BOM переносится в результат', () => {
      assert.strictEqual(preserveBomAndEol('\ufeffx\r\n', 'y\r\n'), '\ufeffy\r\n');
    });

    test('BOM только в next -> BOM переносится в результат', () => {
      assert.strictEqual(preserveBomAndEol('x\r\n', '\ufeffy\r\n'), '\ufeffy\r\n');
    });

    test('BOM в обоих аргументах -> в результате ровно один BOM, а не два подряд', () => {
      const result = preserveBomAndEol('\ufeffx\r\n', '\ufeffy\r\n');
      assert.strictEqual(result, '\ufeffy\r\n');
      assert.strictEqual(result.indexOf('\ufeff'), result.lastIndexOf('\ufeff'), 'символ BOM должен встречаться ровно один раз');
    });
  });

  suite('завершающий EOL результата определяется наличием терминатора у next', () => {
    test('у next нет завершающего EOL — в выходе его нет, даже если у original он был', () => {
      assert.strictEqual(preserveBomAndEol('a\r\nb\r\n', 'a\r\nb'), 'a\r\nb');
    });

    test('у next есть завершающий EOL, а последняя строка original была без EOL -> стиль заполнения ханка = EOL строки перед ней (CRLF)', () => {
      assert.strictEqual(preserveBomAndEol('a\r\nb', 'a\r\nb\r\n'), 'a\r\nb\r\n');
    });

    test('у next есть завершающий EOL, а последняя строка original была без EOL -> стиль заполнения ханка = EOL строки перед ней (LF)', () => {
      assert.strictEqual(preserveBomAndEol('a\nb', 'a\nb\n'), 'a\nb\n');
    });

    test('у next есть завершающий EOL, последняя строка original была БЕЗ EOL и одновременно единственной (нет строки "перед ней") -> преобладающий стиль original (\'\\n\', т.к. в original не было ни одного EOL)', () => {
      assert.strictEqual(preserveBomAndEol('b', 'b\r\n'), 'b\n');
    });
  });

  test('k === m: позиционная замена — i-я строка нового ханка получает EOL i-й строки original той же позиции, а не буквальный (наивный) EOL из next', () => {
    // Мутатор-генератор склеивает результат "голыми" \n (типичное поведение insertBeforeClose/
    // replaceOrInsert в DataCompositionSchemaService) — вторая строка обязана получить CRLF
    // от original, хотя в сыром next она склеена через \n.
    const original = 'X\nY\r\nZ\n';
    const next = 'Xmod\nYmod\nZ\n';
    assert.strictEqual(preserveBomAndEol(original, next), 'Xmod\nYmod\r\nZ\n');
  });

  suite('k ≠ m: последняя строка ханка vs "внутренние" строки (стиль заполнения)', () => {
    test('внутренние строки: большинство LF среди заменяемых (кроме последней) -> LF; последняя строка ханка берёт EOL последней замещённой (CRLF)', () => {
      const original = 'H1\r\nA\nB\nC\r\nF1\r\n';
      const next = 'H1\r\nX\nY\nZ\nW\nF1\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'H1\r\nX\nY\nZ\nW\r\nF1\r\n');
    });

    test('внутренние строки: большинство CRLF среди заменяемых (кроме последней) -> CRLF; последняя строка ханка берёт EOL последней замещённой (LF)', () => {
      const original = 'H1\r\nA\r\nB\r\nC\nF1\r\n';
      const next = 'H1\r\nX\nY\nZ\nW\nF1\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'H1\r\nX\r\nY\r\nZ\r\nW\nF1\r\n');
    });

    test('внутренние строки: ничья CRLF/LF среди заменяемых -> EOL строки ПЕРЕД ханком (LF), а не преобладающий стиль original (CRLF)', () => {
      // original в целом CRLF-доминантный (P1,P2,A,C,F1 — CRLF; H1,B — LF), но строка НЕПОСРЕДСТВЕННО
      // перед ханком (H1) — LF: правило обязано использовать именно её, а не общий преобладающий стиль.
      const original = 'P1\r\nP2\r\nH1\nA\r\nB\nC\r\nF1\r\n';
      const next = 'P1\r\nP2\r\nH1\nX\nY\nZ\nW\nF1\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'P1\r\nP2\r\nH1\nX\nY\nZ\nW\r\nF1\r\n');
    });

    test('k = 1: пустой набор "внутренних" замещённых строк -> стиль заполнения = EOL строки перед ханком (CRLF); последняя строка ханка берёт EOL единственной замещённой (LF)', () => {
      const original = 'H1\r\nA\nF1\r\n';
      const next = 'H1\r\nX\nY\nF1\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'H1\r\nX\r\nY\nF1\r\n');
    });

    test('ханк в самом начале файла (нет строки перед ним, k = 1) -> стиль заполнения = преобладающий стиль original (CRLF)', () => {
      const original = 'A\nB\r\nC\r\nD\r\n';
      const next = 'X\nY\nB\r\nC\r\nD\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'X\r\nY\nB\r\nC\r\nD\r\n');
    });
  });

  suite('чистая вставка (k = 0) — стиль заполнения применяется ко ВСЕМ новым строкам ханка', () => {
    test('вставка после LF-строки -> LF', () => {
      const original = 'A\nB\r\n';
      const next = 'A\nNEW\nB\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'A\nNEW\nB\r\n');
    });

    test('вставка после CRLF-строки -> CRLF, даже если сырой next использует "\\n"', () => {
      const original = 'A\r\nB\n';
      const next = 'A\r\nNEW\nB\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'A\r\nNEW\r\nB\n');
    });

    test('вставка в самое начало файла (нет строки перед ней) -> преобладающий стиль original (CRLF)', () => {
      const original = 'A\r\nB\r\nC\n';
      const next = 'NEW\nA\r\nB\r\nC\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'NEW\r\nA\r\nB\r\nC\n');
    });

    test('вставка после строки, которая была последней БЕЗ EOL (правило "eol строки перед ханком, если он непустой" не применяется — там пусто) -> преобладающий стиль original (CRLF)', () => {
      // B — последняя строка original без EOL. Z (перед ней) выбрана СОВПАДАЮЩЕЙ с преобладающим
      // стилем (CRLF) намеренно: это делает исход теста однозначным независимо от того, трактуется ли
      // переприсвоение EOL самой строке B как заимствование у Z или как отдельный откат к преобладающему
      // стилю — оба толкования при таком выборе фикстуры сходятся к одному и тому же байту.
      const original = 'A\r\nZ\r\nB';
      const next = 'A\r\nZ\r\nB\nNEW';
      assert.strictEqual(preserveBomAndEol(original, next), 'A\r\nZ\r\nB\r\nNEW');
    });
  });

  test('удаление (m = 0): удалённая строка не порождает вывода, соседние неизменённые строки сохраняют собственный EOL', () => {
    const original = 'A\r\nB\r\nC\r\n';
    const next = 'A\r\nC\r\n';
    assert.strictEqual(preserveBomAndEol(original, next), 'A\r\nC\r\n');
  });

  suite('преобладающий стиль original — параметризация по составу EOL', () => {
    test('CRLF > LF -> CRLF', () => {
      const original = 'A\r\nB\r\nC\n';
      const next = 'NEW\nA\r\nB\r\nC\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'NEW\r\nA\r\nB\r\nC\n');
    });

    test('LF > CRLF -> LF', () => {
      const original = 'A\nB\nC\r\n';
      const next = 'NEW\r\nA\nB\nC\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'NEW\nA\nB\nC\r\n');
    });

    test('поровну CRLF и LF -> CRLF (правило "≥")', () => {
      const original = 'A\r\nB\n';
      const next = 'NEW\nA\r\nB\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'NEW\r\nA\r\nB\n');
    });

    test('EOL в original нет вовсе -> \'\\n\'', () => {
      const original = 'A';
      const next = 'NEW\r\nA';
      assert.strictEqual(preserveBomAndEol(original, next), 'NEW\nA');
    });
  });

  suite('одиночный \\r: разделитель строк, не участвует в голосовании за преобладающий стиль', () => {
    test('одиночный \\r у НЕИЗМЕНЁННОЙ строки сохраняется байт-в-байт', () => {
      const original = 'A\rB\r\n';
      const next = 'A\rBmod\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'A\rBmod\r\n');
    });

    // Одиночный \r как кандидат стиля заполнения («EOL строки перед ханком») приравнивается
    // к пустому и отбрасывается, как и при голосовании за преобладающий стиль: расчёт
    // проваливается дальше — к преобладающему стилю original (CRLF).
    test('одиночный \\r строки ПЕРЕД ханком не используется как стиль заполнения для НОВОЙ строки — используется преобладающий стиль (CRLF)', () => {
      const original = 'H\rA\r\n';
      const next = 'H\rNEW\nA\r\n';
      assert.strictEqual(preserveBomAndEol(original, next), 'H\rNEW\r\nA\r\n');
    });

    test('позиционная замена (k === m) наследует EOL замещённой строки буквально, включая одиночный \\r', () => {
      assert.strictEqual(preserveBomAndEol('A\rB\r\n', 'X\nB\r\n'), 'X\rB\r\n');
    });
  });

  test('два разделённых ханка с неизменённым СМЕШАННЫМ участком между ними: участок сохранён байт-в-байт построчно (доказывает работу полного Myers-диффа, а не только общего префикса/суффикса)', () => {
    // Если бы реализация ограничивалась только общим префиксом/суффиксом всего документа (без
    // построчного Myers на среднем участке), она свернула бы ВЕСЬ средний блок (A2..C2) в один
    // ханк k=7,m=8 и присвоила бы A3/B1/B2/B3/C1/C2mod1 единый стиль заполнения по большинству
    // среди 6 "внутренних" строк (CRLF=3,LF=3 — ничья) => EOL строки перед ханком (A1, CRLF) —
    // то есть B1 и B3 ошибочно получили бы CRLF вместо собственного LF. Корректный построчный
    // Myers-дифф обязан распознать A3,B1,B2,B3,C1 как СОВПАДАЮЩИЕ строки вне какого-либо ханка.
    const original = 'A1\r\nA2\nA3\r\nB1\nB2\r\nB3\nC1\r\nC2\nC3\r\n';
    const next = 'A1\nA2mod\nA3\nB1\nB2\nB3\nC1\nC2mod1\nC2mod2\nC3\n';
    const expected = 'A1\r\nA2mod\nA3\r\nB1\nB2\r\nB3\nC1\r\nC2mod1\r\nC2mod2\nC3\r\n';
    assert.strictEqual(preserveBomAndEol(original, next), expected);
  });

  suite('переполнение MAX_LINE_DIFF_EDIT_DISTANCE: при D > порога средний участок сворачивается в ОДИН ханк', function () {
    this.timeout(20_000);

    /**
     * Строит original/next с общими HEADER/FOOTER (общий префикс/суффикс всего документа),
     * между которыми лежит СОВПАДАЮЩАЯ LF-строка 'Q', окружённая заведомо РАЗЛИЧНЫМИ (без
     * пересечения словаря) CRLF-строками с обеих сторон. next специально получает на одну
     * "хвостовую" строку больше — гарантирует k !== m у итогового ханка среднего участка.
     */
    function buildOverflowCase(distinctLinesEachSide: number): { readonly original: string; readonly next: string } {
      const origBefore = Array.from({ length: distinctLinesEachSide }, (_, i) => `O${String(i)}\r\n`).join('');
      const origAfter = Array.from({ length: distinctLinesEachSide }, (_, i) => `P${String(i)}\r\n`).join('');
      const nextBefore = Array.from({ length: distinctLinesEachSide }, (_, i) => `X${String(i)}\n`).join('');
      const nextAfter = Array.from({ length: distinctLinesEachSide + 1 }, (_, i) => `Y${String(i)}\n`).join('');
      return {
        original: `HEADER\r\n${origBefore}Q\n${origAfter}FOOTER\r\n`,
        next: `HEADER\r\n${nextBefore}Q\n${nextAfter}FOOTER\r\n`,
      };
    }

    test(`D > MAX_LINE_DIFF_EDIT_DISTANCE (${String(MAX_LINE_DIFF_EDIT_DISTANCE)} + 100 различающихся строк с каждой стороны): совпадающая строка 'Q' НЕ находится точным диффом — получает стиль заполнения ханка (CRLF, большинство среди CRLF-строк среднего участка)`, () => {
      const { original, next } = buildOverflowCase(MAX_LINE_DIFF_EDIT_DISTANCE + 100);
      const result = preserveBomAndEol(original, next);
      const qIndex = result.indexOf('Q');
      assert.notStrictEqual(qIndex, -1, "строка 'Q' обязана присутствовать в результате");
      assert.strictEqual(result.slice(qIndex, qIndex + 3), 'Q\r\n', "при переполнении порога 'Q' должна получить CRLF (стиль заполнения), а не собственный LF");
    });

    test("контроль на значительно меньшем входе (5 различающихся строк с каждой стороны, D « порога): точный Myers находит 'Q' как совпадающую строку и сохраняет её собственный LF", () => {
      const { original, next } = buildOverflowCase(5);
      const result = preserveBomAndEol(original, next);
      const qIndex = result.indexOf('Q');
      assert.notStrictEqual(qIndex, -1, "строка 'Q' обязана присутствовать в результате");
      assert.strictEqual(result.slice(qIndex, qIndex + 2), 'Q\n', "на малом входе 'Q' обязана сохранить собственный EOL — LF");
    });
  });

  test('100 000 CRLF-строк с двумя удалёнными друг от друга правками (вставка в начале, правка в конце) — верный результат в штатный таймаут mocha, без переполнения O(k·m)', () => {
    const totalLines = 100_000;
    const originalLines = Array.from({ length: totalLines }, (_, i) => `Line${String(i + 1)}`);
    const original = originalLines.map((line) => `${line}\r\n`).join('');

    const nextLines = ['NEWHEADER1', 'NEWHEADER2', ...originalLines.slice(0, totalLines - 1), 'LastEdited'];
    const next = `${nextLines.join('\n')}\n`;

    const expected =
      'NEWHEADER1\r\nNEWHEADER2\r\n'
      + originalLines.slice(0, totalLines - 1).map((line) => `${line}\r\n`).join('')
      + 'LastEdited\r\n';

    assert.strictEqual(preserveBomAndEol(original, next), expected);
  });

  test('writeTextFilePreservingBomAndEol пишет на диск ПОБАЙТНО то же, что возвращает preserveBomAndEol(original, next), включая физические байты BOM EF BB BF', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-line-endings-write-'));
    const filePath = path.join(root, 'test.xml');
    // BOM + CRLF-файл с одной голой LF-строкой внутри (форма реальных СКД-выгрузок 1С).
    const original = '\ufeff<a>\r\n\tтекст\n</a>\r\n';
    const next = '<a>\r\n\tтекст2\n</a>\r\n';
    fs.writeFileSync(filePath, original, 'utf-8');

    writeTextFilePreservingBomAndEol(filePath, original, next);

    const expected = preserveBomAndEol(original, next);
    const onDisk = fs.readFileSync(filePath);
    assert.deepStrictEqual(onDisk, Buffer.from(expected, 'utf-8'));
    assert.deepStrictEqual(onDisk.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), 'BOM должен физически присутствовать как байты EF BB BF');
  });
});
