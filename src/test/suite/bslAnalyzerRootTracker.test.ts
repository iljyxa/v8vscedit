import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConfigEntry } from '../../domain/Configuration';
import { findConfigurations } from '../../infra/fs/ConfigLocator';
import {
  BslAnalyzerRootTracker,
  decideBslAnalyzerRestart,
  hasMainConfiguration,
  type BslAnalyzerRestartReason,
} from '../../infra/environment/BslAnalyzerRootTracker';

/**
 * bsl-analyzer ищет конфигурацию один раз при старте. Если основной выгрузки
 * `src/cf` ещё нет, он индексирует всю рабочую область (включая `.v8vscedit/**`), поэтому
 * появление основной конфигурации должно перезапускать сервер. Записи конфигураций берутся
 * настоящим `findConfigurations` по временной рабочей области с `Configuration.xml` в форме выгрузки.
 */

function configurationXml(version: string, extension: boolean): string {
  const purpose = extension ? '\n\t\t\t<ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose>' : '';
  return `\ufeff<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="${version}">\n`
    + `\t<Configuration uuid="00000000-0000-0000-0000-000000000001">\n\t\t<Properties>\n\t\t\t<Name>${extension ? 'EVOLC' : 'Основная'}</Name>${purpose}\n`
    + '\t\t</Properties>\n\t\t<ChildObjects/>\n\t</Configuration>\n</MetaDataObject>';
}

interface Workspace {
  readonly root: string;
  readonly addMain: () => void;
  readonly removeMain: () => void;
  readonly addExtension: () => void;
  readonly entries: () => ConfigEntry[];
}

for (const version of ['2.20', '2.21']) {
  suite(`BslAnalyzerRootTracker — перезапуск bsl-analyzer при появлении src/cf (формат ${version})`, () => {
    const roots: string[] = [];

    function makeWorkspace(): Workspace {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-bsl-root-'));
      roots.push(root);
      const cfDir = path.join(root, 'src', 'cf');
      const cfeDir = path.join(root, 'src', 'cfe', 'EVOLC');
      fs.mkdirSync(cfDir, { recursive: true });
      fs.mkdirSync(cfeDir, { recursive: true });
      return {
        root,
        addMain: () => fs.writeFileSync(path.join(cfDir, 'Configuration.xml'), configurationXml(version, false), 'utf-8'),
        removeMain: () => fs.rmSync(path.join(cfDir, 'Configuration.xml')),
        addExtension: () => fs.writeFileSync(path.join(cfeDir, 'Configuration.xml'), configurationXml(version, true), 'utf-8'),
        entries: () => findConfigurations(root),
      };
    }

    teardown(() => {
      for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    function entriesFor(state: 'empty' | 'cf' | 'cfe' | 'cf+cfe'): ConfigEntry[] {
      const workspace = makeWorkspace();
      if (state === 'cf' || state === 'cf+cfe') {
        workspace.addMain();
      }
      if (state === 'cfe' || state === 'cf+cfe') {
        workspace.addExtension();
      }
      const entries = workspace.entries();
      const expectedCount = { empty: 0, cf: 1, cfe: 1, 'cf+cfe': 2 }[state];
      assert.strictEqual(entries.length, expectedCount, `фикстура ${state} должна давать ${String(expectedCount)} записей`);
      return entries;
    }

    const hasMainCases: { state: 'empty' | 'cf' | 'cfe' | 'cf+cfe'; expected: boolean }[] = [
      { state: 'empty', expected: false },
      { state: 'cfe', expected: false },
      { state: 'cf', expected: true },
      { state: 'cf+cfe', expected: true },
    ];
    for (const item of hasMainCases) {
      test(`hasMainConfiguration: ${item.state} → ${String(item.expected)}`, () => {
        assert.strictEqual(hasMainConfiguration(entriesFor(item.state)), item.expected);
      });
    }

    const decideCases: {
      previous: boolean | undefined;
      state: 'empty' | 'cf' | 'cfe' | 'cf+cfe';
      lspEnabled: boolean;
      restart: boolean;
      reason: BslAnalyzerRestartReason;
    }[] = [
      { previous: undefined, state: 'empty', lspEnabled: true, restart: false, reason: 'initial' },
      { previous: undefined, state: 'cf', lspEnabled: true, restart: false, reason: 'initial' },
      { previous: undefined, state: 'cf', lspEnabled: false, restart: false, reason: 'initial' },
      { previous: false, state: 'empty', lspEnabled: true, restart: false, reason: 'main-configuration-missing' },
      { previous: false, state: 'cfe', lspEnabled: true, restart: false, reason: 'main-configuration-missing' },
      { previous: true, state: 'empty', lspEnabled: true, restart: false, reason: 'main-configuration-missing' },
      { previous: true, state: 'cf', lspEnabled: true, restart: false, reason: 'main-configuration-unchanged' },
      { previous: true, state: 'cf+cfe', lspEnabled: true, restart: false, reason: 'main-configuration-unchanged' },
      { previous: false, state: 'cf', lspEnabled: false, restart: false, reason: 'lsp-disabled' },
      { previous: false, state: 'cf', lspEnabled: true, restart: true, reason: 'main-configuration-appeared' },
    ];
    for (const item of decideCases) {
      test(`decideBslAnalyzerRestart: было ${String(item.previous)}, стало ${item.state}, LSP ${item.lspEnabled ? 'вкл' : 'выкл'} → ${item.reason}`, () => {
        assert.deepStrictEqual(
          decideBslAnalyzerRestart(item.previous, entriesFor(item.state), item.lspEnabled),
          { restart: item.restart, reason: item.reason }
        );
      });
    }

    function observeSequence(
      workspace: Workspace,
      steps: { mutate?: () => void; lspEnabled: boolean }[]
    ): { restart: boolean; reason: BslAnalyzerRestartReason }[] {
      const tracker = new BslAnalyzerRootTracker();
      return steps.map((step) => {
        step.mutate?.();
        return tracker.observe(workspace.entries(), step.lspEnabled);
      });
    }

    test('трекер: пусто → initial, появилась cf → перезапуск, повтор → без перезапуска', () => {
      const workspace = makeWorkspace();
      assert.deepStrictEqual(
        observeSequence(workspace, [
          { lspEnabled: true },
          { mutate: workspace.addMain, lspEnabled: true },
          { lspEnabled: true },
        ]),
        [
          { restart: false, reason: 'initial' },
          { restart: true, reason: 'main-configuration-appeared' },
          { restart: false, reason: 'main-configuration-unchanged' },
        ]
      );
    });

    test('трекер: cf удалена → missing, возвращена → перезапуск', () => {
      const workspace = makeWorkspace();
      workspace.addMain();
      assert.deepStrictEqual(
        observeSequence(workspace, [
          { lspEnabled: true },
          { mutate: workspace.removeMain, lspEnabled: true },
          { mutate: workspace.addMain, lspEnabled: true },
        ]),
        [
          { restart: false, reason: 'initial' },
          { restart: false, reason: 'main-configuration-missing' },
          { restart: true, reason: 'main-configuration-appeared' },
        ]
      );
    });

    test('трекер: cf появилась при выключенном LSP → снимок обновлён, после включения перезапуска нет', () => {
      const workspace = makeWorkspace();
      assert.deepStrictEqual(
        observeSequence(workspace, [
          { lspEnabled: true },
          { mutate: workspace.addMain, lspEnabled: false },
          { lspEnabled: true },
        ]),
        [
          { restart: false, reason: 'initial' },
          { restart: false, reason: 'lsp-disabled' },
          { restart: false, reason: 'main-configuration-unchanged' },
        ]
      );
    });

    test('трекер: к cf добавилось расширение → без перезапуска', () => {
      const workspace = makeWorkspace();
      workspace.addMain();
      assert.deepStrictEqual(
        observeSequence(workspace, [
          { lspEnabled: true },
          { mutate: workspace.addExtension, lspEnabled: true },
        ]),
        [
          { restart: false, reason: 'initial' },
          { restart: false, reason: 'main-configuration-unchanged' },
        ]
      );
    });
  });
}
