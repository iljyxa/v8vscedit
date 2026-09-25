import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  applyMergeWithPostMutation,
  finishPostMutation,
  reportFlowError,
  reportMergeOutcome,
  resolveMergeScope,
  resolveSubjectTarget,
  type MergeApplicationResult,
  type PlannedMergeSource,
  type RepositoryFileSyncDeps,
  type RepositoryFileSyncServices,
} from '../../ui/commands/repository/RepositoryFileSyncShared';
import type { MergeDiffPair } from '../../ui/commands/repository/RepositoryFileSyncDialogs';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { buildScopeKey, computeFileHash, loadHashCache, saveHashCache } from '../../infra/cache/HashCache';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import type { MetadataTreeProvider } from '../../ui/tree/MetadataTreeProvider';

/**
 * Issue #1 — прямые unit-тесты экспортируемых функций `RepositoryFileSyncShared.ts`,
 * не покрытых сквозными сценариями `RepositoryLockSync`/`RepositoryUnlockSync`
 * (эти функции не завязаны на конкретный поток захвата/отмены, поэтому
 * дешевле и детерминированнее проверяются напрямую, без полной аренды guard'а).
 */

const EXAMPLE_CF = path.resolve(__dirname, '../../../example/2.21/src/cf');

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

interface Harness {
  workspaceRoot: string;
  configRoot: string;
  target: RepositoryTarget;
  services: RepositoryFileSyncServices;
  outputLines: string[];
  suppressCalls: string[][];
  markChangedCalls: string[][];
  refreshCacheForFilesCalls: string[][];
  refreshCacheForFilesResult: boolean;
  treeRefreshCalls: number;
  actionsViewCalls: number;
  reloadCalls: number;
}

function createHarness(configRoot?: string): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-filesync-shared-'));
  const root = configRoot ?? (() => {
    const dir = path.join(workspaceRoot, 'src', 'cf');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Configuration.xml'), '<MetaDataObject><Name>Тест</Name></MetaDataObject>', 'utf-8');
    return dir;
  })();
  const repositoryService = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  const target: RepositoryTarget = { configRoot: root, configKind: 'cf', displayName: 'Тест' };
  const outputLines: string[] = [];
  const suppressCalls: string[][] = [];
  const markChangedCalls: string[][] = [];
  const refreshCacheForFilesCalls: string[][] = [];
  let treeRefreshCalls = 0;
  let actionsViewCalls = 0;
  let reloadCalls = 0;
  const state: { refreshCacheForFilesResult: boolean } = { refreshCacheForFilesResult: true };

  const services: RepositoryFileSyncServices = {
    configurationOperationGuard: undefined as unknown as RepositoryFileSyncServices['configurationOperationGuard'],
    workspaceFolder: { uri: vscode.Uri.file(workspaceRoot), name: 'test', index: 0 },
    outputChannel: { appendLine: (line: string) => outputLines.push(line) } as unknown as vscode.OutputChannel,
    repositoryService,
    projectSecretStorage: {} as unknown as RepositoryFileSyncServices['projectSecretStorage'],
    supportService: undefined,
    suppressConfigurationReloadForFiles: (files: string[]) => suppressCalls.push(files),
    markChangedConfigurationByFiles: (files: string[]) => markChangedCalls.push(files),
    treeProvider: {
      refresh: () => { treeRefreshCalls += 1; },
      refreshCacheForFiles: (files: string[]) => { refreshCacheForFilesCalls.push(files); return state.refreshCacheForFilesResult; },
    } as unknown as MetadataTreeProvider,
    refreshActionsView: () => { actionsViewCalls += 1; },
    reloadEntries: () => { reloadCalls += 1; return Promise.resolve(); },
  };

  return {
    workspaceRoot, configRoot: root, target, services, outputLines, suppressCalls, markChangedCalls,
    refreshCacheForFilesCalls,
    get refreshCacheForFilesResult() { return state.refreshCacheForFilesResult; },
    set refreshCacheForFilesResult(value: boolean) { state.refreshCacheForFilesResult = value; },
    get treeRefreshCalls() { return treeRefreshCalls; },
    get actionsViewCalls() { return actionsViewCalls; },
    get reloadCalls() { return reloadCalls; },
  };
}

function notCalled(name: string): (...args: unknown[]) => never {
  return () => { throw new Error(`"${name}" не должен вызываться в этом сценарии`); };
}

function baseDeps(overrides: Partial<RepositoryFileSyncDeps> = {}): RepositoryFileSyncDeps {
  return {
    runRepositoryCli: notCalled('runRepositoryCli'),
    dumpToTemp: notCalled('dumpToTemp'),
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

function emptyMerge(): MergeApplicationResult['merge'] {
  return { writtenFiles: [], deletedFiles: [], keptLocalFiles: [], backups: [], repositoryCopies: [] };
}

suite('RepositoryFileSyncShared — reportFlowError', () => {
  test('Error → message из error.message, лог и notifyError, возвращает "failed"', () => {
    const harness = createHarness();
    let notifiedMessage: string | undefined;
    const deps = baseDeps({ notifyError: (message) => { notifiedMessage = message; } });

    const outcome = reportFlowError(harness.services, deps, 'Метка', new Error('бум'));

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(notifiedMessage, 'Метка: бум');
    assert.ok(harness.outputLines.some((line) => line.includes('[repository][file-sync][error] Метка: бум')));
  });

  test('не-Error причина → String(error), ветка else тернарника', () => {
    const harness = createHarness();
    let notifiedMessage: string | undefined;
    const deps = baseDeps({ notifyError: (message) => { notifiedMessage = message; } });

    const outcome = reportFlowError(harness.services, deps, 'Метка', 'просто строка');

    assert.strictEqual(outcome, 'failed');
    assert.strictEqual(notifiedMessage, 'Метка: просто строка');
  });
});

suite('RepositoryFileSyncShared — resolveSubjectTarget', () => {
  test('узел без валидного xmlPath (Configuration.xml не найден) — notifyError и null', () => {
    const harness = createHarness();
    let notifiedMessage: string | undefined;
    const deps = baseDeps({ notifyError: (message) => { notifiedMessage = message; } });

    const result = resolveSubjectTarget(
      { nodeKind: 'Catalog', label: 'X', xmlPath: path.join(harness.workspaceRoot, 'нет-такого-пути', 'X.xml') },
      harness.services,
      deps
    );

    assert.strictEqual(result, null);
    assert.strictEqual(notifiedMessage, 'Не удалось определить конфигурацию для выбранного узла.');
  });
});

const cfTarget: RepositoryTarget = { configRoot: EXAMPLE_CF, configKind: 'cf', displayName: 'ТорговыйУчет' };

/**
 * Раздел 10.6 «Ранее непокрытые ветки»: `resolveMergeScope` без `dumpDir` для
 * объекта, которого нет в проекте, — раньше не было отдельного unit-теста (эта
 * ветка проверялась только косвенно через сквозные сценарии lock/unlock).
 * Решение test-writer по сигнатуре (раздел 10, Р3/Р6: `includeNestedSubsystems`
 * удалён, вложенность теперь регулируется `depth` области, а не отдельным
 * булевым флагом): четвёртый параметр — `depth: ScopeDepth` вместо
 * `withNestedSubsystems: boolean`.
 */
suite('RepositoryFileSyncShared — resolveMergeScope (issue #1, раздел 10.6, Р3/Р6)', () => {
  test('без dumpDir, объекта нет в проекте → null (10.6: ранее не покрытая ветка)', () => {
    assert.strictEqual(resolveMergeScope(cfTarget, 'Справочник.НетТакогоВПроекте', undefined, 'unit'), null);
  });

  test('без dumpDir, объект есть в проекте (Контрагенты) → область по проекту', () => {
    const scope = resolveMergeScope(cfTarget, 'Справочник.Контрагенты', undefined, 'unit');
    assert.ok(scope?.kind === 'object');
  });

  test('объекта нет в проекте, но есть в dumpDir (новый в хранилище) → область по выгрузке', () => {
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-resolve-merge-scope-dump-'));
    try {
      fs.mkdirSync(path.join(dumpDir, 'Catalogs'), { recursive: true });
      fs.copyFileSync(path.join(EXAMPLE_CF, 'Catalogs', 'Контрагенты.xml'), path.join(dumpDir, 'Catalogs', 'НовыйВХранилище.xml'));
      const scope = resolveMergeScope(cfTarget, 'Справочник.НовыйВХранилище', dumpDir, 'unit');
      assert.ok(scope?.kind === 'object');
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('нет ни в проекте, ни в dumpDir → null', () => {
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-resolve-merge-scope-empty-'));
    try {
      assert.strictEqual(resolveMergeScope(cfTarget, 'Справочник.НигдеНет', dumpDir, 'unit'), null);
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('depth:"unit" — область не включает Forms/Templates владельца; depth:"tree" — включает', () => {
    const unitScope = resolveMergeScope(cfTarget, 'Справочник.Контрагенты', undefined, 'unit');
    const treeScope = resolveMergeScope(cfTarget, 'Справочник.Контрагенты', undefined, 'tree');
    assert.ok(unitScope?.kind === 'object' && treeScope?.kind === 'object');
    assert.ok(unitScope.excludeDirRels.length > 0);
    assert.deepStrictEqual(treeScope.excludeDirRels, []);
  });
});

suite('RepositoryFileSyncShared — finishPostMutation', () => {
  test('нет изменённых/оставленных файлов, не структурно — только refreshActionsView', async () => {
    const harness = createHarness();
    await finishPostMutation(harness.services, { changedFiles: [], keptDivergentFiles: [], structural: false });

    assert.strictEqual(harness.suppressCalls.length, 0);
    assert.strictEqual(harness.markChangedCalls.length, 0);
    assert.strictEqual(harness.reloadCalls, 0);
    assert.strictEqual(harness.treeRefreshCalls, 0);
    assert.strictEqual(harness.refreshCacheForFilesCalls.length, 0);
    assert.strictEqual(harness.actionsViewCalls, 1);
  });

  test('структурно — reloadEntries, refreshCacheForFiles/refresh НЕ вызываются', async () => {
    const harness = createHarness();
    await finishPostMutation(harness.services, { changedFiles: ['a.bsl'], keptDivergentFiles: [], structural: true });

    assert.strictEqual(harness.suppressCalls.length, 1);
    assert.strictEqual(harness.reloadCalls, 1);
    assert.strictEqual(harness.refreshCacheForFilesCalls.length, 0);
    assert.strictEqual(harness.treeRefreshCalls, 0);
  });

  test('не структурно, refreshCacheForFiles вернул true — treeProvider.refresh() НЕ вызывается', async () => {
    const harness = createHarness();
    harness.refreshCacheForFilesResult = true;
    await finishPostMutation(harness.services, { changedFiles: ['a.bsl'], keptDivergentFiles: [], structural: false });

    assert.strictEqual(harness.refreshCacheForFilesCalls.length, 1);
    assert.strictEqual(harness.treeRefreshCalls, 0);
    assert.strictEqual(harness.reloadCalls, 0);
  });

  test('не структурно, refreshCacheForFiles вернул false — вызывается treeProvider.refresh()', async () => {
    const harness = createHarness();
    harness.refreshCacheForFilesResult = false;
    await finishPostMutation(harness.services, { changedFiles: ['a.bsl'], keptDivergentFiles: [], structural: false });

    assert.strictEqual(harness.refreshCacheForFilesCalls.length, 1);
    assert.strictEqual(harness.treeRefreshCalls, 1);
  });

  test('keptDivergentFiles не пуст — markChangedConfigurationByFiles вызван с копией массива', async () => {
    const harness = createHarness();
    const files = ['a.bsl', 'b.bsl'];
    await finishPostMutation(harness.services, { changedFiles: [], keptDivergentFiles: files, structural: false });

    assert.deepStrictEqual(harness.markChangedCalls, [files]);
    assert.notStrictEqual(harness.markChangedCalls[0], files, 'массив должен копироваться, а не передаваться по ссылке');
  });
});

suite('RepositoryFileSyncShared — applyMergeWithPostMutation: childObjects/configDumpInfoSource', () => {
  test('sources=[], childObjects не передан — syncChildObjectsAfterMerge не трогает Configuration.xml (ветка "нет changes")', async () => {
    const harness = createHarness();
    const result = await applyMergeWithPostMutation(harness.services, {
      target: harness.target,
      sources: [],
      choice: 'replace',
      backupDir: path.join(harness.workspaceRoot, 'backup'),
    });

    assert.deepStrictEqual(result.changedFiles, []);
    assert.strictEqual(harness.actionsViewCalls, 1);
  });

  test('childObjects задан, но пуст (added/removed=[]) — раннее return без обращения к Configuration.xml', async () => {
    const harness = createHarness();
    const result = await applyMergeWithPostMutation(harness.services, {
      target: harness.target,
      sources: [],
      choice: 'replace',
      backupDir: path.join(harness.workspaceRoot, 'backup'),
      childObjects: { added: [], removed: [] },
    });

    assert.deepStrictEqual(result.changedFiles, []);
  });

  test('configDumpInfoSource существует — копируется в проект, suppress вызван для проектного пути', async () => {
    const harness = createHarness();
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-filesync-dumpinfo-'));
    const sourcePath = path.join(dumpDir, 'ConfigDumpInfo.xml');
    fs.writeFileSync(sourcePath, '<ConfigDumpInfo/>', 'utf-8');
    try {
      const result = await applyMergeWithPostMutation(harness.services, {
        target: harness.target,
        sources: [],
        choice: 'replace',
        backupDir: path.join(harness.workspaceRoot, 'backup'),
        configDumpInfoSource: sourcePath,
      });

      const projectDumpInfo = path.join(harness.configRoot, 'ConfigDumpInfo.xml');
      assert.strictEqual(fs.existsSync(projectDumpInfo), true);
      assert.strictEqual(fs.readFileSync(projectDumpInfo, 'utf-8'), '<ConfigDumpInfo/>');
      assert.ok(harness.suppressCalls.some((files) => files.some((f) => path.resolve(f) === path.resolve(projectDumpInfo))));
      void result;
    } finally {
      fs.rmSync(dumpDir, { recursive: true, force: true });
    }
  });

  test('configDumpInfoSource указывает на несуществующий файл — копирование пропускается', async () => {
    const harness = createHarness();
    await applyMergeWithPostMutation(harness.services, {
      target: harness.target,
      sources: [],
      choice: 'replace',
      backupDir: path.join(harness.workspaceRoot, 'backup'),
      configDumpInfoSource: path.join(harness.workspaceRoot, 'нет-такого-файла.xml'),
    });

    assert.strictEqual(fs.existsSync(path.join(harness.configRoot, 'ConfigDumpInfo.xml')), false);
  });

  test('добавленный объект верхнего уровня + чистый Configuration.xml (по хешу) — ChildObjects синхронизирован, хеш-кэш пропатчен', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-filesync-childobjects-'));
    try {
      fs.cpSync(EXAMPLE_CF, tempRoot, { recursive: true });
      const harness = createHarness(tempRoot);
      const configXmlPath = path.join(tempRoot, 'Configuration.xml');
      const scopeKey = buildScopeKey('cf', tempRoot, '');
      saveHashCache(harness.workspaceRoot, {
        schemaVersion: 1, scopeKey, generatedAt: '',
        files: { 'Configuration.xml': computeFileHash(configXmlPath) },
      });
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'НовыйСправочникFS.xml'), '<MetaDataObject/>', 'utf-8');

      const result = await applyMergeWithPostMutation(harness.services, {
        target: harness.target,
        sources: [],
        choice: 'replace',
        backupDir: path.join(harness.workspaceRoot, 'backup'),
        childObjects: { added: ['Справочник.НовыйСправочникFS'], removed: [] },
      });

      assert.ok(result.changedFiles.some((f) => path.resolve(f) === path.resolve(configXmlPath)));
      assert.ok(fs.readFileSync(configXmlPath, 'utf-8').includes('<Catalog>НовыйСправочникFS</Catalog>'));
      const cache = loadHashCache(harness.workspaceRoot, scopeKey);
      assert.strictEqual(cache.files['Configuration.xml'], computeFileHash(configXmlPath));
      // Структурное изменение (Configuration.xml в списке изменённых) — reloadEntries, а не точечное обновление.
      assert.strictEqual(harness.reloadCalls, 1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('добавленный объект верхнего уровня, но Configuration.xml "грязный" (хеш не совпадает с кэшем) — ChildObjects синхронизирован, хеш-кэш НЕ пропатчен', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-filesync-childobjects-dirty-'));
    try {
      fs.cpSync(EXAMPLE_CF, tempRoot, { recursive: true });
      const harness = createHarness(tempRoot);
      const configXmlPath = path.join(tempRoot, 'Configuration.xml');
      const scopeKey = buildScopeKey('cf', tempRoot, '');
      // Хеш-кэш заведомо не совпадает с текущим содержимым файла — Configuration.xml "грязный".
      saveHashCache(harness.workspaceRoot, {
        schemaVersion: 1, scopeKey, generatedAt: '',
        files: { 'Configuration.xml': 'заведомо-другой-хеш' },
      });
      fs.mkdirSync(path.join(tempRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'Catalogs', 'ДругойНовыйFS.xml'), '<MetaDataObject/>', 'utf-8');

      await applyMergeWithPostMutation(harness.services, {
        target: harness.target,
        sources: [],
        choice: 'replace',
        backupDir: path.join(harness.workspaceRoot, 'backup'),
        childObjects: { added: ['Справочник.ДругойНовыйFS'], removed: [] },
      });

      assert.ok(fs.readFileSync(configXmlPath, 'utf-8').includes('<Catalog>ДругойНовыйFS</Catalog>'));
      const cache = loadHashCache(harness.workspaceRoot, scopeKey);
      assert.strictEqual(cache.files['Configuration.xml'], 'заведомо-другой-хеш', 'При "грязном" Configuration.xml хеш-кэш не должен обновляться синхронизацией ChildObjects.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

suite('RepositoryFileSyncShared — reportMergeOutcome', () => {
  function plannedWithSkipped(rels: string[]): readonly PlannedMergeSource[] {
    return [{
      dir: '/tmp/unused',
      entries: [],
      plan: {
        entries: [],
        conflicts: [],
        silent: [],
        skipped: rels.map((rel) => ({
          rel, repositoryHash: null, localHash: null, baseHash: null, action: 'skip-incomplete' as const,
        })),
        hasConflicts: false,
      },
    }];
  }

  test('есть пропущенные файлы (skip-incomplete) — лог и notifyWarning с количеством', async () => {
    const harness = createHarness();
    let warningMessage: string | undefined;
    const deps = baseDeps({ notifyWarning: (message) => { warningMessage = message; } });

    await reportMergeOutcome(harness.services, deps, plannedWithSkipped(['Catalogs/А/Templates/Т/Ext/Template.xml']), { merge: emptyMerge(), changedFiles: [] }, 'replace', 'Товары');

    assert.ok(warningMessage?.includes('1 файл'));
    assert.ok(harness.outputLines.some((line) => line.includes('нет в выгрузке')));
  });

  test('choice="compare" — текстовые пары в пределах лимита, бинарные/отсутствующие/сверх лимита — в лог, без openDiffs при их отсутствии среди валидных', async () => {
    const harness = createHarness();
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-filesync-diffpairs-'));
    try {
      const backups = [];
      // 11 текстовых файлов: 10 попадают в окно сравнения, 1 — за лимитом (overflow).
      for (let i = 1; i <= 11; i += 1) {
        const rel = `Module${String(i)}.bsl`;
        const backupPath = path.join(backupDir, `backup-${rel}`);
        const projectPath = path.join(backupDir, `project-${rel}`);
        fs.writeFileSync(backupPath, `backup ${String(i)}`, 'utf-8');
        fs.writeFileSync(projectPath, `project ${String(i)}`, 'utf-8');
        backups.push({ rel, backupPath, projectPath });
      }
      // Бинарный файл — исключается фильтром isTextMergeFile, даже если существует.
      const binaryProject = path.join(backupDir, 'project-Icon.bin');
      fs.writeFileSync(binaryProject, Buffer.from([0, 1, 2]));
      backups.push({ rel: 'Icon.bin', backupPath: path.join(backupDir, 'backup-Icon.bin'), projectPath: binaryProject });
      // Текстовый рел, но проектный файл уже не существует — тоже исключается.
      backups.push({ rel: 'Missing.bsl', backupPath: path.join(backupDir, 'backup-Missing.bsl'), projectPath: path.join(backupDir, 'нет-такого-файла.bsl') });

      let openDiffsPairs: MergeDiffPair[] | undefined;
      const deps = baseDeps({ openDiffs: (pairs) => { openDiffsPairs = pairs; } });
      const merge = { ...emptyMerge(), backups };

      await reportMergeOutcome(harness.services, deps, [], { merge, changedFiles: [] }, 'compare', 'Товары');

      assert.strictEqual(openDiffsPairs?.length, 10, 'Лимит MAX_DIFF_TABS = 10.');
      assert.ok(harness.outputLines.some((line) => line.includes('без окна сравнения') && line.includes('Icon.bin') && line.includes('Missing.bsl') && line.includes('Module11.bsl')));
    } finally {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  });

  test('choice="compare", после применения нет бэкапов — openDiffs не вызывается (0 валидных пар)', async () => {
    const harness = createHarness();
    let openDiffsCalls = 0;
    const deps = baseDeps({ openDiffs: () => { openDiffsCalls += 1; } });

    await reportMergeOutcome(harness.services, deps, [], { merge: emptyMerge(), changedFiles: [] }, 'compare', 'Товары');

    assert.strictEqual(openDiffsCalls, 0);
  });

  test('choice="keep-local", есть оставленные файлы, правая сторона нередактируема — подсказка "Захватите объект" и кнопка "Сравнить"', async () => {
    const harness = createHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-filesync-keeplocal-'));
    try {
      const projectPath = path.join(dir, 'Module.bsl');
      fs.writeFileSync(projectPath, 'локальный код', 'utf-8');
      const repositoryPath = path.join(dir, 'repo-Module.bsl');
      fs.writeFileSync(repositoryPath, 'код хранилища', 'utf-8');

      // Нередактируемо: repositoryService.isEditRestricted → true.
      const restrictedServices: RepositoryFileSyncServices = {
        ...harness.services,
        repositoryService: { isEditRestricted: () => true } as unknown as RepositoryFileSyncServices['repositoryService'],
      };
      let infoMessage: string | undefined;
      let infoActions: { label: string; run: () => void }[] | undefined;
      const deps = baseDeps({
        notifyInfo: (message, actions) => { infoMessage = message; infoActions = actions ? [...actions] : []; },
      });
      const merge = {
        ...emptyMerge(),
        keptLocalFiles: [projectPath],
        repositoryCopies: [{ rel: 'Module.bsl', repositoryPath, projectPath }],
      };

      await reportMergeOutcome(restrictedServices, deps, [], { merge, changedFiles: [] }, 'keep-local', 'Товары');

      assert.ok(infoMessage?.includes('Захватите объект, чтобы перенести правки.'));
      const [firstAction] = infoActions ?? [];
      assert.strictEqual(infoActions?.length, 1);
      assert.strictEqual(firstAction.label, 'Сравнить');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('choice="keep-local", правая сторона редактируема — без подсказки о захвате', async () => {
    const harness = createHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-filesync-keeplocal-writable-'));
    try {
      const projectPath = path.join(dir, 'Module.bsl');
      fs.writeFileSync(projectPath, 'локальный код', 'utf-8');
      const repositoryPath = path.join(dir, 'repo-Module.bsl');
      fs.writeFileSync(repositoryPath, 'код хранилища', 'utf-8');

      const writableServices: RepositoryFileSyncServices = {
        ...harness.services,
        repositoryService: { isEditRestricted: () => false } as unknown as RepositoryFileSyncServices['repositoryService'],
      };
      let infoMessage: string | undefined;
      const deps = baseDeps({ notifyInfo: (message) => { infoMessage = message; } });
      const merge = {
        ...emptyMerge(),
        keptLocalFiles: [projectPath],
        repositoryCopies: [{ rel: 'Module.bsl', repositoryPath, projectPath }],
      };

      await reportMergeOutcome(writableServices, deps, [], { merge, changedFiles: [] }, 'keep-local', 'Товары');

      assert.ok(infoMessage !== undefined && !infoMessage.includes('Захватите объект'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('choice="keep-local", repositoryService разрешает, но supportService.isLocked=true — подсказка о захвате (правая часть &&)', async () => {
    const harness = createHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-filesync-keeplocal-support-'));
    try {
      const projectPath = path.join(dir, 'Module.bsl');
      fs.writeFileSync(projectPath, 'локальный код', 'utf-8');
      const repositoryPath = path.join(dir, 'repo-Module.bsl');
      fs.writeFileSync(repositoryPath, 'код хранилища', 'utf-8');

      const servicesWithSupportLock: RepositoryFileSyncServices = {
        ...harness.services,
        repositoryService: { isEditRestricted: () => false } as unknown as RepositoryFileSyncServices['repositoryService'],
        supportService: { isLocked: () => true } as unknown as RepositoryFileSyncServices['supportService'],
      };
      let infoMessage: string | undefined;
      const deps = baseDeps({ notifyInfo: (message) => { infoMessage = message; } });
      const merge = {
        ...emptyMerge(),
        keptLocalFiles: [projectPath],
        repositoryCopies: [{ rel: 'Module.bsl', repositoryPath, projectPath }],
      };

      await reportMergeOutcome(servicesWithSupportLock, deps, [], { merge, changedFiles: [] }, 'keep-local', 'Товары');

      assert.ok(infoMessage?.includes('Захватите объект, чтобы перенести правки.'), 'поддержка запрещает редактирование — подсказка обязана появиться, даже если repositoryService разрешает.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('choice="keep-local", 0 валидных пар для сравнения — notifyInfo без кнопок', async () => {
    const harness = createHarness();
    let infoActions: { label: string; run: () => void }[] | undefined;
    const deps = baseDeps({ notifyInfo: (_message, actions) => { infoActions = actions ? [...actions] : []; } });
    const merge = {
      ...emptyMerge(),
      keptLocalFiles: ['/несуществующий/Module.bsl'],
      repositoryCopies: [{ rel: 'Module.bsl', repositoryPath: '/нет/repo.bsl', projectPath: '/нет/project.bsl' }],
    };

    await reportMergeOutcome(harness.services, deps, [], { merge, changedFiles: [] }, 'keep-local', 'Товары');

    assert.deepStrictEqual(infoActions, []);
  });

  test('choice="keep-local", keptLocalFiles пуст — notifyInfo не вызывается вовсе', async () => {
    const harness = createHarness();
    let infoCalls = 0;
    const deps = baseDeps({ notifyInfo: () => { infoCalls += 1; } });

    await reportMergeOutcome(harness.services, deps, [], { merge: emptyMerge(), changedFiles: [] }, 'keep-local', 'Товары');

    assert.strictEqual(infoCalls, 0);
  });

  test('есть резервные копии (backups) — лог с перечислением путей', async () => {
    const harness = createHarness();
    const merge = { ...emptyMerge(), backups: [{ rel: 'Module.bsl', backupPath: '/tmp/backup/Module.bsl', projectPath: '/tmp/project/Module.bsl' }] };

    await reportMergeOutcome(harness.services, baseDeps(), [], { merge, changedFiles: [] }, 'replace', 'Товары');

    assert.ok(harness.outputLines.some((line) => line.includes('резервные копии') && line.includes('/tmp/backup/Module.bsl')));
  });
});
