/**
 * Issue #22: `McpMutationGate.assertMetadataEditable` — общий guard для MCP-
 * инструментов мутации, повторяющий проверки UI. При флаге «изменения
 * запрещены» в `Ext/ParentConfigurations.bin` `getSupportMode` по-прежнему
 * даёт `Locked` для любого пути (не меняется), но текст исключения обязан
 * отличаться от «объект на поддержке с запретом редактирования» — иначе
 * агент, читающий сообщение об ошибке, попытается снять объект с поддержки,
 * хотя проблема в настройках поддержки всей конфигурации.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import { SupportInfoService } from '../../infra/support/SupportInfoService';
import type { Logger } from '../../infra/support/Logger';
import { RepositoryService } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { buildSupportFixtureRoot, type SupportFixtureRoot } from './support/realConfigFixtures';

class TestLogger implements Logger {
  readonly messages: string[] = [];
  appendLine(message: string): void {
    this.messages.push(message);
  }
}

/** Фейковый SecretStore на Map — структурный контракт vscode.SecretStorage (см. metadataMutationServiceSupport.test.ts). */
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

type GateServices = ConstructorParameters<typeof McpMutationGate>[0];

/** RepositoryService без привязки — isEditRestricted всегда false (hasBinding не установлен). */
function createUnboundRepositoryService(fixture: SupportFixtureRoot): RepositoryService {
  return new RepositoryService(fixture.tempDir, new ProjectSecretStorage(createFakeSecretStore(), fixture.tempDir));
}

function createGate(fixture: SupportFixtureRoot, supportService: SupportInfoService): McpMutationGate {
  const repositoryService = createUnboundRepositoryService(fixture);
  return new McpMutationGate({ supportService, repositoryService } as unknown as GateServices);
}

interface ObjectCase {
  readonly label: string;
  readonly xmlPathOf: (fixture: SupportFixtureRoot) => string;
}

const OBJECT_CASES: readonly ObjectCase[] = [
  { label: 'Контрагенты (a=2)', xmlPathOf: (f) => f.kontragentyXmlPath },
  { label: 'АвансовыйОтчетПрисоединенныеФайлы (a=0)', xmlPathOf: (f) => f.avansovyOtchetXmlPath },
  { label: 'ПриходТовара (a=1)', xmlPathOf: (f) => f.prihodTovaraXmlPath },
];

suite('McpMutationGate.assertMetadataEditable — issue #22 (флаг «изменения запрещены»)', () => {
  const FORBIDDEN_MESSAGE = 'Объект защищён от изменения: изменения конфигурации запрещены в настройках поддержки.';
  const LOCKED_MESSAGE = 'Объект защищён от изменения: находится на поддержке с запретом редактирования.';

  for (const objectCase of OBJECT_CASES) {
    test(`forbidden: ${objectCase.label} → бросает новый текст про настройки поддержки`, () => {
      const fixture = buildSupportFixtureRoot('forbidden');
      try {
        const supportService = new SupportInfoService(new TestLogger());
        supportService.loadConfig(fixture.configRoot);
        const gate = createGate(fixture, supportService);
        const xmlPath = objectCase.xmlPathOf(fixture);

        assert.throws(() => { gate.assertMetadataEditable(xmlPath); }, { message: FORBIDDEN_MESSAGE });
      } finally {
        fixture.dispose();
      }
    });
  }

  test('normal: АвансовыйОтчетПрисоединенныеФайлы (a=0, Locked без флага) → бросает прежний текст', () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const gate = createGate(fixture, supportService);

      assert.throws(
        () => { gate.assertMetadataEditable(fixture.avansovyOtchetXmlPath); },
        { message: LOCKED_MESSAGE }
      );
    } finally {
      fixture.dispose();
    }
  });

  test('normal: ПриходТовара (a=1, Editable) → не бросает', () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const gate = createGate(fixture, supportService);

      assert.doesNotThrow(() => { gate.assertMetadataEditable(fixture.prihodTovaraXmlPath); });
    } finally {
      fixture.dispose();
    }
  });

  test('normal: Контрагенты (a=2, снят с поддержки → Removed, issue #21) → не бросает', () => {
    const fixture = buildSupportFixtureRoot('normal');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const gate = createGate(fixture, supportService);

      assert.doesNotThrow(() => { gate.assertMetadataEditable(fixture.kontragentyXmlPath); });
    } finally {
      fixture.dispose();
    }
  });

  test('без objectXmlPath — прежняя ошибка резолвинга XML (регрессия, не относится к issue #22)', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const gate = createGate(fixture, supportService);

      assert.throws(
        () => { gate.assertMetadataEditable(undefined); },
        { message: 'Не удалось определить XML-файл объекта для проверки блокировки изменения.' }
      );
    } finally {
      fixture.dispose();
    }
  });
});

// Фикстура реальна (example/2.21 + example/support/changes-forbidden), поэтому
// файл не трогает XML на диске — sanity-проверка, что тесты выше не портят
// исходные объекты example/ (mutable state исключён самим API assertMetadataEditable,
// но явная проверка защищает от будущих регрессий сигнатуры метода).
suite('McpMutationGate.assertMetadataEditable — issue #22, sanity: чтение, не запись', () => {
  test('assertMetadataEditable не изменяет содержимое проверяемого XML', () => {
    const fixture = buildSupportFixtureRoot('forbidden');
    try {
      const supportService = new SupportInfoService(new TestLogger());
      supportService.loadConfig(fixture.configRoot);
      const gate = createGate(fixture, supportService);
      const before = fs.readFileSync(fixture.kontragentyXmlPath, 'utf-8');

      assert.throws(() => { gate.assertMetadataEditable(fixture.kontragentyXmlPath); });

      assert.strictEqual(fs.readFileSync(fixture.kontragentyXmlPath, 'utf-8'), before);
    } finally {
      fixture.dispose();
    }
  });
});
