# Архитектура расширения 1С: Редактор конфигураций

## Назначение

VSCode-расширение `v8vscedit` предоставляет два независимых блока:

1. **[Навигатор метаданных](./metadata-navigator.md)** — дерево объектов конфигураций и расширений из XML-выгрузки.
2. **[Языковая поддержка BSL](./bsl-language-support.md)** — LSP-клиент для внешнего `bsl-analyzer`.

Дополнительно — независимая webview-панель **[«Изменения метаданных»](./git-metadata-changes.md)**
(`v8vsceditChanges`): `git status` рабочей копии в терминах объектов метаданных, с полноценными
git-операциями (stage/unstage/discard/commit/diff); дерево панели повторяет навигаторную иерархию
основного дерева конфигурации (обрезанную по изменениям), переиспользуя и Vue-компонент отрисовки,
и саму структуру `MetadataTreeProvider`.

Внутри той же панели — второй сворачиваемый блок **[«История»](./git-history-graph.md)**: граф
git-коммитов всего репозитория (свёрнут по умолчанию, грузится лениво при первом раскрытии), где выбор
коммита раскрывает inline изменённые объекты метаданных того же коммита — read-only потребитель движка
панели изменений (`aggregateMetadataChanges`, `changesDtoBuilder`, `changesTreeAssembler`), с собственным
чистым ядром раскладки графа по дорожкам (`infra/git/GitLogReader`, `GitLogParser`, `GitGraphLayout`) и
тонким чистым helper'ом состояния (`ui/views/changes/changesHistorySection.ts`), которым владеет тот же
`MetadataChangesViewProvider` — отдельного webview-провайдера/вкладки/команды для истории нет.

## Структура модулей

```
src/
├── extension.ts                      # тонкий activate/deactivate
├── Container.ts                      # composition root
├── domain/                           # чистый домен без vscode/fs/path
├── infra/                            # файловая система, XML, окружение, хранилище, git/, mcp/
│   ├── mcp/                          # McpServerIdentity/McpStartDecision/McpPortProbe/
│   │                                  # McpConflictPrompt/McpHost — чистая логика жизненного цикла
│   │                                  # встроенного MCP-сервера (без vscode), см.
│   │                                  # docs/mcp-server-lifecycle.md
│   └── git/                          # GitMetadataStatusService (декорации навигатора) +
│                                      # GitPorcelainReader/MetadataChangeResolver/
│                                      # MetadataChangeAggregator/GitBlobReader/GitStatusReader/
│                                      # GitWriteService (движок панели «Изменения метаданных») +
│                                      # GitLogReader/GitLogParser/GitGraphLayout/
│                                      # GitCommitChangesReader (чистое ядро блока «История»,
│                                      # см. docs/git-history-graph.md)
├── ui/                               # команды, дерево, webview, readonly guard
│   ├── views/changes/                # changesDtoBuilder (листья дерева) + changesTreeAssembler
│   │                                  # (сборка навигаторной иерархии секции) + changesHistorySection
│   │                                  # (чистый helper состояния блока «История» поверх
│   │                                  # historyGraphController/historyGraphDtoBuilder) +
│   │                                  # MetadataChangesViewProvider (единственный webview-провайдер
│   │                                  # v8vsceditChanges — строит цепочки предков через
│   │                                  # treeProvider.getParent на реальном MetadataTreeProvider и
│   │                                  # диспетчеризует команды блока «История»)
│   ├── views/history/                # ТОЛЬКО чистые модули (без vscode): historyGraphDtoBuilder/
│   │                                  # historyGraphController — см. docs/git-history-graph.md
│   └── git/                          # OnecGitContentProvider (схема onec-git для diff HEAD/индекс
│                                      # и произвольного commit-ish для блока «История»)
├── lsp/
│   ├── LspManager.ts                 # запуск и перезапуск bsl-analyzer
│   └── analyzer/
│       ├── BslAnalyzerService.ts     # установка, обновление, путь к бинарнику
│       └── BslAnalyzerStatusBar.ts   # индикатор состояния
└── test/
```

Встроенного LSP-сервера в `src/lsp/server` нет. Языковые возможности
предоставляет только внешний процесс `bsl-analyzer lsp`.

### Декомпозиция God-классов на тонкий фасад + подмодули

Правило зафиксировано в `CLAUDE.md` (раздел «Инвариант изменений» → «Декомпозиция
God-класса», запрет №17): большой класс дробится на тонкий фасад/барель + набор
файлов-подмодулей по ответственности **в подпапке того же слоя**, публичный API и
поведение не меняются байт-в-байт. Для XML-генераторов обязателен предварительный
байт-golden-тест как входное условие рефакторинга.

Реализованные образцы паттерна:

- `ui/mcp/V8McpServer.ts` (фасад, только HTTP-транспорт/сессии/Host-Origin-защита)
  + `ui/mcp/registration/*` — регистрация MCP-инструментов по доменам
  (`McpNavigationTools`, `McpConfigInfoTools`, `McpTemplateTools`,
  `McpExternalObjectTools`, `McpFormTools`, `McpSubsystemTools`, `McpRoleTools`,
  `McpConfigLifecycleTools`, `McpPropertyTools`) + `McpMutationGate` (общий
  post-mutation шлюз и формат-хелперы ответов) + `McpRegistrationDeps` (контракт
  зависимостей, разделяемых всеми доменными модулями).
- `infra/xml/MetadataXmlCreator.ts` (фасад) + `infra/xml/creator/*`
  (`creatorShared`, `rootObjectBuilders`, `auxiliaryFileBuilders`,
  `childElementBuilders`) — построение корневых XML-объектов, вспомогательных
  файлов и дочерних элементов метаданных.
- `infra/xml/ExternalObjectService.ts` (фасад) + `infra/xml/external/*`
  (`externalObjectShared`, `externalObjectXml`, `bspRegistration`,
  `externalObjectFiles`, `externalObjectValidation`) — работа с EPF/ERF.
- `infra/xml/DataCompositionSchemaService.ts` (фасад) + `infra/xml/dcs/*`
  (`dcsShared`, `schemaParse`, `schemaBuilders`, `editOperations`) — СКД.
- `infra/xml/form/FormBuilders.ts` (реэкспорт-барель) + `infra/xml/form/builders/*`
  (`formBuilderShared`, `formElements`, `formAttributes`, `formCommands`,
  `formDocument`) — построение XML управляемых форм.
- `ui/views/properties/PropertyBuilder.ts` (фасад) + `propertyKeyOrder.ts`
  (порядок ключей свойств корневых объектов) + `propertyExtractors.ts`
  (XML-экстракторы и форматтеры значений).
- `ui/views/properties/PropertiesViewController.ts` + `propertyEditLock.ts`
  (резолвер блокировки редактирования) + `propertyNodeClassification.ts`
  (классификация и snapshot узлов).

Во всех случаях `switch` по `MetaKind`/виду объекта, где он был, оставлен как есть
(это диспетчер поведения, а не реестр данных) — декомпозиция не подменяла его
таблицей, это отдельная задача при появлении настоящего дублирования данных.

### Паттерн: чтение данных из базы через пакетный Конфигуратор (file-handoff)

Когда UI-команде нужны данные, которых нет в XML-выгрузке, а есть только в самой
базе 1С (пример — список расширений, уже подключённых к базе, для команды
`v8vscedit.connectExtension`), связка устроена в три слоя:

1. **CLI-команда** (`cli/commands/<name>.ts`, образец — `listDbExtensions.ts`)
   запускает пакетный Конфигуратор с нужным ключом (`/DumpDBCfgList
   -AllExtensions`) и `/Out <tmp>`, затем **только при успешном завершении
   (`exitCode === 0`)** переносит результат во входной `-ResultFile`, который
   передаёт вызывающая сторона. Гейт разбора — **код возврата процесса, а не
   содержимое лога**: при ошибке (платформа старее той, что понимает флаг;
   недоступная база) `-ResultFile` не создаётся, и вызывающая сторона узнаёт о
   сбое по его отсутствию, не пытаясь угадывать причину по тексту вывода.
2. **Чистый парсер** в `infra/` (образец — `infra/environment/ExtensionListParser.ts`)
   без `vscode`/spawn: снимает BOM (байтовый UTF-8/UTF-16LE/UTF-16BE через
   `iconv-lite` + символьный `U+FEFF`, оставшийся после декодирования),
   разбирает строки, при необходимости считает чистую функцию выбора для UI
   (`planExtensionChoices`). Все ветки покрываются 100% здесь, а не в
   оркестраторах.
3. **UI-обёртка** (`ui/commands/.../*CommandRunner.ts`, образец —
   `ExtensionCommandRunner.listConnectedDatabaseExtensions`) спавнит CLI через
   `runInternalCliCommand`, читает `-ResultFile` тем же чистым парсером и
   возвращает `undefined` при любом сбое (нет `env.json`, CLI завершился с
   ошибкой, старая платформа без нужного флага). Ручного fallback-ввода нет:
   при `undefined` вызывающий диалог прекращает операцию явным сообщением
   об ошибке, а не переключается на ручной ввод значения пользователем.

Почему `-ResultFile`, а не marker-блок в stdout: `LineBufferedDecoder`
(`infra/process/OutputDecoder.ts`) буферизует и перекодирует вывод процесса
построчно (OEM-866/Win1251) — это годится для логов, но рискует испортить
произвольные данные внутри маркера при таком роундтрипе. Канал через `/Out
<файл>` уже устоявшийся — его использует каждая из `export-configuration`/
`import-configuration`/`update-configuration`/`repository-*`.

Образец целиком: `v8vscedit.connectExtension` — список расширений для QuickPick
берётся через `list-db-extensions` (CLI) → `listConnectedDatabaseExtensions`
(UI-обёртка) → `resolveExtensionNameToConnect` (сам диалог, только выбор из
базы, без пункта «Ввести вручную…» и без `showInputBox`):
- `undefined` от UI-обёртки (нет подключения к базе/`env.json`, платформа
  старее 8.3.11 — флаг `-AllExtensions` не поддерживается) →
  `showErrorMessage` с точной причиной и подсказкой минимальной версии
  платформы, операция прекращается;
- в базе нет расширений → `showInformationMessage('В подключённой базе нет
  расширений.')`, операция прекращается;
- все расширения базы уже подключены (`planExtensionChoices(...).allConnected`)
  → `showInformationMessage('Все расширения базы уже подключены.')`, операция
  прекращается;
- иначе — `showQuickPick(plan.selectable, …)` только по вычисленному
  `planExtensionChoices` списку неподключённых расширений базы.

Функций `promptExtensionNameManually`/`validateExtensionName` и типа
`ExtensionPickItem` в коде больше нет — подключение расширения возможно
только выбором из списка базы.

### Два механизма подавления собственных файловых событий

`Container` игнорирует часть событий `FileSystemWatcher`, спровоцированных им же самим (генерация
XML, импорт/обновление конфигурации в базе). Механизма два, у них разная гранулярность, и они гасят
РАЗНОЕ — путать их нельзя:

- **`suppressedConfigurationReloads`** (`Map<нормализованный путь файла, expiresAt>`, поле
  `Container`) — пофайловый. Гасит только перестройку кэша дерева
  (`scheduleTreeCacheRefresh` → `refreshTreeCacheForFiles`) по конкретным записанным файлам:
  расширение только что сериализовало XML само и знает его новое содержимое, повторный парсинг
  того же файла из события watcher избыточен.
- **`ConfigurationCleanWindow`** (`infra/fs/ConfigurationCleanWindow.ts` — чистый класс без
  `vscode`, источник времени внедряется конструктором ради тестируемости истечения окна без
  реального таймера) — по КОРНЮ конфигурации. Открывается в `Container.markConfigurationsClean`
  сразу после успешного импорта/обновления конфигурации в базе, на
  `ConfigurationCleanWindow.defaultDurationMs` (15 секунд). Пока окно открыто,
  `scheduleChangedConfigurationStateRefresh` игнорирует событие watcher по файлу этого корня
  ЦЕЛИКОМ — ни быстрая пометка «конфигурация изменена» по одному файлу, ни планирование полного
  пересчёта. Причина: `FileSystemWatcher` доставляет события файлов, записанных импортом, уже
  ПОСЛЕ завершения операции — быстрый путь снова помечал только что синхронизированную
  конфигурацию изменённой, и расширение сразу предлагало обновить базу повторно. Полный пересчёт
  (`ConfigurationChangeDetector.detect`) обходит и хеширует всю выгрузку (замер — около 7 секунд
  на 59 503 файлах), поэтому гонять его на каждое из тысяч запоздавших событий watcher нельзя. По
  закрытии окна `markConfigurationsClean` сам ставит РОВНО ОДИН авторитетный
  `refreshChangedConfigurationState()` — так правка, сделанная пользователем во время окна, не
  теряется, а полный пересчёт не дублируется на каждое событие.

Новый код, который сам пишет файлы выгрузки и не должен ложно взводить «конфигурация изменена
относительно базы», использует `cleanWindow` через `markConfigurationsClean`, а не заводит третий
параллельный механизм подавления.

### Сериализация операций Конфигуратора с базой (`ConfigurationOperationGuard`)

`infra/process/ConfigurationOperationGuard.ts` — чистый класс без `vscode`, единая блокировка полного
импорта/обновления/применения конфигурации к базе в пределах одного окна VS Code. До issue #10 занятость
жила модульным флагом `isUpdatingConfigurations` внутри `ExtensionCommands.ts`, и синхронизация с
хранилищем (`RepositoryCommands`) шла мимо него — post-sync после `repository.connect`/`create` мог
запустить свой Конфигуратор параллельно ручному импорту из UI, оба против одной базы.

API:
- `isBusy`/`heldBy` — текущее состояние и заголовок держащей операции.
- `tryAcquire(title) → lease | undefined` — проверка и захват одной синхронной операцией (между ними нет
  `await`), поэтому два вызова, стартовавшие в одном тике, не займут guard оба; `lease.release()`
  идемпотентен и не снимает чужую (уже сменившуюся) аренду — сравнение по внутреннему токену держателя.
- `runExclusive(title, op) → { acquired: true, value } | { acquired: false, heldBy }` — нереентерабельная
  обёртка `tryAcquire` + `try/finally { release() }`; исключение `op()` пробрасывается тем же объектом,
  guard освобождается независимо от исхода.
- `onDidChangeBusy(listener)` — событие только на переходах `false→true`/`true→false`; ошибка подписчика
  ловится и уходит в `onListenerError` конструктора, остальные подписчики уведомление всё равно получают.

`Container` создаёт единственный экземпляр в конструкторе (`onListenerError` пишет `[guard][error] …` в
outputChannel) и в `bootstrap()` подписывается на `onDidChangeBusy` в приватном
`wireConfigurationOperationContext()` — это ЕДИНСТВЕННОЕ место, выставляющее контекст enablement
`v8vscedit.isUpdatingConfigurations` (`package.json → contributes.commands[].enablement`); отказ
`setContext` логируется отдельно (`[guard][error] setContext: …`), т.к. вызов асинхронный и не проходит
через `onListenerError` самого guard'а. Экземпляр публикуется в `CommandServices.configurationOperationGuard`
(и автоматически попадает в `buildMcpCommandServices` — MCP-мост `v8vscedit_execute_command` синхронизован
с UI-командами через тот же guard).

Пользователи:
- `ui/commands/ext/ExtensionCommands.ts` — `importConfigurations` (ранняя проверка `isBusy` до QuickPick,
  затем `tryAcquire` после него — защита от TOCTOU, пока пользователь выбирал конфигурации),
  `updateChangedConfigurations`, `runExclusiveConfigurationOperation`. Занятость сообщается
  `notifyConfigurationOperationBusy` (`ui/commands/ext/configurationOperationBusy.ts`) **без `await`**
  (запрет №18 в `CLAUDE.md`): раньше нотификация await'илась внутри критической секции, и любой
  параллельный вызывающий (`DbCommands`, MCP-мост) висел до закрытия сообщения пользователем, хотя
  фактически в этот момент ничего не выполнялось.
- `ui/commands/repository/RepositoryDatabaseSync.ts` — `runPostRepositorySync` (фоновый, `void`-путь после
  `repository.connect`/`create`: apply → decompile → `markConfigurationsClean` → `reloadEntries` →
  обновление UI, guard держится на всю цепочку целиком; при занятости ничего не запускает, пишет
  `[repository][post-sync][busy]` с именем мешающей операции в outputChannel и уведомляет без `await`) и
  `ensureTargetUpdatedBeforeCommit` (занятость проверяется дважды — до открытия QuickPick подтверждения
  обновления и повторно через `runExclusive` после него, т.к. пока диалог был открыт, guard мог занять
  другой путь). Внешние точки (runner'ы Конфигуратора, сам QuickPick) внедряются через
  `RepositoryDatabaseSyncDeps` — логика захвата тестируется без реального процесса 1С.

Известные ограничения:
- Guard действует в пределах одного окна VS Code — второе окно и отдельный процесс CLI (`onec-tools`) им
  не сериализуются.
- `repository.commit`/`update`/`lock`/`unlock` сами по себе (без последующего полного
  импорта/обновления/применения конфигурации к базе) под guard не попадают — заведено отдельно, issue #40
  форка.
- Ветка `feature/repository-lock-unlock-file-sync` (issue #1) при слиянии должна обернуть свой полный
  импорт в `guard.runExclusive`, держа модальные диалоги подтверждения вне аренды.

### Режим поддержки поставщика (`ParentConfigurations.bin`)

`infra/support/ParentConfigurationsParser.ts` разбирает `Ext/ParentConfigurations.bin` — список
объектов конфигурации, стоящих на поддержке поставщика. Формат установлен экспериментально (снят с
платформы 8.5.1, см. шапку `example/tools/build-supported-cf.mjs`):

```
{6,<изменения запрещены 1|0>,<число поставщиков>,<uuid>,<копия поставщика совпадает 1|0>,<uuid>,
 "<версия>","<поставщик>","<имя>",<число записей>, a,b,uuid,uuid, …, <хвост>}
```

Тело — последовательность записей `a,b,uuid,uuid` с одинаковыми uuid (режим `a` идёт ПЕРЕД парой
uuid); `b` — смысл не установлен, парсер и `SupportInfoService` его игнорируют. Парсер отдаёт сырые
коды записей (`ParentConfigurationsRecord.code`) и флаг заголовка, не зная их смысла — трактовка кода
и приоритет флага живут в **одном месте**, `SupportInfoService`:

| Код `a` в `.bin` | `SupportMode` | Смысл |
|---|---|---|
| `0` | `Locked` | объект поставщика не редактируется |
| `1` | `Editable` | редактируется с сохранением поддержки |
| `2` | `Removed` | снят с поддержки: объект редактируется свободно, но обновления поставщика на него не приходят |
| любой другой | `Locked` | неизвестный код трактуется как запрет — ошибочно разрешить правку объекта поставщика опаснее, чем ошибочно запретить; событие считается и пишется в лог |

Флаг заголовка «изменения запрещены» (`changesForbidden`) имеет приоритет над кодом записи: если он
взведён, `SupportInfoService.getSupportMode`/`getSupportModeByUuid` сразу возвращают `Locked` для
ЛЮБОГО файла под корнем конфигурации — включая BSL-модуль, для которого не удалось найти XML
владельца (ранний возврат до поиска XML и чтения uuid: дешевле на горячем пути дерева и не оставляет
случайных «дыр» в режиме «только для чтения»).

`SupportInfoService.hasChangesForbidden(filePath)` — отдельный от режима предикат, вернувший этот же
флаг: сам запрет по-прежнему решает `getSupportMode` (он уже дал `Locked`), а этот метод только
уточняет ПРИЧИНУ для UI — закрыта ли правка настройками поддержки всей конфигурации или отдельно
взятый объект поставщика на поддержке без права правки (у них разные способы снять запрет). Новое
значение `SupportMode` под этот случай не заводится, хотя `Removed` — тоже добавленное значение:
разница в природе. `Removed` — атрибут записи `.bin` конкретного объекта (код `2`), а
`changesForbidden` — свойство всей конфигурации, ПЕРЕКРЫВАЮЩЕЕ режим объекта: под флагом
`getSupportMode` сразу возвращает `Locked`, не читая uuid записи (ранний возврат — дешевле на
горячем пути дерева), и объект в режиме `Removed` под флагом неотличим от любого другого —
разбирать его код смысла нет. Причина навешивается поверх режима отдельным маркером:
`MetadataTreeProvider.applySupportDecoration` дописывает к `contextValue` суффикс
`-supportChangesForbidden` ПОВЕРХ `-support2` (числового суффикса `Locked`) при взведённом флаге.
Проверки блокировки по всему коду сравнивают только `=== SupportMode.Locked` — `Removed` их не
затрагивает. Формат суффикса и тексты причины
(подсказка индикатора, фрагмент «изменения конфигурации запрещены в настройках поддержки» для
сообщений об отказе) живут в одном модуле без `vscode` — `ui/support/supportLockReason.ts`
(`SUPPORT_CHANGES_FORBIDDEN_SUFFIX`, `SUPPORT_SUFFIX_RE`, `supportModeSuffix`,
`CHANGES_FORBIDDEN_REASON`, `SUPPORT_REMOVED_TITLE`, `CHANGES_FORBIDDEN_TITLE`, `supportIndicatorOf`,
`supportModeDtoOf`, `supportLockedReasonOf`) — его читают и дерево
(запись суффикса через `supportModeSuffix`), и `UniversalPanelViewProvider` (разбор суффикса в
подсказку и в `SupportModeDto` узла для webview), и сервисы отказа
(`MetadataMutationService`, `McpMutationGate`, UI-удаление `RemoveMetadataCommand`/
`FormToolsCommands` через `supportLockedReasonOf`, панель свойств через `readonlyReason:
'supportChangesForbidden'`), чтобы формулировка причины не разошлась между ними.

Значения `SupportMode` (`None=0`, `Editable=1`, `Locked=2`, `Removed=3`) заморожены — они вшиты в
суффикс `contextValue` вида `-support<n>` (запись — `supportModeSuffix` в `MetadataTreeProvider`,
разбор — там же в `UniversalPanelViewProvider`); менять числа нельзя, только состав таблицы
`BIN_CODE_TO_MODE` и добавлять новые значения следующим свободным числом (`Removed=3` добавлен так
же). `None` теперь означает ровно два неразличимых для UI случая — «объекта нет в поставке» и
«данных поддержки по конфигурации вовсе нет» (нет `.bin`, формат не распознан, флаг заголовка вне
`{0,1}`); отдельного кода `.bin` у `None` нет, это значение по умолчанию.

Нераспознанный формат (нет заголовка, версия ≠ 6, флаг заголовка ∉ `{0,1}`) — не частичный разбор:
`parseParentConfigurations` возвращает `{ ok: false, reason }`, `SupportInfoService.loadConfig`
полностью сбрасывает данные корня и кэш uuid по нему, `hasConfigData` для файлов этого корня
возвращает `false`, эффективный режим — `None`, в лог пишется строка «не распознан (`<reason>`)».
Решение осознанное: новая/неизвестная версия формата не должна блокировать всю конфигурацию как
«только для чтения» — платформа всё равно проверяет правила поддержки при импорте XML в базу.

Импорт XML в основную конфигурацию (`cli/commands/importConfiguration.ts`, не расширения) решает
`infra/support/SupportImportGuard.ts` (`mainConfigurationImportBlockReason`): отказ только при флаге
`changesForbidden=1`. Без флага загрузка передаётся платформе — она сама отбивает объект с кодом 0 и
загружает коды 1 и 2, поэтому отказ по одному наличию `.bin` не давал загрузить даже правку
редактируемых объектов. Здесь, в отличие от навигатора, нераспознанный `.bin` — отказ: загрузка в
базу необратимее подсветки дерева, и разрешать её, не поняв настроек поддержки, опаснее, чем лишний
раз отказать.

Несколько поставщиков (`vendorCount > 1`): записи ищутся регэкспом по форме `a,b,uuid,uuid` по всему
телу файла, а не нарезаются по объявленному числу записей заголовка — раскладка тела для нескольких
поставщиков не сверена с эталоном платформы, но поиск по форме записи от числа поставщиков не
зависит. Дубль uuid (объект встречается у нескольких поставщиков) разрешается в пользу самого строгого
режима (`MODE_STRICTNESS`): порядок строгости — `None (0) < Removed (1) < Editable (2) < Locked (3)`,
он не совпадает с числами `SupportMode` (это ранг, а не значение enum). `Removed` строже `None`, но
мягче `Editable`: если хоть один поставщик из нескольких ещё поддерживает объект (`Editable`/`Locked`),
его обновления придут, и «снят с поддержки» для объекта в целом неверно — побеждает более строгий
режим. Ранг `None` формальный: из `.bin` это значение не получается (см. выше), в дубле участвовать
не может. В лог пишется предупреждение при разрешении дубля, т.к. эталона для этого случая нет.

Фикстуры: `example/{2.20,2.21}/src/cf/Ext/ParentConfigurations.bin` (флаг `changesForbidden=0`, 228
записей) и `example/support/changes-forbidden/ParentConfigurations.bin` (флаг `changesForbidden=1`) —
обе собираются `example/tools/build-supported-cf.mjs` по файлам правил `support-rules.json`/
`support-rules-forbidden.json` (инструкция по пересборке — в шапке скрипта, см. также
`docs/agentic-pipeline.md`).

**Известные ограничения:**
- Причина теперь различается на уровне текста (см. `hasChangesForbidden`/`-supportChangesForbidden`
  выше): при `changesForbidden=1` подсказка индикатора и сообщения об отказе (добавление в UI и MCP,
  MCP-мутации, панель свойств, UI-удаление объекта и формы) называют её отдельно — «изменения
  конфигурации запрещены в настройках поддержки», а не общее «на поддержке, запрещено».
  Индивидуальный код объекта из `.bin` (0/1/2) при этом по-прежнему не проверяется вовсе (ранний
  возврат до поиска XML/uuid) — отдельного индикатора «этот конкретный объект снят с поддержки
  (режим `Removed`, код `2`), но конфигурация целиком запрещена к правке» нет: все объекты под таким
  корнем получают один и тот же замок с причиной «конфигурация», а собственный индикатор `Removed`
  под флагом не показывается ни одному из них.
- Проверку флага делает только полный/частичный импорт `import-configuration`. Другие пути загрузки
  XML в базу (`cli/commands/importGitChanges.ts`, агент Конфигуратора `infra/agent/AgentOperationService.ts`)
  её не делают и полагаются на проверку правил поддержки платформой.

## Граф зависимостей

```
extension.ts
  └── Container
      ├── infra/*
      ├── ui/tree/*
      ├── ui/commands/*
      ├── ui/readonly/BslReadonlyGuard
      └── lsp/LspManager
            ├── analyzer/BslAnalyzerService
            ├── analyzer/BslAnalyzerStatusBar
            └── LanguageClient
                  └── bsl-analyzer lsp
```

## Точка входа

`activate()` создаёт `Container` и делегирует ему регистрацию подсистем.

`Container.bootstrap()`:

1. Создаёт инфраструктурные сервисы.
2. Регистрирует дерево, webview-панели, декорации, watcher-ы и команды.
3. Загружает найденные XML-выгрузки конфигураций.
4. Регистрирует `BslReadonlyGuard`.
5. Запускает `LspManager`.

`deactivate()` останавливает активный LSP-клиент через `client.stop()`.

## Ключевые архитектурные решения

| Решение | Обоснование |
|---|---|
| `META_TYPES` как единый реестр типов | Добавление типа метаданных не требует параллельных словарей |
| `MetaPathResolver` как единый resolver путей | Все XML и BSL-модули резолвятся через один инфраструктурный контракт |
| `bsl-analyzer` как единственный LSP | Нет дублирования возможностей и расхождения диагностики между режимами |
| Прямое открытие BSL через `file://` | Внешний LSP работает с реальными файлами, без виртуальной схемы |
| `BslReadonlyGuard` для BSL | Запрет редактирования не зависит от способа открытия файла |
| Ленивая загрузка дерева | Дочерние узлы строятся при раскрытии, а не при старте расширения |
| God-класс → тонкий фасад + подмодули в подпапке слоя | Убирает файлы 1000+ строк без риска регресса: рефактор косметический, публичный API и поведение неизменны (см. выше) |
| MCP-сервер: одна попытка bind, без авто-инкремента порта; конфликт разрешается зондом `/identity` | Авто-инкремент молча подключал агента не к тому проекту; явное `reuse`/`conflict-foreign`/`conflict-unknown` не даёт агенту работать с чужой конфигурацией (см. [mcp-server-lifecycle.md](./mcp-server-lifecycle.md)) |
| `stop()` MCP-сервера форсирует `closeAllConnections()` до `close()` | Долгоживущие SSE-соединения не давали `httpServer.close()` освободить порт естественным путём (см. [mcp-server-lifecycle.md](./mcp-server-lifecycle.md)) |
| Модель трёх деревьев git (HEAD/индекс/рабочее дерево) в представлении изменений | Единственный способ получить непустой diff для staged-файла — сравнивать HEAD↔индекс, а не индекс↔рабочее дерево (см. [git-metadata-changes.md](./git-metadata-changes.md)) |
| Предки объекта в блоке «История» синтезируются из `META_TYPES`, а не берутся из живого дерева навигатора | Живое дерево отражает только текущую рабочую копию и врало бы для исторического состояния коммита (см. [git-history-graph.md](./git-history-graph.md)) |
| Данные из базы (не из XML-выгрузки) передаются CLI → UI через `-ResultFile`, гейт разбора — `exitCode`, а не текст лога | Построчный перекодировщик вывода процесса (`LineBufferedDecoder`) не гарантирует целостность произвольных данных внутри marker-блока; `/Out`-файл — уже устоявшийся канал `*Configuration`-команд (см. «Паттерн: чтение данных из базы через пакетный Конфигуратор» выше) |
| `ConfigurationCleanWindow`: окно тишины по корню конфигурации после импорта/обновления БД, единственный авторитетный пересчёт по его истечении | События watcher по файлам, записанным импортом, приходят уже после операции; полный `ConfigurationChangeDetector.detect` слишком дорог (~7 с на 59 503 файлах), чтобы гонять его на каждое из тысяч запоздавших событий (см. «Два механизма подавления собственных файловых событий» выше) |
| `ConfigurationOperationGuard`: единый guard вместо модульного флага под каждым путём импорта/обновления/применения конфигурации к базе, аренда по токену, событие только на переходах | Прежний флаг `isUpdatingConfigurations` жил только в `ExtensionCommands` и не видел синхронизацию с хранилищем — параллельный post-sync и ручной импорт могли одновременно писать в одну базу (см. «Сериализация операций Конфигуратора с базой» выше) |

## Подробная документация

- [Навигатор метаданных](./metadata-navigator.md) — дерево, команды, path resolver.
- [Языковая поддержка BSL](./bsl-language-support.md) — запуск `bsl-analyzer` и настройки.
- [Парсинг XML конфигурации](./metadata-parser.md) — алгоритмы разбора Configuration.xml и объектных XML.
- [Изменения метаданных](./git-metadata-changes.md) — семантический git по объектам 1С, представление `v8vsceditChanges`.
- [История изменений](./git-history-graph.md) — граф git-коммитов по объектам 1С, сворачиваемый блок панели `v8vsceditChanges`.
- [Жизненный цикл MCP-сервера](./mcp-server-lifecycle.md) — старт/остановка, освобождение порта, обнаружение и разрешение конфликта порта; канон путей MCP-инструментов — отдельно, в [mcp-paths.md](./mcp-paths.md).
