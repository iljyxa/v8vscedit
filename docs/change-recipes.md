# Рецепты изменений — какие файлы трогать

Справочник для `architect`, `reviewer` и `documenter` (и для реализатора — в части, на которую ссылается
план). Раньше это был раздел «Инвариант изменений» корневого `CLAUDE.md`. Его вынесли сюда, потому что
`CLAUDE.md` загружается в каждый ход каждого агента, а рецепты нужны только при проектировании и ревью.
Архитектурные правила, запреты и центральные контракты остаются в [`CLAUDE.md`](../CLAUDE.md).

## Инвариант изменений — как добавлять функциональность

Для каждого сценария указано, какие файлы трогать. Если требуется править сверх списка — задача решается в другом слое.

- **Новый тип метаданных:** запись в `META_TYPES` → при спец-модуле `ModuleSlot` + карта в `MetaPathResolver` → при наборе свойств схема в `PROPERTY_SCHEMAS` → иконка `src/icons/{light,dark}/<icon>.svg` → при нестандартной сборке узла builder в `ui/tree/nodeBuilders/` → тест `ObjectXmlReader` на пример из `example/`.
- **Новый слот модуля (`ModuleSlot`):** литерал в `domain/ModuleSlot.ts` → путь в карте `MetaPathResolver` → при необходимости `OpenModuleCommandId` + команда → поле `modules` в записях `META_TYPES`.
- **Новый дочерний тег (`ChildTag`):** значение в `domain/ChildTag.ts` + `CHILD_TAG_CONFIG` → при своём контейнере расширить `ObjectXmlReader.parseChildren` → тег в `childTags` нужных `META_TYPES`.
- **Новый контейнерный дочерний тип со своими вложенными листьями** (паттерн ТЧ→Колонка; второй прецедент — HTTPСервис→URLШаблон→Метод, см. [mcp-paths.md](./mcp-paths.md#26-расширенные-примеры-путей) и [metadata-navigator.md](./metadata-navigator.md#контейнерные-дочерние-узлы-тчколонка-и-httpсервисurlшаблонметод)): контейнер и лист — обе отдельные записи `MetaKind`/`META_TYPES`/`ChildTag`; лист парсится в `MetaChild.columns` контейнера через `ObjectXmlReader.toXxxChild` (образец `toTabularSectionChild`) → имя родителя-контейнера пробрасывается ПАРАЛЛЕЛЬНЫМ полем контекста (`tabularSectionName`/`urlTemplateName`), а не переименованием существующего слота и не новым реестром → `domain/CanonicalNames.ts` (`canonicalChildPath`) обобщает контейнерную ветку по этому полю → узел дерева строится симметрично в ДВУХ источниках — `infra/cache/MetadataCache.ts` (webview) и `ui/tree/nodeBuilders/metaObjectTreeBuilder.ts` (нативный TreeView/свойства) → `infra/xml/XmlUtils.ts` получает nesting-aware `findXxxRangeInYyy`/`extractXxxXmlFromYyy` (образец `findColumnRangeInTabularSection`) → MCP add-инструмент для листа получает флаг-аналог `inTabularSection` (например `inUrlTemplate`) в `McpAddToolsRegistration.ts`, владелец — сам контейнер (`allowedOwnerKinds: ['<Контейнер>']`).
- **Новая схема свойств:** объект-схема в `PROPERTY_SCHEMAS` → при новом `PropertyValueKind` расширить `_types.ts` + `PropertyBuilder.ts`. Регулярки — только в `infra/xml/`.
- **Новое правило состава свойств типизированного поля** (какие теги `<Properties>` допустимы у
  реквизита/измерения/ресурса/колонки конкретного вида объекта-владельца, см.
  [xml-format-rulesets.md](./xml-format-rulesets.md#состав-свойств-типизированного-поля-по-виду-владельца)):
  правило регистра-владельца — запись в `REGISTER_FIELD_RULES` (`infra/xml/TypedFieldPropertyRules.ts`,
  снимается с эталона `example/`) → при новом управляемом ключе свойства — добавить его в
  `CONTROLLED_PROPERTY_KEYS` (позиция — по месту в `xs:sequence` схемы 1С, список остаётся единой
  надпоследовательностью всех наблюдаемых в эталонах порядков) → значение по умолчанию в
  `DEFAULT_VALUES` (или в `getFieldDefaultValues`, если оно зависит от `registerKind`) → тест на
  реальном объекте из `example/2.20`+`example/2.21` (запись через `normalizeTypedFieldPropertiesAfterTypeChange`,
  панель свойств через `getDisplayTypedFieldPropertyKeys`, `validate_metadata` с кодом
  `property-not-allowed`). **Состав задаёт ВИД ОБЪЕКТА-ВЛАДЕЛЬЦА** (корень XML-файла,
  `ObjectXmlReader.detectRootObjectKind`), **а не тип поля** (`<Type>`) — сужение по типу отдельная
  политика генератора (`getAllowedPropertyKeys` по `FieldTypeCategory`), не ограничение формата; для
  видов, правила которых ещё не сняты с эталона (пример — регистр расчёта), свойства владельца
  ТОЛЬКО сохраняются из исходного XML, а не дописываются «по умолчанию».
- **Новая команда:** класс в `ui/commands/...` с `readonly id` → регистрация в `CommandRegistry.registerAll` → `package.json → contributes.commands` → при меню узла `contributes.menus` c `when: viewItem =~ /…/` → при хоткее `contributes.keybindings`.
- **Новый builder узла:** `ui/tree/nodeBuilders/<имя>.ts` → регистрация в диспетчере `metaObjectTreeBuilder.ts`. XML — только через `parseObjectXml`/`ObjectXmlReader`.
- **Новая декорация узла:** класс в `ui/tree/decorations/` (реализует `vscode.FileDecorationProvider`) → регистрация в `Container.wireTreeView` → суффикс `contextValue` — только в `TreeNode`.
- **Новый view/webview:** класс в `ui/views/<Имя>ViewProvider.ts` (без XML/FS) → данные готовит отдельный сервис → создание и команда открытия через `Container`.
- **Новый сервис инфры:** класс в `infra/<подпапка>/<Имя>Service.ts` без `vscode`, `Logger` через конструктор → создать в `Container.bootstrap` → тест на пример из `example/`.
- **Новая возможность LSP:** встроенных провайдеров нет; completion/hover/diagnostics добавляются в `bsl-analyzer`, здесь проверяется только интеграция `LspManager`.
- **Новая настройка:** `package.json → contributes.configuration.properties` с префиксом `v8vscedit.<область>.<ключ>`, `description` на русском → читать только через `vscode.workspace.getConfiguration('v8vscedit')` в UI/Container → при рантайм-влиянии подписка на `onDidChangeConfiguration`.
- **Новый watcher:** `FileSystemWatcher` — только в `Container` или `ui/support/`; обработчик делегирует в сервис.
- **Внешняя интеграция (vrunner):** запуск процесса в `ui/commands/ext/`; декодирование OEM/Win1251 через `iconv-lite`; прогресс/отмена через `vscode.window.withProgress`.
- **Новая операция чтения данных из базы через пакетный Конфигуратор** (данных, которых нет в
  XML-выгрузке — список/состояние; образец — список подключённых расширений для
  `v8vscedit.connectExtension`): CLI-команда `cli/commands/<name>.ts` с гейтом по `exitCode` процесса
  (не по тексту лога) и передачей результата через `-ResultFile` (не marker-блок в stdout — избегает
  порчи данных построчным `LineBufferedDecoder`) → чистый парсер в `infra/<область>/<Name>Parser.ts` без
  `vscode`/spawn (снятие BOM, разбор строк, при необходимости — чистая функция выбора для UI) → тонкая
  UI-обёртка `ui/commands/.../*CommandRunner.ts` (спавн CLI + чтение `-ResultFile`, `undefined` при
  недоступности) → диалог без ручного fallback-ввода: при `undefined`/пустом/полностью исчерпанном
  списке — явные `showErrorMessage`/`showInformationMessage` по причине и отмена операции, без
  переключения на ручной ввод значения пользователем. Подробности и обоснование —
  [architecture.md](./architecture.md#паттерн-чтение-данных-из-базы-через-пакетный-конфигуратор-file-handoff).
- **Открытие BSL-модулей:** только реальные `file://` документы (виртуальная схема `onec://` удалена). Readonly — через `ui/readonly/BslReadonlyGuard.ts`.
- **Новая операция хранилища, меняющая файлы проекта** (аналог `repository.lock`/`update`/`unlock`/`commit`,
  см. [repository-file-sync.md](./repository-file-sync.md)): поток в `ui/commands/repository/*Sync.ts`
  с внешними точками через `RepositoryFileSyncDeps` → занятость guard'а проверяется
  (`ensureRepositoryGuardFree`) до первого диалога → ОДНА аренда `runExclusive` только на CLI хранилища,
  `applyLock`/`applyUnlock` и выгрузку во временный каталог (`runDumpRounds`) → слияние
  (`RepositoryMergePlanner`/`Applier`), модальные диалоги и диффы — после аренды → выгрузка никогда не пишется
  прямо в проект, имена подчинённых объектов в `-listFile` берутся только из источника, соответствующего базе
  (несуществующее имя роняет всю выгрузку) → новый вид подчинённого объекта с собственным XML — запись в
  `SUBORDINATE_OBJECT_FOLDERS` (`infra/fs/SubordinateObjectLayout.ts`, единственный источник подкаталогов
  подчинённых, из него читают и `REPOSITORY_SUBORDINATE_LAYOUT` в `RepositoryObjectNames.ts`, и
  `SupportInfoService`), а не новый словарь → тест на копии реальной фикстуры с имитацией платформы
  `src/test/suite/support/partialDumpFixture.ts`.
- **Новая операция, запускающая Конфигуратор для полного импорта/обновления/применения конфигурации к
  базе** (аналог `importConfigurations`/`updateChangedConfigurations`/`runPostRepositorySync`): захват —
  через `services.configurationOperationGuard` (`runExclusive(title, op)` для одной атомарной цепочки
  либо `tryAcquire(title)` + `release()` в `finally`, если между проверкой и запуском есть модальный
  диалог, тогда отказ отдаётся вызовом `tryAcquireOrHeldBy(title)` — единая точка, сразу возвращающая
  `heldBy` держателя) → сообщение о занятости — только `notifyConfigurationOperationBusy`
  (`ui/commands/ext/configurationOperationBusy.ts`), **без `await`** (см. запрет №18) → фоновый (`void`)
  путь без ожидающего пользователя логирует исход в `outputChannel` и уведомляет тем же способом, а не
  падает молча → контекст enablement `v8vscedit.isUpdatingConfigurations` вручную нигде не выставлять —
  его синхронизирует только `Container.wireConfigurationOperationContext()` подпиской на
  `guard.onDidChangeBusy` → модальные диалоги подтверждения по возможности держать ВНЕ аренды (проверка
  занятости — до диалога, повторный захват — после) → runner'ы Конфигуратора и диалоги внедряются через
  `deps`-объект по умолчанию (образец — `RepositoryDatabaseSync.ts`/`RepositoryDatabaseSyncDeps`), чтобы
  логику захвата можно было протестировать без реального процесса 1С → **если команда доступна MCP-мосту
  `v8vscedit_execute_command`** (`V8McpServer`/`McpConfigLifecycleTools.ts`), она обязана на КАЖДОМ пути
  возвращать `ConfigurationCommandOutcome` (`ui/commands/ext/configurationCommandOutcome.ts`:
  `done`/`no-changes`/`no-targets`/`cancelled`/`busy`/`failed`), а при занятости — `{ status: 'busy',
  heldBy }`; мост транслирует этот исход как есть и НЕ опрашивает guard заранее (второй источник правды +
  TOCTOU между проверкой и запуском команды). Подробности —
  [architecture.md](./architecture.md#сериализация-операций-конфигуратора-с-базой-configurationoperationguard).
- **Изменение жизненного цикла/безопасности встроенного MCP-сервера** (порт, идентичность процесса,
  graceful shutdown, Host/Origin, отличается от «новый MCP-инструмент» из раздела выше): чистая логика —
  в `infra/mcp/` (`McpServerIdentity`, `McpStartDecision`, `McpPortProbe`, `McpConflictPrompt`, `McpHost`,
  без `vscode`) → тонкий адаптер конкретного эндпоинта/диалога — `ui/mcp/V8McpServer.ts` (HTTP-роутинг,
  служебные `/identity`+`/shutdown` — не MCP-инструменты) и `Container` (чтение настроек `v8vscedit.mcp.*`,
  показ диалога конфликта порта). См. [mcp-server-lifecycle.md](./mcp-server-lifecycle.md).
- **Новая часть объекта в панели «Изменения метаданных»** (`MetadataPartKind`, см.
  [git-metadata-changes.md](./git-metadata-changes.md)): случай в
  `infra/git/MetadataChangeResolver.ts` (`resolveSubPath`/дизамбигуация слота через
  `META_TYPES[kind].modules`) → при новом варианте схлопывания статуса — `combineStatus` в
  `infra/git/MetadataChangeAggregator.ts` → метка/статус ЛИСТА в
  `ui/views/changes/changesDtoBuilder.ts` (`partLabelOf`/`toGitStatus`, функции `buildObjectNode`/
  `buildPartNode`; навигаторную иерархию НАД листом строит `changesTreeAssembler.ts` +
  `MetadataChangesViewProvider.resolveAncestors`, этот слой не трогается для новой части) → тест на
  реальном временном git-репозитории (образец — `support/changesFixtures.ts`). Каноничный путь владельца
  — только через `domain/CanonicalNames.ts` (`canonicalRootPath`), не новый форматтер.
- **Новая git-мутация над панелью изменений** (аналог stage/unstage/discard/commit): движок — функция
  в `infra/git/GitWriteService.ts` (без `vscode`) → действие подключается веткой в
  `MetadataChangesViewProvider.handleMessage` (значение `command` протокола) → то же значение `command`
  добавляется на стороне ui в `src-ui/apps/changes/ChangesApp.vue` (пункт контекстного меню узла и/или
  кнопка в `ChangesCommitBox.vue`) → узлы для действия строит `changesDtoBuilder` из `ChangesModel`
  (`resolveChangeAddress` — единственное место, расшифровывающее `nodeId` обратно в файлы). Никаких
  команд `package.json → contributes.commands`/меню `view/item/context` для этой панели не заводится —
  весь UI-контракт живёт во внутреннем протоколе webview (см.
  [git-metadata-changes.md](./git-metadata-changes.md#формат-сообщений-протокола)).
- **Новый триггер обновления панели изменений/декораций по git-событию** (аналог Git Extension API):
  чистый селектор репозитория — `infra/git/GitRepositorySelector.ts` (без `vscode`) → тонкий наблюдатель
  поверх события — `ui/git/` (образец `GitStateObserver.ts` + типовой фасад `gitExtensionApi.ts`) →
  подключение в `Container` (образец `wireGitStateWatcher()`), с обязательным fallback fs-вотчером на
  случай недоступности источника → единственный выход обоих триггеров —
  `Container.scheduleDecorationRefresh()` (не заводить параллельный debounce/refresh-путь). См.
  [git-metadata-changes.md](./git-metadata-changes.md#триггеры-обновления-панели-и-декораций-git-extension-api--fallback-fs-вотчер).
- **Новая возможность блока «История»** (граф git-коммитов внутри панели «Изменения метаданных», НЕ
  отдельная вкладка/провайдер, см. [git-history-graph.md](./git-history-graph.md)), в зависимости от
  слоя:
  - новая колонка/поле графа (например автор-аватар, статус CI) — `RawCommit`/`GitLogParser` (если
    берётся из `git log`) → `GraphRowDto` в `ui/views/history/historyGraphDtoBuilder.ts` →
    `src-ui/shared/types/history.ts` (зеркало) → отрисовка в `src-ui/apps/changes/CommitGraph.vue`;
  - новая команда протокола (аналог `selectCommit`/`openCommitDiff`/`historyLoadMore`/`historyRefresh`) —
    `MetadataChangesViewProvider.handleMessage` (ветка `switch (message.command)`) → та же строка
    `command` добавляется в `src-ui/apps/changes/ChangesApp.vue` (`sendCommand`); чистая бизнес-логика
    команды — в `historyGraphController.ts`/`ChangesHistorySection` (`ui/views/changes/
    changesHistorySection.ts`), а не в самом провайдере;
  - изменение алгоритма раскладки дорожек — только `infra/git/GitGraphLayout.ts` (чистая функция без
    `vscode`), тест на реальном временном git-репозитории с ветвлением/merge (образец —
    `support/changesFixtures.ts:buildHistoryRepo`);
  - новое поле/метод состояния графа (пагинация, выбор коммита) — `ChangesHistorySection`
    (`ui/views/changes/changesHistorySection.ts`), а не поля самого `MetadataChangesViewProvider` —
    провайдер остаётся тонким диспетчером команд поверх этого helper'а;
  - новая часть/статус объекта в дереве изменений коммита переиспользует ТОТ ЖЕ путь, что и панель
    изменений (см. пункт выше «Новая часть объекта в панели «Изменения метаданных»»), т.к.
    `buildCommitChangesSection` вызывает те же `buildObjectNode`/`buildPartNode`/`synthesizeAncestors` —
    отдельного реестра для блока истории не заводится.
- **Декомпозиция God-класса (косметика, без изменения поведения):** characterization/байт-golden-тест ДО дробления (фиксирует текущий выход) → вынос по доменам/ответственности в подпапку того же слоя (`ui/mcp/registration/`, `infra/xml/<область>/`) через `git mv`/перенос функций без изменения публичного API фасада → диспетчер-`switch` → таблица (данные в `META_TYPES`/спец-реестр infra, поведение — функции поверх) → эталоны golden при этом НЕ редактируются: их правка означает регресс поведения, а не косметику. Для XML-генераторов (`MetadataXmlCreator`, `FormBuilders`) байт-golden обязателен как входное условие (см. `CLAUDE.md`, запрет №17).

## Перенос новой функции из скилов в расширение

1. Бизнес-логику — в `infra/<область>/<Service>.ts` без `vscode` и shell.
2. Тест на реальных XML-фикстурах или временной структуре выгрузки.
3. Если нужно человеку в UI — команда в `ui/commands/**` + действие в `UniversalPanelViewProvider.getNodeActions()`.
4. Если меняет конфигурацию/расширение — MCP-инструмент в `V8McpServer.registerTools()` + запись в `EXTENSION_MCP_TOOLS`.
5. Обновить кэш/дерево/статус через общий post-mutation путь.
