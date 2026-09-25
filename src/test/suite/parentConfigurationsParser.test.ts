/**
 * Разбор `Ext/ParentConfigurations.bin`. Реальный формат (снят экспериментом,
 * см. шапку `example/tools/build-supported-cf.mjs`):
 *
 *   {6,<изменения запрещены 1|0>,<число поставщиков>,<uuid>,<копия совпадает 1|0>,<uuid>,
 *    "<версия>","<поставщик>","<имя>",<число записей>, a,b,uuid,uuid, …, <хвост ~15 чисел>}
 *
 * где `a` — режим поддержки объекта (0 — не редактируется, 1 — редактируется с
 * сохранением поддержки, 2 — снят с поддержки), а запись — это четвёрка
 * `a,b,uuid,uuid` с ОДИНАКОВЫМИ uuid; пара РАЗНЫХ uuid записью не является.
 *
 * Фикстуры реальные: `example/2.20/src/cf/Ext/ParentConfigurations.bin` и
 * `example/2.21/src/cf/Ext/ParentConfigurations.bin` (228 записей одной и той же
 * поставки, флаг запрета изменений = 0) и
 * `example/support/changes-forbidden/ParentConfigurations.bin` (та же поставка,
 * флаг = 1). Синтетические тексты — только там, где реальной фикстуры для
 * ветки нет (обрезанный/повреждённый заголовок, экранирование кавычек,
 * рассинхронизация заявленного и фактического числа записей) — построены по
 * тому же формату.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseParentConfigurations,
  type ParentConfigurationsRecord,
} from '../../infra/support/ParentConfigurationsParser';
import {
  EXAMPLE_CF_ROOTS,
  CHANGES_FORBIDDEN_BIN_PATH,
  MALFORMED_BIN_CASES,
  readRootUuid,
} from './support/realConfigFixtures';

/** Читает реальный `.bin` конфигурации как utf-8 (формат, который умеет разбирать сервис поддержки). */
function readBin(configRoot: string): string {
  return fs.readFileSync(path.join(configRoot, 'Ext', 'ParentConfigurations.bin'), 'utf-8');
}

function countByCode(records: readonly ParentConfigurationsRecord[]): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
  for (const r of records) {
    counts[r.code] = counts[r.code] + 1;
  }
  return counts;
}

const REAL_VERSIONS: ('2.20' | '2.21')[] = ['2.20', '2.21'];

suite('parseParentConfigurations', () => {
  suite('реальная фикстура (228 записей одной поставки)', () => {
    for (const version of REAL_VERSIONS) {
      test(`example/${version}/src/cf — флаг снят, 1 поставщик, 228 записей, коды 205/14/9`, () => {
        const configRoot = EXAMPLE_CF_ROOTS[version];
        const text = readBin(configRoot);
        const result = parseParentConfigurations(text);

        assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);

        assert.strictEqual(result.info.changesForbidden, false);
        assert.strictEqual(result.info.vendorCount, 1);
        assert.strictEqual(result.info.declaredRecordCount, 228);
        assert.strictEqual(result.info.records.length, 228);

        for (const r of result.info.records) {
          assert.ok([0, 1, 2].includes(r.code), `неожиданный код: ${String(r.code)}`);
        }
        assert.deepStrictEqual(countByCode(result.info.records), { 0: 205, 1: 14, 2: 9 });

        const configUuid = readRootUuid(path.join(configRoot, 'Configuration.xml'));
        const integrationServiceUuid = readRootUuid(
          path.join(configRoot, 'IntegrationServices', 'СервисИнтеграции1.xml')
        );
        const first = result.info.records[0];
        const last = result.info.records[result.info.records.length - 1];
        assert.strictEqual(first.uuid, configUuid, 'первая запись — корень конфигурации');
        assert.strictEqual(first.code, 1);
        assert.strictEqual(last.uuid, integrationServiceUuid, 'последняя запись перед хвостом — СервисИнтеграции1');
        assert.strictEqual(last.code, 0);
      });
    }
  });

  test('example/support/changes-forbidden — флаг запрета установлен, та же поставка', () => {
    const text = fs.readFileSync(CHANGES_FORBIDDEN_BIN_PATH, 'utf-8');
    const result = parseParentConfigurations(text);

    assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);

    assert.strictEqual(result.info.changesForbidden, true);
    assert.strictEqual(result.info.declaredRecordCount, 228);
    assert.strictEqual(result.info.records.length, 228);

    const configUuid = readRootUuid(path.join(EXAMPLE_CF_ROOTS['2.21'], 'Configuration.xml'));
    const kontragentyUuid = readRootUuid(path.join(EXAMPLE_CF_ROOTS['2.21'], 'Catalogs', 'Контрагенты.xml'));

    const first = result.info.records[0];
    assert.strictEqual(first.uuid, configUuid);
    assert.strictEqual(first.code, 1);

    const kontragentyRecord = result.info.records.find((r) => r.uuid === kontragentyUuid);
    assert.ok(kontragentyRecord, 'запись Контрагенты должна быть найдена');
    assert.strictEqual(kontragentyRecord.code, 2);
  });

  suite('BOM', () => {
    const withBomVariants: { label: string; bom: boolean }[] = [
      { label: 'с BOM (как в реальном файле)', bom: true },
      { label: 'без BOM', bom: false },
    ];

    for (const { label, bom } of withBomVariants) {
      test(`копия реального текста ${label} — тот же результат`, () => {
        const raw = readBin(EXAMPLE_CF_ROOTS['2.21']);
        const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        // BOM через String.fromCharCode — без литерального невидимого символа в исходнике.
        const text = bom ? String.fromCharCode(0xfeff) + withoutBom : withoutBom;

        const result = parseParentConfigurations(text);
        assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);
        assert.strictEqual(result.info.declaredRecordCount, 228);
        assert.strictEqual(result.info.records.length, 228);
      });
    }
  });

  test('CRLF и пробелы между токенами (производная копия реального текста) — тот же список записей', () => {
    const raw = readBin(EXAMPLE_CF_ROOTS['2.21']);
    const baseline = parseParentConfigurations(raw);
    assert.strictEqual(baseline.ok, true);

    // Ни один реальный токен (числа, uuid, кавычки версии/поставщика/имени) не
    // содержит запятую — раздувание разделителей пробелами/CRLF безопасно и
    // имитирует «красиво отформатированный» вручную .bin.
    const spaced = raw.replace(/,/g, ',\r\n  ');
    const result = parseParentConfigurations(spaced);

    assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);
    assert.strictEqual(result.info.declaredRecordCount, baseline.info.declaredRecordCount);
    assert.deepStrictEqual(result.info.records, baseline.info.records);
  });

  suite('нераспознанный формат', () => {
    for (const { label, text, reason } of MALFORMED_BIN_CASES) {
      test(label, () => {
        const result = parseParentConfigurations(text);
        assert.strictEqual(result.ok, false, `ожидалась ошибка разбора для случая «${label}»`);
        assert.strictEqual(result.reason, reason);
      });
    }
  });

  test('uuid в верхнем регистре нормализуется к нижнему', () => {
    const uuidUpper = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    const text =
      `{6,0,1,11111111-1111-1111-1111-111111111111,0,22222222-2222-2222-2222-222222222222,` +
      `"1.0.0.1","Vendor","Name",1,1,0,${uuidUpper},${uuidUpper},0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;

    const result = parseParentConfigurations(text);
    assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);
    assert.strictEqual(result.info.records.length, 1);
    assert.strictEqual(result.info.records[0].uuid, uuidUpper.toLowerCase());
    assert.strictEqual(result.info.records[0].code, 1);
  });

  test('пара uuid в разном регистре (lower, UPPER) — та же запись, сравнение регистронезависимо', () => {
    const uuidLower = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const uuidUpper = uuidLower.toUpperCase();
    const text =
      `{6,0,1,11111111-1111-1111-1111-111111111111,0,22222222-2222-2222-2222-222222222222,` +
      `"1.0.0.1","Vendor","Name",1,1,0,${uuidLower},${uuidUpper},0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;

    const result = parseParentConfigurations(text);
    assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);
    assert.strictEqual(result.info.records.length, 1);
    assert.strictEqual(result.info.records[0].uuid, uuidLower);
    assert.strictEqual(result.info.records[0].code, 1);
  });

  test('пара РАЗНЫХ uuid записью не является — считается только реальная запись', () => {
    const uuidA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const uuidC = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const uuidD = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    // Заявлено 1 запись — если бы декой (0,0,uuidC,uuidD) засчитался, число
    // найденных записей разошлось бы с заявленным без причины.
    const text =
      `{6,0,1,11111111-1111-1111-1111-111111111111,0,22222222-2222-2222-2222-222222222222,` +
      `"1.0.0.1","Vendor","Name",1,1,0,${uuidA},${uuidA},0,0,${uuidC},${uuidD},0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;

    const result = parseParentConfigurations(text);
    assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);
    assert.strictEqual(result.info.records.length, 1);
    assert.strictEqual(result.info.records[0].uuid, uuidA);
    assert.strictEqual(result.info.declaredRecordCount, 1);
  });

  test('заявлено больше записей, чем фактически найдено — declaredRecordCount из заголовка, records — найденные', () => {
    const uuidA = 'aaaaaaaa-1111-1111-1111-111111111111';
    const uuidB = 'bbbbbbbb-2222-2222-2222-222222222222';
    const text =
      `{6,0,1,11111111-1111-1111-1111-111111111111,0,22222222-2222-2222-2222-222222222222,` +
      `"1.0.0.1","Vendor","Name",3,1,0,${uuidA},${uuidA},0,0,${uuidB},${uuidB},0,0,1,0,0,0,1,0,1,0,1,1,1,1}`;

    const result = parseParentConfigurations(text);
    assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);
    assert.strictEqual(result.info.declaredRecordCount, 3);
    assert.strictEqual(result.info.records.length, 2);
  });

  test('строки заголовка с экранированием "" (и запятой внутри кавычек) разбираются корректно', () => {
    const uuidA = 'aaaaaaaa-1111-1111-1111-111111111111';
    // Экранирование "" внутри кавычек и запятая внутри значения — как в CSV;
    // наивный split(',') сломал бы разбор заголовка.
    const text =
      `{6,0,1,11111111-1111-1111-1111-111111111111,0,22222222-2222-2222-2222-222222222222,` +
      `"1.0.0.1","ООО ""Ромашка, и Ко""","Имя ""Тест""",1,1,0,${uuidA},${uuidA},0,0,1,0}`;

    const result = parseParentConfigurations(text);
    assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);
    assert.strictEqual(result.info.declaredRecordCount, 1);
    assert.strictEqual(result.info.records.length, 1);
    assert.strictEqual(result.info.records[0].uuid, uuidA);
    assert.strictEqual(result.info.records[0].code, 1);
  });
});
