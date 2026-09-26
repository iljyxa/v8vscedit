import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runRepositoryLockFlow, runRepositoryUpdateFlow } from '../../ui/commands/repository/RepositoryLockSync';
import { runRepositoryUnlockFlow, runRepositoryCommitFlow } from '../../ui/commands/repository/RepositoryUnlockSync';
import type { RepositoryFileSyncDeps, RepositoryFileSyncServices } from '../../ui/commands/repository/RepositoryFileSyncShared';
import type { ConflictSummary } from '../../ui/commands/repository/RepositoryFileSyncDialogs';
import { ConfigurationOperationGuard } from '../../infra/process/ConfigurationOperationGuard';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { resolveObjectScope, type ObjectScope } from '../../infra/repository/RepositoryObjectScope';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';
import { createPartialDumpFixture, KNOWN_FIXTURE_UNITS } from './support/partialDumpFixture';

/**
 * Issue #45: захват/освобождение/помещение узла Form/Template НАПРЯМУЮ (не через
 * владельца) — сквозные сценарии на РЕАЛЬНОЙ копии `example/2.21/src/cf`
 * (`Справочник.Контрагенты`, формы `ФормаЭлемента`/`ФормаСписка`, макет
 * `ЗагрузкаИзФайла`). До исправления `RepositoryService.resolveFullName` для узла
 * Form/Template отдавал fullName ВЛАДЕЛЬЦА — эти тесты писали бы (и читали) в
 * `state.json` fullName владельца вместо fullName единицы, что здесь проверяется
 * напрямую через `partialDumpFixture` (какое `-listFile` реально ушло в CLI) и
 * `repositoryService.isLocked` по ТОЧНОМУ fullName единицы.
 */

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

function notCalled(name: string): (...args: unknown[]) => never {
  return () => { throw new Error(`"${name}" не должен вызываться в этом сценарии`); };
}

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  repositoryService: RepositoryService;
  guard: ConfigurationOperationGuard;
  services: RepositoryFileSyncServices;
  outputLines: string[];
  reloadCallsCount: number;
}

const createdWorkspaceRoots: string[] = [];

function cleanupHarnesses(): void {
  createdWorkspaceRoots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
}

function createHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-repo-form-node-'));
  createdWorkspaceRoots.push(workspaceRoot);
  const configRoot = path.join(workspaceRoot, 'src', 'cf');
  fs.cpSync(EXAMPLE_CF, configRoot, { recursive: true });

  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot, configKind: 'cf', displayName: 'ТорговыйУчет' };
  const guard = new ConfigurationOperationGuard();
  const outputLines: string[] = [];
  let reloadCallsCount = 0;

  const services: RepositoryFileSyncServices = {
    configurationOperationGuard: guard,
    workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
    outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
    repositoryService,
    projectSecretStorage: {} as unknown as RepositoryFileSyncServices['projectSecretStorage'],
    supportService: undefined,
    suppressConfigurationReloadForFiles: () => undefined,
    markChangedConfigurationByFiles: () => undefined,
    treeProvider: { refresh: () => undefined, refreshCacheForFiles: () => true } as unknown as MetadataTreeProvider,
    refreshActionsView: () => undefined,
    reloadEntries: () => { reloadCallsCount += 1; return Promise.resolve(); },
  };

  return {
    workspaceRoot, configRoot, target, repositoryService, guard, services, outputLines,
    get reloadCallsCount() { return reloadCallsCount; },
  };
}

function baseDeps(fixture: ReturnType<typeof createPartialDumpFixture>, overrides: Partial<RepositoryFileSyncDeps> = {}): RepositoryFileSyncDeps {
  return {
    runRepositoryCli: () => Promise.resolve({ status: 'done' }),
    dumpToTemp: (target, request, services) => fixture.dumpToTemp(target, request, services),
    chooseConflictResolution: notCalled('chooseConflictResolution'),
    confirmRollback: notCalled('confirmRollback'),
    openDiffs: notCalled('openDiffs'),
    notifyBusy: () => undefined,
    notifyInfo: () => undefined,
    notifyWarning: () => undefined,
    notifyError: () => undefined,
    isFileSyncEnabled: () => true,
    getDirtyFilePaths: () => [],
    now: () => new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function formNode(harness: Harness, ownerName: string, formLabel: string): RepositoryNodeRef {
  const ownerXmlPath = path.join(harness.configRoot, 'Catalogs', `${ownerName}.xml`);
  assert.ok(fs.existsSync(ownerXmlPath), `ожидался владелец фикстуры Catalogs/${ownerName}.xml`);
  return {
    nodeKind: 'Form',
    label: formLabel,
    xmlPath: ownerXmlPath,
    metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXmlPath },
  };
}

function templateNode(harness: Harness, ownerName: string, templateLabel: string): RepositoryNodeRef {
  const ownerXmlPath = path.join(harness.configRoot, 'Catalogs', `${ownerName}.xml`);
  return {
    nodeKind: 'Template',
    label: templateLabel,
    xmlPath: ownerXmlPath,
    metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXmlPath },
  };
}

function ownerNode(harness: Harness, ownerName: string): RepositoryNodeRef {
  return { nodeKind: 'Catalog', label: ownerName, xmlPath: path.join(harness.configRoot, 'Catalogs', `${ownerName}.xml`) };
}

suite('Захват узла Form/Template напрямую — CLI/state по fullName ЕДИНИЦЫ (issue #45)', () => {
  teardown(cleanupHarnesses);

  for (const recursive of [false, true]) {
    test(`Форма Контрагенты.ФормаЭлемента, recursive=${String(recursive)}: dumpToTemp с fullName формы, форма захвачена, владелец — нет`, async () => {
      const harness = createHarness();
      const node = formNode(harness, 'Контрагенты', 'ФормаЭлемента');
      const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
      const deps = baseDeps(fixture);

      const outcome = await runRepositoryLockFlow(node, recursive, harness.services, deps);

      assert.strictEqual(outcome, 'done');
      assert.strictEqual(fixture.calls.length, 1);
      assert.deepStrictEqual(fixture.calls[0].names, [KNOWN_FIXTURE_UNITS.kontragentyFormaElementa]);
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragentyFormaElementa), true);
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragenty), false, 'захват формы не должен захватывать владельца.');
      assert.ok(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, KNOWN_FIXTURE_UNITS.kontragentyFormaElementa), 'у формы должен появиться собственный снимок.');
      assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, KNOWN_FIXTURE_UNITS.kontragenty), undefined, 'у владельца снимка быть не должно.');
      assert.strictEqual(harness.reloadCallsCount, 0, 'захват листовой единицы — не структурное изменение, полный reloadEntries не нужен.');
      fixture.disposeAll();
    });
  }

  for (const recursive of [false, true]) {
    test(`Макет Контрагенты.ЗагрузкаИзФайла, recursive=${String(recursive)}: dumpToTemp с fullName макета, макет захвачен, владелец — нет`, async () => {
      const harness = createHarness();
      const node = templateNode(harness, 'Контрагенты', 'ЗагрузкаИзФайла');
      const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
      const deps = baseDeps(fixture);

      const outcome = await runRepositoryLockFlow(node, recursive, harness.services, deps);

      assert.strictEqual(outcome, 'done');
      assert.strictEqual(fixture.calls.length, 1);
      assert.deepStrictEqual(fixture.calls[0].names, [KNOWN_FIXTURE_UNITS.kontragentyMaket]);
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragentyMaket), true);
      assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragenty), false);
      fixture.disposeAll();
    });
  }

  test('Изоляция области: локальная правка ObjectModule владельца до захвата формы остаётся нетронутой, конфликт — только по путям формы', async () => {
    const harness = createHarness();
    const node = formNode(harness, 'Контрагенты', 'ФормаЭлемента');
    const ownerModulePath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl');
    const originalOwnerContent = fs.readFileSync(ownerModulePath, 'utf-8');
    const editedOwnerContent = `${originalOwnerContent}\n// локальная правка владельца до захвата формы`;
    fs.writeFileSync(ownerModulePath, editedOwnerContent, 'utf-8');

    const formXmlRel = path.join('Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента.xml');
    const formXmlPath = path.join(harness.configRoot, formXmlRel);
    const originalFormXml = fs.readFileSync(formXmlPath, 'utf-8');
    fs.writeFileSync(formXmlPath, `${originalFormXml}<!--локальная правка формы-->`, 'utf-8');

    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    let observedFiles: string[] = [];
    const deps = baseDeps(fixture, {
      chooseConflictResolution: (summary: ConflictSummary) => { observedFiles = summary.files; return Promise.resolve('replace'); },
    });

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(
      fs.readFileSync(ownerModulePath, 'utf-8'),
      editedOwnerContent,
      'файл владельца обязан остаться нетронутым — он вне области захвата формы.'
    );
    assert.ok(observedFiles.length >= 1, 'ожидался хотя бы один конфликтный файл (правка формы без хеш-кэша).');
    assert.ok(
      observedFiles.every((relPath) => relPath.split(path.sep).join('/').includes('Catalogs/Контрагенты/Forms/ФормаЭлемента')),
      `конфликт обязан касаться только файлов формы, получено: ${JSON.stringify(observedFiles)}`
    );
    fixture.disposeAll();
  });

  test('Readonly после захвата формы (привязка+setConnected): модуль формы редактируем, ObjectModule владельца — нет', async () => {
    const harness = createHarness();
    const node = formNode(harness, 'Контрагенты', 'ФормаЭлемента');
    await harness.repositoryService.saveBinding(harness.target, { repoPath: '\\\\repo\\storage', repoUser: 'tester', repoPassword: 'secret' });
    harness.repositoryService.setConnected(harness.target, true);

    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const deps = baseDeps(fixture);

    const outcome = await runRepositoryLockFlow(node, false, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    const formModulePath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl');
    const ownerModulePath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl');
    assert.strictEqual(harness.repositoryService.isEditRestricted(formModulePath), false, 'форма захвачена — её модуль редактируем.');
    assert.strictEqual(harness.repositoryService.isEditRestricted(ownerModulePath), true, 'владелец НЕ захвачен — его модуль ограничен.');
    fixture.disposeAll();
  });

  test('runRepositoryUpdateFlow с узла формы: выгрузка только формы, состояние захвата не меняется', async () => {
    const harness = createHarness();
    const node = formNode(harness, 'Контрагенты', 'ФормаЭлемента');
    const fixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const deps = baseDeps(fixture);

    const outcome = await runRepositoryUpdateFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(fixture.calls.length, 1);
    assert.deepStrictEqual(fixture.calls[0].names, [KNOWN_FIXTURE_UNITS.kontragentyFormaElementa]);
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragentyFormaElementa), false, 'update не захватывает объект.');
    fixture.disposeAll();
  });
});

suite('Отмена захвата узла Form напрямую (issue #45)', () => {
  teardown(cleanupHarnesses);

  test('Локальная правка модуля формы после захвата — откат восстанавливает файл формы, снимок формы удалён, владелец не тронут', async () => {
    const harness = createHarness();
    const node = formNode(harness, 'Контрагенты', 'ФормаЭлемента');
    const lockFixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const lockOutcome = await runRepositoryLockFlow(node, false, harness.services, baseDeps(lockFixture));
    assert.strictEqual(lockOutcome, 'done');
    lockFixture.disposeAll();

    const formModulePath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl');
    const originalModuleContent = fs.readFileSync(formModulePath, 'utf-8');
    fs.writeFileSync(formModulePath, `${originalModuleContent}\n// правка после захвата формы`, 'utf-8');

    const ownerModulePath = path.join(harness.configRoot, 'Catalogs', 'Контрагенты', 'Ext', 'ObjectModule.bsl');
    const ownerContentBefore = fs.readFileSync(ownerModulePath, 'utf-8');

    let confirmRollbackCalls = 0;
    const deps = baseDeps(createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName), {
      confirmRollback: () => { confirmRollbackCalls += 1; return Promise.resolve(true); },
    });

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(confirmRollbackCalls, 1);
    assert.strictEqual(fs.readFileSync(formModulePath, 'utf-8'), originalModuleContent, 'модуль формы обязан быть восстановлен к версии на момент захвата.');
    assert.strictEqual(fs.readFileSync(ownerModulePath, 'utf-8'), ownerContentBefore, 'владелец не должен быть тронут отменой захвата формы.');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragentyFormaElementa), false);
    assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, KNOWN_FIXTURE_UNITS.kontragentyFormaElementa), undefined, 'снимок формы обязан быть удалён после отмены захвата.');
  });

  test('Отмена захвата формы после РЕКУРСИВНОГО захвата владельца (issue #45, регресс группового unlock): форма снята, владелец и соседняя форма остаются захваченными', async () => {
    const harness = createHarness();
    const owner = ownerNode(harness, 'Контрагенты');
    const lockFixture = createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName);
    const lockOutcome = await runRepositoryLockFlow(owner, true, harness.services, baseDeps(lockFixture));
    assert.strictEqual(lockOutcome, 'done', 'предпосылка: владелец должен захватиться рекурсивно вместе с формами/макетом.');
    lockFixture.disposeAll();

    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragentyFormaElementa), true, 'предпосылка: форма захвачена в составе группы владельца.');

    const node = formNode(harness, 'Контрагенты', 'ФормаЭлемента');
    // Файлы формы не менялись с момента захвата владельца — снимок совпадает,
    // диалог/выгрузка не требуются (см. repositoryUnlockSync.test.ts, suite
    // "снимок без изменений").
    const deps = baseDeps(createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName));

    const outcome = await runRepositoryUnlockFlow(node, { recursive: false, force: false }, harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragentyFormaElementa), false, 'форма обязана перестать считаться захваченной.');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragenty), true, 'владелец должен остаться захваченным.');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, KNOWN_FIXTURE_UNITS.kontragentyFormaSpiska), true, 'соседняя форма (участник той же группы) не должна пострадать.');
  });
});

suite('Помещение узла Form напрямую — runRepositoryCommitFlow (issue #45)', () => {
  teardown(cleanupHarnesses);

  function formScope(harness: Harness, formFullName: string): Extract<ObjectScope, { kind: 'object' }> {
    const scope = resolveObjectScope(harness.configRoot, formFullName, harness.target);
    assert.ok(scope?.kind === 'object');
    return scope;
  }

  function formData(overrides: Partial<{ recursive: boolean; comment: string; keepLocked: boolean; force: boolean }> = {}) {
    return { recursive: false, comment: 'Комментарий помещения формы', keepLocked: false, force: false, ...overrides };
  }

  test('keepLocked=false: снимок формы удалён, форма освобождена, владелец не тронут', async () => {
    const harness = createHarness();
    const formFullName = KNOWN_FIXTURE_UNITS.kontragentyFormaElementa;
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: formFullName, members: [formFullName], mode: 'object' });
    harness.repositoryService.snapshots.captureFromProject(harness.target, formFullName, formScope(harness, formFullName));

    const node = formNode(harness, 'Контрагенты', 'ФормаЭлемента');
    const deps = baseDeps(createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName));

    const outcome = await runRepositoryCommitFlow(node, formData({ keepLocked: false }), harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, formFullName), false);
    assert.strictEqual(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, formFullName), undefined, 'снимок формы обязан быть удалён.');
  });

  test('keepLocked=true: снимок формы пересоздан из проекта, форма остаётся захваченной, у владельца снимка нет', async () => {
    const harness = createHarness();
    const formFullName = KNOWN_FIXTURE_UNITS.kontragentyFormaElementa;
    harness.repositoryService.lockState.applyLock(harness.target, { anchor: formFullName, members: [formFullName], mode: 'object' });
    harness.repositoryService.snapshots.captureFromProject(harness.target, formFullName, formScope(harness, formFullName));

    const node = formNode(harness, 'Контрагенты', 'ФормаЭлемента');
    const deps = baseDeps(createPartialDumpFixture(EXAMPLE_CF, harness.target.displayName));

    const outcome = await runRepositoryCommitFlow(node, formData({ keepLocked: true }), harness.services, deps);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(harness.repositoryService.isLocked(harness.target, formFullName), true, 'keepLocked:true — форма должна остаться захваченной.');
    assert.ok(harness.repositoryService.snapshots.readSnapshotInfo(harness.target, formFullName), 'снимок формы обязан быть пересоздан из проекта.');
    assert.strictEqual(
      harness.repositoryService.snapshots.readSnapshotInfo(harness.target, KNOWN_FIXTURE_UNITS.kontragenty),
      undefined,
      'у владельца снимка быть не должно — recursive:false, subject.members ограничен самой формой.'
    );
  });
});
