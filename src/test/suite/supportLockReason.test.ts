/**
 * Issue #22: разбор суффикса `contextValue` дерева в состояние
 * поддержки/подсказку вынесен в чистый модуль `ui/support/supportLockReason.ts`
 * (без vscode), чтобы одна и та же логика применялась и в
 * `MetadataTreeProvider.applySupportDecoration` (суффикс), и в
 * `UniversalPanelViewProvider.buildStateIcons` (иконка + подсказка) — вместо
 * двух независимых наборов `contextValue.includes('-support2')`.
 *
 * Issue #21 добавляет четвёртый режим (`SupportMode.Removed` → `-support3`,
 * иконка `support-removed`), запись суффикса (`supportModeSuffix`) и
 * DTO-представление режима для webview (`supportModeDtoOf`).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SupportMode } from '../../infra/support/SupportInfoService';
import {
  CHANGES_FORBIDDEN_REASON,
  CHANGES_FORBIDDEN_TITLE,
  SUPPORT_CHANGES_FORBIDDEN_SUFFIX,
  SUPPORT_REMOVED_TITLE,
  SUPPORT_SUFFIX_RE,
  supportIndicatorOf,
  supportModeSuffix,
  supportModeDtoOf,
  type SupportModeDto,
} from '../../ui/support/supportLockReason';

const EXTENSION_ROOT = path.resolve(__dirname, '../../../');

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

  test('SUPPORT_REMOVED_TITLE — буквальный текст подсказки режима Removed (issue #21)', () => {
    assert.strictEqual(SUPPORT_REMOVED_TITLE, 'Снят с поддержки: обновления поставщика на объект не придут');
  });
});

suite('supportLockReason — supportModeSuffix (issue #21)', () => {
  // Ожидания — буквальные строки: числа режимов заморожены, т.к. вшиты в contextValue.
  const cases: readonly { mode: SupportMode; label: string; expected: string }[] = [
    { mode: SupportMode.None, label: 'None', expected: '-support0' },
    { mode: SupportMode.Editable, label: 'Editable', expected: '-support1' },
    { mode: SupportMode.Locked, label: 'Locked', expected: '-support2' },
    { mode: SupportMode.Removed, label: 'Removed', expected: '-support3' },
  ];

  for (const { mode, label, expected } of cases) {
    test(`SupportMode.${label} → "${expected}"`, () => {
      assert.strictEqual(supportModeSuffix(mode), expected);
    });
  }
});

suite('supportLockReason — supportIndicatorOf', () => {
  interface Case {
    readonly label: string;
    readonly contextValue: string;
    readonly expected:
      | { icon: 'support-locked' | 'support-editable' | 'support-none' | 'support-removed'; title: string }
      | undefined;
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
    {
      label: '-support3 (issue #21, снят с поддержки)',
      contextValue: 'Catalog-hasXml-support3',
      expected: { icon: 'support-removed', title: SUPPORT_REMOVED_TITLE },
    },
    {
      label: '-support3 + суффиксы подключённого хранилища после него (issue #21)',
      contextValue: 'Catalog-hasXml-support3-repoConnected-repoUnlocked',
      expected: { icon: 'support-removed', title: SUPPORT_REMOVED_TITLE },
    },
  ];

  for (const { label, contextValue, expected } of cases) {
    test(`${label} → ${expected ? JSON.stringify(expected) : 'undefined'}`, () => {
      assert.deepStrictEqual(supportIndicatorOf(contextValue), expected);
    });
  }
});

suite('supportLockReason — supportModeDtoOf (issue #21)', () => {
  const cases: readonly { label: string; contextValue: string; expected: SupportModeDto }[] = [
    { label: 'пустая строка', contextValue: '', expected: 'none' },
    { label: 'без суффикса поддержки', contextValue: 'Catalog-hasXml', expected: 'none' },
    { label: '-support0', contextValue: 'Catalog-hasXml-support0', expected: 'none' },
    { label: '-support1', contextValue: 'Catalog-hasXml-support1', expected: 'editable' },
    { label: '-support2', contextValue: 'Catalog-hasXml-support2', expected: 'locked' },
    {
      label: '-support2 + маркер запрета изменений',
      contextValue: `Catalog-hasXml-support2${SUPPORT_CHANGES_FORBIDDEN_SUFFIX}`,
      expected: 'locked',
    },
    { label: '-support3', contextValue: 'Catalog-hasXml-support3', expected: 'removed' },
    {
      label: '-support3 + суффиксы подключённого хранилища',
      contextValue: 'Catalog-hasXml-support3-repoConnected',
      expected: 'removed',
    },
  ];

  for (const { label, contextValue, expected } of cases) {
    test(`${label} ("${contextValue}") → '${expected}'`, () => {
      assert.strictEqual(supportModeDtoOf(contextValue), expected);
    });
  }
});

suite('supportLockReason — SUPPORT_SUFFIX_RE снимает ВСЕ вхождения суффикса поддержки', () => {
  test('дублированный -support2 и маркер запрета изменений удаляются полностью', () => {
    const input = `Catalog-hasXml-support2-support2${SUPPORT_CHANGES_FORBIDDEN_SUFFIX}`;
    assert.strictEqual(input.replace(SUPPORT_SUFFIX_RE, ''), 'Catalog-hasXml');
  });

  test('дублированный -support3 (issue #21) удаляется полностью', () => {
    const input = 'Catalog-hasXml-support3-support3';
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

/**
 * Issue #21: `supportIndicatorOf` не может отдать иконку, которой нет на
 * диске — `UniversalPanelViewProvider.themeStateIcon` резолвит `<name>.svg` в
 * `src/icons/{light,dark}` (см. `src/ui/tree/presentation/icon.ts` для того же
 * приёма с `getIconUris`) без проверки существования файла, поэтому
 * отсутствующая иконка тихо превращается в пустую картинку в UI. Список
 * иконок задан по контракту, а не вычисляется вызовом `supportIndicatorOf`:
 * иначе потерянная ветка функции тихо убрала бы свою иконку из проверки.
 */
suite('supportLockReason — иконки индикатора существуют на диске (issue #21)', () => {
  const icons = ['support-none', 'support-editable', 'support-locked', 'support-removed'] as const;

  for (const icon of icons) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${theme}/${icon}.svg существует`, () => {
        const iconPath = path.join(EXTENSION_ROOT, 'src', 'icons', theme, `${icon}.svg`);
        assert.ok(fs.existsSync(iconPath), `Ожидался файл иконки: ${iconPath}`);
      });
    }
  }
});
