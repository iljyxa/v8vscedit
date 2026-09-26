# Раскладка каталогов `src/`

Подробная карта исходников. Краткая версия и правила слоёв — в [`CLAUDE.md`](../CLAUDE.md#архитектура);
рецепты «какие файлы трогать» — [change-recipes.md](./change-recipes.md).

```
src/
├── extension.ts                      # тонкий activate/deactivate → делегирует Container
├── Container.ts                      # composition root: собирает сервисы, регистрирует команды/watcher/view
│
├── domain/                           # Чистый домен — НЕ импортирует vscode, fs, path
│   ├── MetaTypes.ts                  # Единый реестр META_TYPES: Record<MetaKind, MetaTypeDef>
│   ├── ChildTag.ts                   # Теги дочерних элементов + CHILD_TAG_CONFIG
│   ├── ModuleSlot.ts                 # Слоты модулей: 'Object'|'Manager'|'Form'|'Command'|…
│   ├── Configuration.ts              # ConfigInfo, ConfigEntry, ChildObjectsMap
│   ├── MetaObject.ts                 # MetaObject, MetaChild (результат парсинга XML объекта)
│   ├── StandardAttribute.ts          # стандартные реквизиты по видам
│   └── Ownership.ts                  # «свой/заимствованный» по namePrefix для CFE
│
├── infra/                            # ФС, XML, окружение, git, хранилище, CFE, роли; vscode не импортировать
│   ├── xml/                          # ридеры/эдиторы XML
│   │   ├── ConfigXmlReader.ts        # парсер Configuration.xml
│   │   ├── ObjectXmlReader.ts        # парсер XML объекта + updateType/updateProperty
│   │   ├── PropertySchema.ts         # декларативные схемы свойств по MetaKind
│   │   ├── TypedFieldPropertyRules.ts# свойства типизированных полей по типу
│   │   ├── XmlUtils.ts               # extract*, экранирование, writeTextFilePreservingBomAndEol
│   │   ├── ConfigurationXmlEditor.ts # редактирование Configuration.xml
│   │   ├── MetadataXmlCreator.ts     # создание новых XML-объектов метаданных
│   │   ├── MetadataXmlRemover.ts     # удаление XML-объектов метаданных
│   │   └── format/                   # ruleset формата сериализации (см. docs/xml-format-rulesets.md)
│   │       ├── FormatRuleset.ts      # интерфейс правил генерации одного поколения формата
│   │       ├── baselineRuleset.ts    # правила текущего формата (2.21)
│   │       └── formatRegistry.ts     # реестр «версия → ruleset» + version-guard
│   ├── fs/
│   │   ├── ConfigLocator.ts          # рекурсивный поиск Configuration.xml
│   │   ├── MetaPathResolver.ts       # единый resolver: XML + все модули по ModuleSlot
│   │   ├── ConfigurationCleanWindow.ts # окно тишины по корню конфигурации после
│   │   │                              # импорта/обновления БД (Container.markConfigurationsClean,
│   │   │                              # см. docs/architecture.md)
│   │   ├── SubordinateObjectLayout.ts # единственный источник подкаталогов подчинённых со своим XML
│   │   │                              # (Forms/Templates/Recalculations/Tables/Cubes/DimensionTables/
│   │   │                              # Subsystems) — используют RepositoryObjectNames и SupportInfoService
│   │   └── AtomicFileWrite.ts        # writeFileAtomicSync — общая атомарная запись
│   │                                  # служебных кэшей (tmp+rename), см. cache/ ниже
│   ├── cfe/                          # расширения: CfeBorrowService, CfeDiffService, CfePatchMethodService
│   ├── support/                      # SupportInfoReader/Service (ParentConfigurations.bin), Logger,
│   │                                  # PerfLog — формат строк замера `[perf]` (docs/architecture.md)
│   ├── cache/                        # MetadataCache, hashCache (CLI), FileStatIndex — stat-индекс
│   │                                  # рабочего дерева (ускоритель ConfigurationChangeDetector, не
│   │                                  # источник правды), см. docs/architecture.md
│   ├── repository/                   # хранилище 1С: RepositoryService (фасад), RepositoryLockState
│   │                                  # (state.json), RepositoryLockSnapshotStore (снимки), единицы
│   │                                  # хранилища и области (RepositoryObjectNames/Scope), раунды
│   │                                  # выгрузки (RepositoryDumpPlan/Rounds), трёхстороннее слияние
│   │                                  # (RepositoryMergePlanner/Applier), очистка временных артефактов
│   │                                  # (RepositoryTempCleanup) — см. docs/repository-file-sync.md
│   ├── git/                          # статус Git для узлов метаданных (GitMetadataStatusService,
│   │                                  # декорации) + представление «Изменения метаданных»
│   │                                  # (GitPorcelainReader, MetadataChangeResolver,
│   │                                  # MetadataChangeAggregator, GitBlobReader, GitStatusReader,
│   │                                  # GitWriteService — см. docs/git-metadata-changes.md) +
│   │                                  # чистое ядро графа истории (GitLogReader, GitLogParser,
│   │                                  # GitGraphLayout, GitCommitChangesReader — см.
│   │                                  # docs/git-history-graph.md; граф — сворачиваемый блок панели
│   │                                  # «Изменения метаданных», отдельного webview/вкладки нет)
│   ├── environment/                  # bsl-analyzer.toml, окружение проекта, реестр баз
│   ├── process/                      # поиск платформы, spawn, декодер OEM/Win1251,
│   │                                  # ConfigurationOperationGuard — единая блокировка
│   │                                  # полного импорта/обновления/применения конфигурации
│   │                                  # к базе в пределах одного окна (см. docs/architecture.md)
│   ├── mcp/                          # McpServerIdentity/McpStartDecision/McpPortProbe/
│   │                                  # McpConflictPrompt/McpHost — чистая логика жизненного цикла
│   │                                  # встроенного MCP-сервера (bind/reuse/conflict, закрытие порта),
│   │                                  # без vscode; см. docs/mcp-server-lifecycle.md
│   └── skills/                       # AiSkillsInstaller — установка ИИ-навыков
│
├── ui/                               # Всё, что знает про vscode API
│   ├── tree/                         # MetadataTreeProvider (тонкий), TreeNode, nodeBuilders/, decorations/
│   ├── views/                        # webview-провайдеры
│   │   ├── universal/                # UniversalPanelViewProvider — ОСНОВНОЙ UI навигатора
│   │   ├── properties/               # PropertyBuilder по PropertySchema
│   │   ├── changes/                  # changesDtoBuilder (листья, чистый) + changesTreeAssembler
│   │   │                              # (сборка навигаторной иерархии секции, чистый) +
│   │   │                              # changesHistorySection (чистый helper состояния блока
│   │   │                              # «История» поверх views/history/*, см. ниже) +
│   │   │                              # MetadataChangesViewProvider (ЕДИНСТВЕННЫЙ webview-провайдер
│   │   │                              # v8vsceditChanges — панель с ДВУМЯ сворачиваемыми блоками
│   │   │                              # «Изменения»/«История»; дерево «Изменения» повторяет иерархию
│   │   │                              # навигатора через treeProvider; см. docs/git-metadata-changes.md
│   │   │                              # и docs/git-history-graph.md)
│   │   ├── history/                  # ТОЛЬКО чистые модули (без vscode): historyGraphDtoBuilder/
│   │   │                              # historyGraphController — read-only переиспользование движка
│   │   │                              # changes/; см. docs/git-history-graph.md
│   │   └── subsystem|search|repository|environment|standalone|…
│   ├── commands/                     # CommandRegistry.registerAll + подпапки по доменам
│   ├── git/                          # OnecGitContentProvider — схема onec-git для diff HEAD/индекс
│   ├── mcp/                          # V8McpServer (тонкий HTTP-фасад: транспорт MCP, служебные
│   │                                  # эндпоинты /identity+/shutdown — не MCP-инструменты,
│   │                                  # см. docs/mcp-server-lifecycle.md), McpNodeRegistry,
│   │                                  # McpPropertyService
│   └── readonly/                     # BslReadonlyGuard, EditorReadonlyController (readonly открытых
│                                      # вкладок по захвату), sessionReadonly.ts + readonlyTabSelection.ts
│                                      # (readonly-команда VS Code действует только на правую сторону
│                                      # активного редактора — выбор маршрута для левой file:-стороны
│                                      # diff), readonlyTransitionPlan.ts (чистый план, без vscode)
│
├── lsp/                              # LspManager + analyzer/ (внешний bsl-analyzer; встроенного сервера нет)
├── cli/                             # Node entry onec-tools.ts + commands/ + core/ (адаптеры)
└── test/                            # runTests.ts + suite/
```

`cli/` — отдельный потребитель `domain/` и `infra/`. Если код нужен и расширению, и CLI — он живёт в `infra/<подпапка>/`, а `cli/core/*` даёт тонкий re-export.

## Webview (`src-ui/`)

Vue-приложения (сборка `vite.webview.config.ts`, проверка типов `vue-tsc`/`tsconfig.ui.json`). `src-ui/apps/*` — отдельные панели (`universal`, `dynamic-panel`, `environment`, `subsystem`, `repository-*`, `standalone`, `ai`, `tree-search`, `changes` — панель «Изменения метаданных»: ДВА сворачиваемых блока — «Изменения» (SCM-шапка + дерево, повторяющее навигаторную иерархию, обрезанную по изменениям) и «История» (граф git-коммитов `CommitGraph.vue` с inline-раскрытием коммита: детали + дерево изменений через общий `UniversalTree`, read-only, ленивая загрузка при первом раскрытии, см. `docs/git-history-graph.md`); отдельного приложения `apps/history` больше нет — граф целиком часть `apps/changes`). `src-ui/shared/` — общий код: `protocol/` (контракт сообщений webview ↔ расширение), `state/`, `components/` (в т.ч. `components/tree/UniversalTree*.vue` — дерево, общее для навигатора и панели изменений, включая её блок истории), `api/`. При изменении взаимодействия панели и расширения правьте обе стороны протокола.
