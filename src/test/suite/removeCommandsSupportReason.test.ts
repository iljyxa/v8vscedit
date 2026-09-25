/**
 * Issue #35: UI-удаление (`removeMetadata`, `removeForm`) при флаге «изменения
 * запрещены» в `Ext/ParentConfigurations.bin` обязано называть причину
 * «изменения конфигурации запрещены в настройках поддержки», а не «объект
 * находится на поддержке»: при флаге `Locked` получает и объект вне поставки
 * (Контрагенты, код 2), и прежний текст отправлял пользователя снимать объект
 * с поддержки. Без флага текст отказа прежний байт в байт.
 *
 * Команды вызываются напрямую, а не через `executeCommand`: их id уже
 * зарегистрированы активным расширением тестового хоста с его собственными
 * сервисами, а тесту нужны сервисы поверх временной выгрузки.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import { RepositoryService } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { CommandServices } from '../../ui/commands/_shared';
import { removeForm } from '../../ui/commands/form/FormToolsCommands';
import { removeMetadata } from '../../ui/commands/metadata/RemoveMetadataCommand';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { buildSupportFixtureRoot, type SupportFixtureRoot } from './support/realConfigFixtures';

const FORBIDDEN_TEXT = 'Удаление запрещено: изменения конфигурации запрещены в настройках поддержки.';
const OBJECT_LOCKED_TEXT = 'Удаление запрещено: объект находится на поддержке с запретом редактирования.';

class TestLogger implements Logger {
  appendLine(): void {
    // Лог сервиса поддержки тесту не нужен.
  }
}

/** Фейковый SecretStore на Map — структурный контракт vscode.SecretStorage (см. mcpMutationGateSupport.test.ts). */
function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

/**
 * Проверка поддержки идёт раньше хранилища и подтверждения, поэтому командам
 * нужны только эти два сервиса; хранилище без привязки ничего не запрещает.
 */
function createServices(fixture: SupportFixtureRoot, supportService: SupportInfoService): CommandServices {
  const repositoryService = new RepositoryService(
    fixture.tempDir,
    new ProjectSecretStorage(createFakeSecretStore(), fixture.tempDir)
  );
  return { supportService, repositoryService } as unknown as CommandServices;
}

interface RemoveCommandCase {
  readonly label: string;
  readonly run: (xmlPath: string, services: CommandServices) => Promise<void>;
}

const REMOVE_COMMANDS: readonly RemoveCommandCase[] = [
  {
    label: 'removeMetadata',
    run: (xmlPath, services) => removeMetadata(
      new MetadataNode(
        { label: path.basename(xmlPath, '.xml'), nodeKind: 'Catalog', xmlPath, canRemoveMetadata: true },
        vscode.TreeItemCollapsibleState.None
      ),
      services
    ),
  },
  {
    label: 'removeForm',
    // Владелец формы вычисляется из пути `<Объект>/Forms/<Форма>.xml`, сам файл формы не читается.
    run: (xmlPath, services) => removeForm(
      new MetadataNode(
        {
          label: 'ФормаЭлемента',
          nodeKind: 'Form',
          xmlPath: path.join(xmlPath.slice(0, -'.xml'.length), 'Forms', 'ФормаЭлемента.xml'),
        },
        vscode.TreeItemCollapsibleState.None
      ),
      services
    ),
  },
];

interface ObjectCase {
  readonly label: string;
  readonly xmlPathOf: (fixture: SupportFixtureRoot) => string;
}

const OBJECT_CASES: readonly ObjectCase[] = [
  { label: 'Контрагенты (a=2)', xmlPathOf: (f) => f.kontragentyXmlPath },
  { label: 'АвансовыйОтчетПрисоединенныеФайлы (a=0)', xmlPathOf: (f) => f.avansovyOtchetXmlPath },
  { label: 'ПриходТовара (a=1)', xmlPathOf: (f) => f.prihodTovaraXmlPath },
];

type WindowStubs = Pick<typeof vscode.window, 'showErrorMessage' | 'showQuickPick' | 'showWarningMessage'>;

suite('UI-удаление: причина отказа по поддержке (issue #35)', () => {
  const windowRef = vscode.window as WindowStubs;
  let originals: WindowStubs;
  let errorMessages: string[];
  let confirmRequests: number;

  setup(() => {
    errorMessages = [];
    confirmRequests = 0;
    originals = {
      showErrorMessage: vscode.window.showErrorMessage,
      showQuickPick: vscode.window.showQuickPick,
      showWarningMessage: vscode.window.showWarningMessage,
    };
    windowRef.showErrorMessage = ((message: string) => {
      errorMessages.push(message);
      return Promise.resolve(undefined);
    });
    // Подтверждение удаления означает, что гейт поддержки пропустил команду;
    // отказ от подтверждения гарантирует, что XML при этом не трогается.
    windowRef.showQuickPick = (() => {
      confirmRequests++;
      return Promise.resolve(undefined);
    });
    windowRef.showWarningMessage = (() => {
      confirmRequests++;
      return Promise.resolve(undefined);
    });
  });

  teardown(() => {
    windowRef.showErrorMessage = originals.showErrorMessage;
    windowRef.showQuickPick = originals.showQuickPick;
    windowRef.showWarningMessage = originals.showWarningMessage;
  });

  async function runOn(
    variant: 'normal' | 'forbidden',
    command: RemoveCommandCase,
    object: ObjectCase
  ): Promise<{ xmlUnchanged: boolean }> {
    const fixture = buildSupportFixtureRoot(variant);
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const xmlPath = object.xmlPathOf(fixture);
      const before = fs.readFileSync(xmlPath);

      await command.run(xmlPath, createServices(fixture, supportService));

      return { xmlUnchanged: before.equals(fs.readFileSync(xmlPath)) };
    } finally {
      fixture.dispose();
    }
  }

  for (const command of REMOVE_COMMANDS) {
    for (const object of OBJECT_CASES) {
      test(`${command.label}: forbidden, ${object.label} → причина «изменения конфигурации запрещены»`, async () => {
        const { xmlUnchanged } = await runOn('forbidden', command, object);

        assert.deepStrictEqual(errorMessages, [FORBIDDEN_TEXT]);
        assert.strictEqual(confirmRequests, 0, 'при запрете подтверждение удаления не запрашивается');
        assert.ok(xmlUnchanged, 'XML объекта не должен меняться');
      });
    }

    test(`${command.label}: normal, АвансовыйОтчетПрисоединенныеФайлы (a=0) → прежний текст`, async () => {
      const { xmlUnchanged } = await runOn('normal', command, OBJECT_CASES[1]);

      assert.deepStrictEqual(errorMessages, [OBJECT_LOCKED_TEXT]);
      assert.strictEqual(confirmRequests, 0);
      assert.ok(xmlUnchanged);
    });

    for (const object of [OBJECT_CASES[0], OBJECT_CASES[2]]) {
      test(`${command.label}: normal, ${object.label} → поддержка не запрещает, дело доходит до подтверждения`, async () => {
        const { xmlUnchanged } = await runOn('normal', command, object);

        assert.deepStrictEqual(errorMessages, []);
        assert.strictEqual(confirmRequests, 1);
        assert.ok(xmlUnchanged);
      });
    }
  }
});
