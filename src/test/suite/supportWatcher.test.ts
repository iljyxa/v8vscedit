/**
 * Реакция на события `<корень>/Ext/ParentConfigurations.bin`: после правки файла
 * поддержки кэш `SupportInfoService` обязан перечитаться, а дерево —
 * перерисоваться, иначе индикатор поддержки (он строится из `contextValue` узлов)
 * показывает устаревший режим. Обработчики проверяются напрямую на реальной
 * выгрузке, без ожидания событий файловой системы: их доставка зависит от
 * платформенного watcher'а и дала бы недетерминированный тест.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import {
  createParentConfigurationsHandlers,
  registerSupportWatcher,
} from '../../ui/support/SupportWatcher';
import { buildSupportFixtureRoot, CHANGES_FORBIDDEN_BIN_PATH } from './support/realConfigFixtures';

class TestLogger implements Logger {
  appendLine(): void {
    // Лог сервиса поддержки тесту не нужен.
  }
}

function binPathOf(configRoot: string): string {
  return path.join(configRoot, 'Ext', 'ParentConfigurations.bin');
}

suite('SupportWatcher: реакция на ParentConfigurations.bin', () => {
  test('onChange перечитывает изменённый .bin и перерисовывает дерево', () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      let refreshes = 0;
      const handlers = createParentConfigurationsHandlers(supportService, () => { refreshes++; });
      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), false);

      fs.copyFileSync(CHANGES_FORBIDDEN_BIN_PATH, binPathOf(fixture.configRoot));
      handlers.onChange(vscode.Uri.file(binPathOf(fixture.configRoot)));

      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), true);
      assert.strictEqual(refreshes, 1);
    } finally {
      fixture.dispose();
    }
  });

  test('onChange на созданный .bin подключает данные поддержки корня', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const binPath = binPathOf(fixture.configRoot);
      const binContent = fs.readFileSync(binPath);
      fs.rmSync(binPath);
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      let refreshes = 0;
      const handlers = createParentConfigurationsHandlers(supportService, () => { refreshes++; });
      assert.strictEqual(supportService.hasConfigData(fixture.kontragentyXmlPath), false);

      fs.writeFileSync(binPath, binContent);
      handlers.onChange(vscode.Uri.file(binPath));

      assert.strictEqual(supportService.hasConfigData(fixture.kontragentyXmlPath), true);
      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), true);
      assert.strictEqual(refreshes, 1);
    } finally {
      fixture.dispose();
    }
  });

  test('onDelete сбрасывает данные поддержки корня и перерисовывает дерево', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      let refreshes = 0;
      const handlers = createParentConfigurationsHandlers(supportService, () => { refreshes++; });
      assert.strictEqual(supportService.hasConfigData(fixture.kontragentyXmlPath), true);

      fs.rmSync(binPathOf(fixture.configRoot));
      handlers.onDelete(vscode.Uri.file(binPathOf(fixture.configRoot)));

      assert.strictEqual(supportService.hasConfigData(fixture.kontragentyXmlPath), false);
      assert.strictEqual(supportService.hasChangesForbidden(fixture.kontragentyXmlPath), false);
      assert.strictEqual(refreshes, 1);
    } finally {
      fixture.dispose();
    }
  });

  test('registerSupportWatcher отдаёт watcher и подписки на его события в context.subscriptions', () => {
    const fixture = buildSupportFixtureRoot('normal');
    const subscriptions: vscode.Disposable[] = [];
    try {
      const workspaceFolder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(fixture.tempDir),
        name: path.basename(fixture.tempDir),
        index: 0,
      };
      // Из контекста расширения регистрации нужен только список подписок.
      const context = { subscriptions } as unknown as vscode.ExtensionContext;

      registerSupportWatcher(workspaceFolder, context, new SupportInfoService(new TestLogger()), () => undefined);

      // Три подписки (создание, изменение, удаление) и сам watcher: всё освобождается при деактивации.
      assert.strictEqual(subscriptions.length, 4);
      for (const subscription of subscriptions) {
        assert.strictEqual(typeof subscription.dispose, 'function');
      }
    } finally {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      fixture.dispose();
    }
  });
});
