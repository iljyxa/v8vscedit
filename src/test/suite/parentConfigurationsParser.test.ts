/**
 * Разбор `Ext/ParentConfigurations.bin`. Формат (снят экспериментом на платформе 8.5.1):
 *
 *   {6,<изменения запрещены 1|0>,<число поставщиков>,<uuid>,<копия совпадает 1|0>,<uuid>,
 *    "<версия>","<поставщик>","<имя>",<число записей>, a,b,uuid,uuid, …, <хвост ~15 чисел>}
 *
 * где `a` — режим поддержки объекта (0 — не редактируется, 1 — редактируется с
 * сохранением поддержки, 2 — снят с поддержки), а запись — это четвёрка
 * `a,b,uuid,uuid` с ОДИНАКОВЫМИ uuid; пара РАЗНЫХ uuid записью не является.
 * Тексты построены по этому формату.
 */
import * as assert from 'assert';
import { parseParentConfigurations } from '../../infra/support/ParentConfigurationsParser';
import { MALFORMED_BIN_CASES } from './support/flatMetadataFixtures';

const VALID_BIN_TEXT =
  '{6,0,1,11111111-1111-1111-1111-111111111111,0,22222222-2222-2222-2222-222222222222,'
  + '"1.0.0.1","Vendor","Name",1,0,0,33333333-3333-3333-3333-333333333333,33333333-3333-3333-3333-333333333333,'
  + '0,0,1,0,0,0,1,0,1,0,1,1,1,1}';


suite('parseParentConfigurations', () => {
  test('корректный текст разбирается: флаг, число поставщиков, одна запись', () => {
    const result = parseParentConfigurations(VALID_BIN_TEXT);
    assert.strictEqual(result.ok, true, `ожидался успешный разбор: ${JSON.stringify(result)}`);
    assert.strictEqual(result.info.changesForbidden, false);
    assert.deepStrictEqual(result.info.records.map((r) => [r.code, r.uuid]), [[0, '33333333-3333-3333-3333-333333333333']]);
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
