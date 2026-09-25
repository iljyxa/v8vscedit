/**
 * Issue #22: разбор суффикса `contextValue` дерева в состояние
 * поддержки/подсказку вынесен в чистый модуль `ui/support/supportLockReason.ts`
 * (без vscode), чтобы одна и та же логика применялась и в
 * `MetadataTreeProvider.applySupportDecoration` (суффикс), и в
 * `UniversalPanelViewProvider.buildStateIcons` (иконка + подсказка) — вместо
 * двух независимых наборов `contextValue.includes('-support2')`.
 *
 * Модуль ещё не существует — тест красный по отсутствующему экспорту.
 */
import * as assert from 'assert';
import {
  CHANGES_FORBIDDEN_REASON,
  CHANGES_FORBIDDEN_TITLE,
  SUPPORT_CHANGES_FORBIDDEN_SUFFIX,
  SUPPORT_SUFFIX_RE,
  supportIndicatorOf,
} from '../../ui/support/supportLockReason';

suite('supportLockReason — константы текста', () => {
  test('SUPPORT_CHANGES_FORBIDDEN_SUFFIX — суффикс contextValue маркера запрета изменений', () => {
    assert.strictEqual(SUPPORT_CHANGES_FORBIDDEN_SUFFIX, '-supportChangesForbidden');
  });

  test('CHANGES_FORBIDDEN_REASON — форма для встраивания в предложение («Добавление запрещено: …»)', () => {
    assert.strictEqual(CHANGES_FORBIDDEN_REASON, 'изменения конфигурации запрещены в настройках поддержки');
  });

  test('CHANGES_FORBIDDEN_TITLE — самостоятельная подсказка/сообщение с заглавной буквы', () => {
    assert.strictEqual(CHANGES_FORBIDDEN_TITLE, 'Изменения конфигурации запрещены в настройках поддержки');
  });
});

suite('supportLockReason — supportIndicatorOf', () => {
  interface Case {
    readonly label: string;
    readonly contextValue: string;
    readonly expected: { icon: 'support-locked' | 'support-editable' | 'support-none'; title: string } | undefined;
  }

  const cases: readonly Case[] = [
    { label: 'пустая строка', contextValue: '', expected: undefined },
    { label: 'contextValue без суффикса поддержки', contextValue: 'Catalog-hasXml', expected: undefined },
    {
      label: '-support0',
      contextValue: 'Catalog-hasXml-support0',
      expected: { icon: 'support-none', title: 'Не на поддержке' },
    },
    {
      label: '-support1',
      contextValue: 'Catalog-hasXml-support1',
      expected: { icon: 'support-editable', title: 'На поддержке, редактирование разрешено' },
    },
    {
      label: '-support2 (без запрета изменений)',
      contextValue: 'Catalog-hasXml-support2',
      expected: { icon: 'support-locked', title: 'На поддержке, редактирование запрещено' },
    },
    {
      label: '-support2 + маркер запрета изменений',
      contextValue: `Catalog-hasXml-support2${SUPPORT_CHANGES_FORBIDDEN_SUFFIX}`,
      expected: { icon: 'support-locked', title: CHANGES_FORBIDDEN_TITLE },
    },
    {
      label: 'маркер запрета изменений + суффиксы подключённого хранилища после него',
      contextValue: `Catalog-hasXml-support2${SUPPORT_CHANGES_FORBIDDEN_SUFFIX}-repoConnected-repoUnlocked`,
      expected: { icon: 'support-locked', title: CHANGES_FORBIDDEN_TITLE },
    },
  ];

  for (const { label, contextValue, expected } of cases) {
    test(`${label} → ${expected ? JSON.stringify(expected) : 'undefined'}`, () => {
      assert.deepStrictEqual(supportIndicatorOf(contextValue), expected);
    });
  }
});

suite('supportLockReason — SUPPORT_SUFFIX_RE снимает ВСЕ вхождения суффикса поддержки', () => {
  test('дублированный -support2 и маркер запрета изменений удаляются полностью', () => {
    const input = `Catalog-hasXml-support2-support2${SUPPORT_CHANGES_FORBIDDEN_SUFFIX}`;
    assert.strictEqual(input.replace(SUPPORT_SUFFIX_RE, ''), 'Catalog-hasXml');
  });

  test('регулярка помечена /g — повторное применение к разным строкам не зависит от lastIndex предыдущего вызова', () => {
    const withMarker = `Catalog-hasXml-support2${SUPPORT_CHANGES_FORBIDDEN_SUFFIX}`;
    const withoutMarker = 'Catalog-hasXml-support1';
    // Порядок вызовов важен: если бы состояние lastIndex общего регэкспа
    // протекало между вызовами (типичная ошибка с /g-регулярками, применяемыми
    // напрямую через .exec в цикле), второй replace на другой строке дал бы
    // неверный результат.
    assert.strictEqual(withMarker.replace(SUPPORT_SUFFIX_RE, ''), 'Catalog-hasXml');
    assert.strictEqual(withoutMarker.replace(SUPPORT_SUFFIX_RE, ''), 'Catalog-hasXml');
  });

  test('суффикс поддержки отсутствует — строка не меняется', () => {
    const input = 'Catalog-hasXml-canAdd';
    assert.strictEqual(input.replace(SUPPORT_SUFFIX_RE, ''), input);
  });
});
