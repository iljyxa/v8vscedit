import * as assert from 'assert';

/**
 * Точечные текстовые правки КОПИИ реального `ConfigDumpInfo.xml`/`Configuration.xml`
 * (issue #1, раздел 10) — общий хелпер для `repositoryLockSync.test.ts`,
 * `repositoryLockSyncRealFixtureFlow.test.ts` и `repositoryUnlockSync.test.ts`.
 * Никогда не собирает XML/ConfigDumpInfo с нуля: только правит значения атрибутов
 * или удаляет целые строки реальных записей — правило «только реальные фикстуры»
 * (CLAUDE.md, TDD п.3) требует, чтобы состав объектов оставался настоящим.
 */

/** Экранирование значения для использования внутри regex. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Точечная текстовая правка значения атрибута `configVersion` в КОПИИ реального ConfigDumpInfo.xml. */
export function bumpConfigDumpInfoVersion(xml: string, metadataName: string, newVersion: string): string {
  const pattern = new RegExp(`(<Metadata name="${escapeRegExp(metadataName)}"[^>]*configVersion=")[^"]*(")`);
  const replaced = xml.replace(pattern, `$1${newVersion}$2`);
  assert.notStrictEqual(replaced, xml, `запись "${metadataName}" обязана существовать в исходном ConfigDumpInfo.xml фикстуры.`);
  return replaced;
}

/** Точечное удаление ЦЕЛОЙ строки `<Metadata .../>` (единица исчезла из версии хранилища). */
export function removeConfigDumpInfoEntry(xml: string, metadataName: string): string {
  const pattern = new RegExp(`[ \\t]*<Metadata name="${escapeRegExp(metadataName)}"[^/]*/>\\r?\\n?`);
  const replaced = xml.replace(pattern, '');
  assert.notStrictEqual(replaced, xml, `запись "${metadataName}" обязана существовать в исходном ConfigDumpInfo.xml фикстуры.`);
  return replaced;
}

/**
 * Точечное удаление ЦЕЛОЙ строки `<Тег>Имя</Тег>` из `<ChildObjects>` `Configuration.xml`
 * (реальный владелец «исчезает» из проекта, оставаясь при этом в версии хранилища —
 * сценарий «добавленный владелец» root-incremental получения).
 */
export function removeChildObjectEntry(xml: string, tag: string, name: string): string {
  const pattern = new RegExp(`[ \\t]*<${tag}>${escapeRegExp(name)}</${tag}>\\r?\\n?`);
  const replaced = xml.replace(pattern, '');
  assert.notStrictEqual(replaced, xml, `запись "<${tag}>${name}</${tag}>" обязана существовать в исходном Configuration.xml фикстуры.`);
  return replaced;
}

/**
 * Правка ВСЕХ значений `configVersion` в копии реального `ConfigDumpInfo.xml` —
 * для сценария «доля изменённых владельцев выше порога»: реверс шестнадцатеричной
 * строки гарантированно даёт другое значение (палиндром длиной 40 практически
 * невозможен для хеша), при этом имена и структура файла остаются настоящими.
 */
function reverseAsciiHex(value: string): string {
  // Значения configVersion — hex-хеши (только ASCII), побайтовый reverse безопасен
  // и не требует locale-aware разбиения строки (правило no-misused-spread).
  let reversed = '';
  for (let i = value.length - 1; i >= 0; i -= 1) {
    reversed += value[i];
  }
  return reversed;
}

export function bumpAllConfigDumpInfoVersions(xml: string): string {
  const replaced = xml.replace(/(configVersion=")([^"]*)(")/g, (_match, prefix: string, value: string, suffix: string) =>
    `${prefix}${reverseAsciiHex(value)}${suffix}`);
  assert.notStrictEqual(replaced, xml, 'исходный ConfigDumpInfo.xml фикстуры обязан содержать хотя бы одну запись с configVersion.');
  return replaced;
}
