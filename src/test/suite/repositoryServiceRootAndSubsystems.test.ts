import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';

/** Фейковый SecretStore на Map — структурный контракт vscode.SecretStorage. */
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

function metaDataObjectXml(body: string): string {
  return `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21">\n${body}\n</MetaDataObject>`;
}

function subsystemXml(name: string): string {
  return metaDataObjectXml(
    `\t<Subsystem uuid="00000000-0000-0000-0000-000000000002">\n\t\t<Properties>\n\t\t\t<Name>${name}</Name>\n\t\t</Properties>\n\t\t<ChildObjects/>\n\t</Subsystem>`
  );
}

function write(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Проект с выгрузкой в `src/cf`, подключённый к хранилищу: файлы корня конфигурации и
 * вложенная подсистема в раскладке выгрузки платформы.
 */
suite('RepositoryService — файлы корня и вложенные подсистемы', () => {
  let root: string;
  let configRoot: string;
  let service: RepositoryService;
  let target: RepositoryTarget;

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repository-root-'));
    configRoot = path.join(root, 'src', 'cf');
    write(path.join(configRoot, 'Configuration.xml'), metaDataObjectXml(
      '\t<Configuration uuid="00000000-0000-0000-0000-000000000001">\n\t\t<Properties>\n\t\t\t<Name>Основная</Name>\n\t\t</Properties>\n\t\t<ChildObjects/>\n\t</Configuration>'
    ));
    service = new RepositoryService(root, new ProjectSecretStorage(createFakeSecretStore(), root));
    const resolved = service.resolveTargetByConfigRoot(configRoot);
    assert.ok(resolved);
    target = resolved;
    await service.saveBinding(target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
    service.setConnected(target, true);
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function lockRoot(): void {
    const objects = service.createObjectsFileForNode(
      { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(configRoot, 'Configuration.xml') },
      false
    );
    service.setLocked(target, objects.fullNames, true);
  }

  test('Configuration.xml и модули корня (Ext/**) без захвата корня недоступны для правки', () => {
    const configurationXml = path.join(configRoot, 'Configuration.xml');
    const rootModule = write(path.join(configRoot, 'Ext', 'ManagedApplicationModule.bsl'), '');
    const commandInterface = write(path.join(configRoot, 'Ext', 'CommandInterface.xml'), '<CommandInterface/>');

    for (const filePath of [configurationXml, rootModule, commandInterface]) {
      assert.strictEqual(service.isEditRestricted(filePath), true, filePath);
    }

    lockRoot();
    for (const filePath of [configurationXml, rootModule, commandInterface]) {
      assert.strictEqual(service.isEditRestricted(filePath), false, filePath);
    }
  });

  test('без подключения к хранилищу файлы корня не ограничиваются', () => {
    service.setConnected(target, false);
    assert.strictEqual(service.isEditRestricted(path.join(configRoot, 'Configuration.xml')), false);
  });

  test('файл объекта с каталогом Ext не считается файлом корня', () => {
    write(path.join(configRoot, 'Catalogs', 'Товары.xml'), metaDataObjectXml(
      '\t<Catalog uuid="00000000-0000-0000-0000-000000000003">\n\t\t<Properties>\n\t\t\t<Name>Товары</Name>\n\t\t</Properties>\n\t</Catalog>'
    ));
    const objectModule = write(path.join(configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl'), '');

    lockRoot();
    assert.strictEqual(service.isEditRestricted(objectModule), true, 'захват корня не захватывает объект');
    service.setLocked(target, ['Справочник.Товары'], true);
    assert.strictEqual(service.isEditRestricted(objectModule), false);
  });

  test('полное имя вложенной подсистемы строится по цепочке родителей', () => {
    const topXml = write(path.join(configRoot, 'Subsystems', 'Продажи.xml'), subsystemXml('Продажи'));
    const nestedXml = write(path.join(configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница.xml'), subsystemXml('Розница'));
    const deepXml = write(
      path.join(configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Опт', 'Опт.xml'),
      subsystemXml('Опт')
    );

    assert.strictEqual(service.resolveFullName({ nodeKind: 'Subsystem', label: 'Продажи', xmlPath: topXml }), 'Подсистема.Продажи');
    assert.strictEqual(
      service.resolveFullName({ nodeKind: 'Subsystem', label: 'Розница', xmlPath: nestedXml }),
      'Подсистема.Продажи.Подсистема.Розница'
    );
    assert.strictEqual(
      service.resolveFullName({ nodeKind: 'Subsystem', label: 'Опт', xmlPath: deepXml }),
      'Подсистема.Продажи.Подсистема.Опт',
      'глубокая раскладка Опт/Опт.xml не удваивает имя'
    );
    assert.strictEqual(
      service.resolveFullName({ nodeKind: 'Subsystem', label: 'БезXml' }),
      'Подсистема.БезXml',
      'без XML — прежнее имя по метке узла'
    );
  });

  test('запрет правки вложенной подсистемы снимается захватом её полного имени, а не короткого', () => {
    const nestedXml = write(path.join(configRoot, 'Subsystems', 'Продажи', 'Subsystems', 'Розница.xml'), subsystemXml('Розница'));

    assert.strictEqual(service.isMetadataEditRestricted(target, nestedXml), true);
    service.setLocked(target, ['Подсистема.Розница'], true);
    assert.strictEqual(service.isMetadataEditRestricted(target, nestedXml), true, 'короткое имя — чужая единица');
    service.setLocked(target, ['Подсистема.Продажи.Подсистема.Розница'], true);
    assert.strictEqual(service.isMetadataEditRestricted(target, nestedXml), false);
  });
});
