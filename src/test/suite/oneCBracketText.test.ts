import * as assert from 'assert';
import { parseBracketText, type BracketNode } from '../../infra/repository/OneCBracketText';
import { readHttpExchange } from './support/repositoryLockFixtures';

/** Полезная нагрузка `crs:call_exception` из снятого ответа сервера: base64 → UTF-8 с BOM. */
function exceptionPayload(name: 'version-mismatch' | 'auth-failed'): string {
  const text = readHttpExchange('8.5.1', name).response.toString('utf-8');
  const base64 = /<crs:call_exception[^>]*>([^<]*)</.exec(text)?.[1] ?? '';
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function list(node: BracketNode | undefined): BracketNode[] {
  assert.ok(Array.isArray(node), `ожидался список, получено ${JSON.stringify(node)}`);
  return node;
}

suite('OneCBracketText — скобочный формат 1С', () => {
  test('реальная нагрузка исключения «несоответствие версий»: BOM снят, CRLF между элементами не мешает', () => {
    const payload = exceptionPayload('version-mismatch');
    assert.strictEqual(payload.charCodeAt(0), 0xfeff, 'фикстура должна начинаться с BOM');
    const [root] = parseBracketText(payload);
    const error = list(list(root)[0]);
    assert.strictEqual(error[0], '3ccb2518-9616-4445-aaa7-20048fead174');
    assert.match(String(error[1]), /^Несоответствие версий клиентского приложения/);
    const nested = list(list(error[2])[1]);
    assert.deepStrictEqual([nested[0], nested[1], nested[3]], ['9f06d311-1431-4a54-bd6f-fa93c4d4c471', '', '8.5.1.1529']);
    assert.strictEqual(list(root)[1], '17');
  });

  test('реальная нагрузка ошибки аутентификации: код и текст', () => {
    const [root] = parseBracketText(exceptionPayload('auth-failed'));
    assert.match(String(list(list(root)[0])[1]), /^Ошибка аутентификации в хранилище конфигурации!/);
    assert.strictEqual(list(root)[1], '4');
  });

  test('удвоенная кавычка внутри строки — одна кавычка; пустая строка сохраняется', () => {
    assert.deepStrictEqual(parseBracketText('{"a""b","",x}'), [['a"b', '', 'x']]);
  });

  test('несколько корней и вложенные пустые списки', () => {
    assert.deepStrictEqual(parseBracketText('{1,{}},{2}'), [['1', []], ['2']]);
  });

  const malformed: [string, string][] = [
    ['незакрытая скобка', '{1,{2}'],
    ['лишняя закрывающая скобка', '{1}}'],
    ['незакрытая строка', '{"abc}'],
  ];
  for (const [title, text] of malformed) {
    test(`ошибка разбора: ${title}`, () => {
      assert.throws(() => parseBracketText(text), /скобочн/);
    });
  }
});
