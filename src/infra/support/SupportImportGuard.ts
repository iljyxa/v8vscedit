import * as fs from 'fs';
import * as path from 'path';
import { parseParentConfigurations } from './ParentConfigurationsParser';

/**
 * Причина, по которой загрузку XML в основную конфигурацию запрещают настройки
 * поддержки, или `undefined`, если загрузку можно передать платформе.
 *
 * Запрет — только при флаге «изменения запрещены» заголовка
 * `Ext/ParentConfigurations.bin`: без него платформа сама сверяет правила по
 * объектам (объект с кодом 0 отбивается, коды 1 и 2 загружаются), и отказ по
 * самому наличию файла не давал загрузить даже правку редактируемых объектов.
 * Нераспознанный файл — тоже запрет: разрешить загрузку, не поняв настройки
 * поддержки, опаснее, чем лишний раз отказать.
 */
export function mainConfigurationImportBlockReason(configDir: string): string | undefined {
  const binPath = path.join(configDir, 'Ext', 'ParentConfigurations.bin');
  if (!fs.existsSync(binPath)) {
    return undefined;
  }
  const parsed = parseParentConfigurations(fs.readFileSync(binPath, 'utf-8'));
  if (!parsed.ok) {
    return `ParentConfigurations.bin не распознан (${parsed.reason}), настройки поддержки не определены`;
  }
  return parsed.info.changesForbidden
    ? 'изменения конфигурации запрещены в настройках поддержки'
    : undefined;
}
