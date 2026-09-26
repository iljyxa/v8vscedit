# CLAUDE.md

Гайд для Claude Code (и любого агента) при работе с этим репозиторием. Правила ниже — контракт, а не рекомендации.

## О проекте

`v8vscedit` — расширение для VS Code / Cursor (TypeScript) для работы с выгрузкой конфигураций и расширений 1С:Предприятие: навигация по метаданным из XML, редактирование свойств и состава, создание/удаление объектов метаданных, синхронизация с базой, хранилище конфигурации, LSP для BSL и локальный MCP-сервер для ИИ-агентов.

Две независимые подсистемы:
1. **Навигатор метаданных** — дерево объектов из XML-выгрузки (CF и CFE), свойства, чтение/создание/редактирование метаданных, открытие BSL-модулей.
2. **Языковая поддержка BSL** — LSP-клиент для внешнего `bsl-analyzer`.

Подробная документация — в `./docs` (`architecture.md`, `metadata-navigator.md`, `metadata-parser.md`, `bsl-language-support.md`, `mcp-paths.md`, `mcp-server-lifecycle.md`, `xml-format-rulesets.md`, `agentic-pipeline.md`, `vscode-extension-best-practices.md`, `git-metadata-changes.md`, `git-history-graph.md`, `repository-file-sync.md`). Справочники, вынесенные из этого файла ради экономии контекста агентов: **[change-recipes.md](./docs/change-recipes.md)** — какие файлы трогать по сценарию, [project-layout.md](./docs/project-layout.md) — подробная раскладка `src/`, [tech-debt.md](./docs/tech-debt.md) — известные технические долги.

## Язык общения

- Отвечать на русском. Комментарии и документация в коде — только на русском. Сообщения коммитов — на русском.
- Комментарии объясняют *почему*, а не *что*. Без «комментариев-капитанов» (`// импортируем X`, `// возвращаем результат`) и декоративных эмодзи.
- Избегать высокоуровневых ответов — давать конкретные решения применительно к проекту.

## Git-процесс

- **Коммиты — на русском.** Категорически запрещено упоминать Claude/ИИ в любой форме: никаких трейлеров `Co-Authored-By: Claude ...`, `Generated with Claude Code` и подобных подписей. То же для тел PR.
- **Ветки создаёт только пользователь** — сам или по явному указанию. Не создавать ветки автоматически, даже находясь на ветке по умолчанию; работать в текущей ветке, если не сказано иначе.

## Конвейер агентной разработки (оркестратор + субагенты)

Разработка идёт TDD-конвейером субагентов (`.claude/agents/*.md`), которыми дирижирует **оркестратор —
основной чат**. Полное описание, триаж и протокол возврата — `docs/agentic-pipeline.md`; стандарт
качества для `architect` и `reviewer` — `docs/vscode-extension-best-practices.md`.

- **FULL-трек:** `architect` (opus, план + сигнатуры + план тестов) → `implementer` (opus, TDD в одном
  контексте: контракт → красные тесты → реализация → compile + lint) → **QA-гейт** → `reviewer` (opus) →
  `documenter` (sonnet). Выбирается, если задача правит центральные контракты (`META_TYPES`,
  `MetaPathResolver`, `PropertySchema`, ruleset формата), добавляет тип/слот/тег/схему/MCP-инструмент/
  команду, меняет контракт webview↔расширение, затрагивает > 2–3 файлов или пересекает слои. При
  сомнении — FULL.
- **FAST-трек:** оркестратор сам пишет тест и код → QA-гейт → `reviewer` → (`documenter` при изменении
  контракта).
- **QA-гейт — скрипт, а не агент:** `bash .claude/scripts/qa-gate.sh [база=main]`. Он выполняет lint,
  sanity-проверки и один полный прогон `coverage:changed`, который одновременно регресс `npm test` и
  100% patch coverage. Нерантайм-изменения (`.claude/**`, `docs/` без кода) скрипт распознаёт сам и
  ставит тестам `N/A`. При RED с неочевидной причиной вызывается агент `qa-e2e` на разбор
  `out/qa-gate.log`; прогон он не повторяет.
- **Инвариант: QA-гейт и `reviewer` выполняются ВСЕГДА, на любом треке.** Ревьюер не повторяет
  механические проверки гейта и возвращает задачу на `implementer` или `architect`; после доработки
  снова идут гейт и `reviewer`.
- **Эффективность:** один бриф на задачу (все тесты и ветки сразу); не пересказывать `CLAUDE.md` в
  брифах, он уже в контексте агентов; флейк — дефект теста, а не повод для повторов; глобальный
  `coverage` красный из-за легаси и гейтом не является.

## Команды

```bash
npm run build         # полная сборка: clean + build:node + build:webview (Vite → dist/)
npm run watch         # параллельный watch node + webview (scripts/vite-watch.mjs)
npm run typecheck     # tsc (расширение) + vue-tsc (webview); = npm run compile
npm run lint          # eslint . --max-warnings=0
npm test              # запуск всех тестов через @vscode/test-electron (out/test/runTests.js)
npm run test:fast     # прогон без pretest-пересборки; фильтр: MOCHA_GREP='<regex>' npm run test:fast
npm run coverage:changed # 100% ТОЛЬКО по изменённым production-файлам (гейт задачи; scripts/patch-coverage.mjs)
                       # по умолчанию сравнение с HEAD (только незакоммиченное); для закоммиченной
                       # ветки — COVERAGE_BASE_REF=main npm run coverage:changed (сравнение с
                       # git merge-base); флаг --ignore-test-failures (или
                       # COVERAGE_IGNORE_TEST_FAILURES=1) допустим только когда npm test уже
                       # прогнан и все падения классифицированы как унаследованные
npm run coverage      # c8 с глобальным порогом 100% (аспирационный; сейчас RED из-за легаси-долга — не гейт задачи)
npm run coverage:report  # покрытие без падения по порогу (диагностика)
```

- **`npm test` требует предварительной сборки.** Скрипт `pretest` делает `typecheck → build:node → build:webview → test:compile` (без `clean` — сборка инкрементальная; компиляция тестов в `out/` через `tsconfig.test.json`). Тестовый runner берётся из `out/`, т.к. Mocha грузит `out/test/suite/*.js`.
- Запуск под конкретной версией VS Code: `VSCODE_TEST_VERSION=1.85.0 npm test`.
- **Отдельный тест — быстро и без `.only`.** Runner (`src/test/suite/index.ts`) читает `MOCHA_GREP` и применяет `mocha.grep()`. Итерация: правка теста → `npm run test:compile` → `MOCHA_GREP='<regex по имени suite/теста>' npm run test:fast` (`test:fast` НЕ запускает `pretest`, т.е. не пересобирает Vite — на порядок быстрее полного `npm test`). `.only` больше не нужен.
- Перед любым коммитом: `npm run compile` и **`npm run lint`** должны проходить без ошибок и предупреждений.
- Точки входа: `main` = `./dist/extension.js`; CLI — `dist/cli/onec-tools.js`. Целевая среда — VS Code API ≥ 1.85, TypeScript ≥ 5.3, strict, ES2020.

## Технологический стек

- TypeScript ≥ 5.3, target ES2020, strict. VS Code API ≥ 1.85, `vscode-languageclient`.
- **Vite** (сборка в `dist/`). Два конфига: `vite.node.config.ts` (Node-таргет: `extension`, CLI) и `vite.webview.config.ts` (Vue-webview из `src-ui/`). Встроенного `server`-entry нет — LSP внешний (`bsl-analyzer`).
- `iconv-lite` — декодирование OEM-866/Win1251 вывода vrunner.
- Тесты — Mocha через `@vscode/test-electron`, покрытие — `c8`.

## Архитектура

Слоистая, с однонаправленными зависимостями. Единый принцип: **одна декларативная таблица типов метаданных (`META_TYPES`) → один конвейер, использующий её везде**. Всё поведение — функции и сервисы поверх таблицы.

```
domain          ←   никто (самый низ)
infra           ←   domain
ui              ←   domain, infra
lsp             ←   infra (на чтение файлов), domain (опционально)
cli             ←   domain, infra (отдельный потребитель, нижние слои от него не зависят)
container/ext   ←   всё
```

Запреты зависимостей:
- `domain/**` не импортирует `vscode`, `fs`, `path`.
- `infra/**` не импортирует `vscode`.
- `domain/**` и `infra/**` не импортируют `cli/**`; CLI всегда потребитель.
- `ui/**` не содержит regex-парсинга XML и вычислений путей — только вызовы `infra/*`.
- LSP-подсистема не содержит встроенного сервера; все языковые возможности — через внешний `bsl-analyzer`.

### Раскладка каталогов (кратко; подробно — [project-layout.md](./docs/project-layout.md))

```
src/
├── extension.ts, Container.ts   # тонкий activate/deactivate; composition root
├── domain/     # чистый домен: META_TYPES, ChildTag, ModuleSlot, MetaObject, CanonicalNames — без vscode/fs/path
├── infra/      # xml/ (ридеры/эдиторы, PropertySchema, format/ ruleset), fs/ (MetaPathResolver), cfe/, support/,
│               # cache/, repository/, git/, environment/, process/ (ConfigurationOperationGuard), mcp/, skills/ — без vscode
├── ui/         # tree/, views/ (universal/ — ОСНОВНОЙ UI, properties/, changes/, history/, …), commands/, git/, mcp/, readonly/
├── lsp/        # LspManager + внешний bsl-analyzer
├── cli/        # отдельный потребитель domain/infra (onec-tools.ts, commands/, core/)
└── test/       # runTests.ts + suite/
src-ui/         # Vue-webview: apps/* (панели), shared/ (protocol/, state/, components/, api/)
```

`cli/` — отдельный потребитель `domain/` и `infra/`. Если код нужен и расширению, и CLI — он живёт в `infra/<подпапка>/`, а `cli/core/*` даёт тонкий re-export.

### Центральный контракт — `META_TYPES`

Единственный источник правды по типам метаданных: иконки, папки выгрузки, дочерние элементы, слоты модулей, группировка в дереве, схема свойств.

```typescript
// domain/MetaTypes.ts
export interface MetaTypeDef {
  kind: MetaKind;                  // 'Catalog'
  label: string;                   // 'Справочник'
  pluralLabel: string;             // 'Справочники'
  folder?: string;                 // 'Catalogs'
  icon: string;                    // имя SVG без расширения
  group: MetaGroup;                // 'common' | 'top' | 'documents-branch' | 'child' | 'service' | 'root'
  groupOrder: number;
  childTags?: readonly ChildTag[]; // ['Attribute','TabularSection','Form','Command','Template']
  modules?: readonly ModuleSlot[]; // ['Object','Manager']
  propertySchema?: string;         // ключ в PROPERTY_SCHEMAS
  singleClickCommand?: OpenModuleCommandId;
  pathSegment?: string;            // канонический сегмент пути для MCP
  englishKind?: string;            // англ. имя типа (по умолчанию = kind)
}
```

Правила:
- **Добавление нового типа метаданных — ТОЛЬКО одна запись в `META_TYPES`.** Если пришлось править что-то ещё — это утечка знаний из реестра.
- Никаких параллельных словарей `typeToFolder`, `NODE_DESCRIPTORS`, `HANDLER_REGISTRY`, `FOLDER_MAP`.
- `ConfigXmlReader`, `MetaPathResolver`, `MetaObjectBuilder`, `GroupBuilder`, `PropertyBuilder` — все читают данные из `META_TYPES`.

### Центральный контракт — `MetaPathResolver`

Один класс вместо россыпи функций; карта слотов модулей (`Object→Ext/ObjectModule.bsl` и т.п.) — внутри как данные. Все пути (XML и BSL-модули) резолвятся только через него.

### Composition root

`Container.bootstrap()`: создаёт `OutputChannel` и все сервисы → регистрирует `TreeView`/декорации/`FileSystemWatcher` → `CommandRegistry.registerAll(ctx, services)` → `reloadEntries()` → запускает `V8McpServer` (если `v8vscedit.mcp.enabled`) → стартует `LspManager`. Сервисы не создаются через `new` в командах/builder'ах — только через Container.

### Основной UI — webview, а не TreeView

**`UniversalPanelViewProvider` (`src/ui/views/universal/`) — основной UI навигатора** (HTML/Vue-webview: дерево, поиск, контекстное меню, операции). Нативный `MetadataTreeProvider` (`ui/tree/`) существует только как источник данных (`treeProvider.getChildren()`); сам TreeView-виджет — атавизм и **не основной UI**.

Следствия:
- Контекстное меню узлов формируется в `UniversalPanelViewProvider.getNodeActions()` / `addModuleActions()`, **а не** через `package.json → contributes.menus`.
- Источник правды для команд узла — `META_TYPES.modules`, читаемый через `MODULE_SLOT_ACTIONS`.
- Новая команда узла: добавить в `MODULE_SLOT_ACTIONS` (в `UniversalPanelViewProvider.ts`) + зарегистрировать в `CommandRegistry`. Правка `package.json → menus` — опциональна (для нативного TreeView).

### Webview (`src-ui/`)

Vue-приложения (сборка `vite.webview.config.ts`, проверка типов `vue-tsc`/`tsconfig.ui.json`): `src-ui/apps/*` — отдельные панели, `src-ui/shared/` — общий код (`protocol/` — контракт сообщений webview ↔ расширение, `state/`, `components/` в т.ч. общее дерево `UniversalTree*.vue`, `api/`). Состав панелей — [project-layout.md](./docs/project-layout.md#webview-src-ui). При изменении взаимодействия панели и расширения правьте обе стороны протокола.

## MCP-сервер для ИИ-агентов

`src/ui/mcp/V8McpServer.ts` — локальный MCP-сервер, официальный канал автоматизации. Запускается только после `reloadEntries()`, слушает loopback, не даёт агенту прямой доступ к shell/произвольным путям/произвольным VS Code командам. Старт/остановка, гарантированное освобождение порта и разрешение конфликта порта с другим инстансом/проектом — отдельный слой `infra/mcp/`, см. [mcp-server-lifecycle.md](./docs/mcp-server-lifecycle.md) (не путать с каноном путей инструментов ниже).

Правила:
- SDK: production-ветка `@modelcontextprotocol/sdk` v1.x. Транспорт: Streamable HTTP на `127.0.0.1`/`localhost`/`::1`; удалённый bind запрещён.
- Инструменты регистрируются в `V8McpServer.ts`, но бизнес-логика живёт в общих сервисах (`infra/*`, `ui/commands/*/*Service.ts`). UI-команда и MCP-инструмент для одного действия вызывают **один и тот же код**.
- Для команд, меняющих конфигурацию/базу (импорт, обновление, создание/удаление/редактирование метаданных), добавлять MCP-инструмент или явно документировать, почему нельзя.
- Нельзя делать инструмент, исполняющий произвольную строку команды, произвольный `vscode.commands.executeCommand` или пишущий XML в обход существующего сервиса.
- Любой инструмент записи сначала валидирует вход и права, возвращает список изменённых файлов и маркирует конфигурацию изменённой тем же механизмом, что UI. Единый post-mutation путь: `suppressConfigurationReloadForFiles(changedFiles)` → `markChangedConfigurationByFiles(changedFiles)` → `treeProvider.refresh()` → `refreshActionsView()`.
- Значения enum, boolean/localized-классификация и схемы свойств живут в `infra/xml/PropertySchema.ts` (или спец-реестре infra), MCP только публикует контракт.

### Канон именования путей MCP

Полный справочник — `./docs/mcp-paths.md`. Ключевое:
- Корни-коллекции — **только множественное число** (`Справочники.Контрагенты`, `РегистрыСведений.КурсыВалют`). Единственное — только для `Подсистема`, `Конфигурация`, `Расширение`.
- Реквизиты/ТЧ — прямые сегменты без роли-префикса (`Справочники.Контрагенты.ИНН`; внутри ТЧ — `…ТабличнаяЧасть.Имя.Реквизит.Имя`).
- Английских алиасов (`Catalog.X`) и legacy-форм нет; любая такая форма отбивается с подсказкой канона.
- У инструментов, работающих с одним узлом, аргумент называется `path`; парные `compile_*` принимают `parentPath`. Никаких `objectPath`/`formPath`/`modulePath` и т.п.

## Инвариант изменений — рецепты в [change-recipes.md](./docs/change-recipes.md)

Для каждого сценария там указано, какие файлы трогать; если требуется править сверх списка — задача решается в другом слое. `architect` и `reviewer` сверяются с рецептом обязательно. Сценарии: новый тип метаданных; слот модуля (`ModuleSlot`); дочерний тег (`ChildTag`); контейнерный дочерний тип с вложенными листьями (ТЧ→Колонка, HTTPСервис→URLШаблон→Метод); схема свойств; правило состава свойств типизированного поля; команда; builder узла; декорация узла; view/webview; сервис инфры; возможность LSP; настройка; watcher; внешняя интеграция (vrunner); чтение данных из базы через пакетный Конфигуратор; открытие BSL-модулей; операция хранилища, меняющая файлы проекта; операция Конфигуратора с базой (`ConfigurationOperationGuard`); жизненный цикл встроенного MCP-сервера; часть объекта в панели «Изменения метаданных»; git-мутация над панелью изменений; триггер обновления панели по git-событию; возможность блока «История»; декомпозиция God-класса; перенос функции из 1С-скилов в расширение.

## Запреты и анти-паттерны

1. **Никаких regex-парсеров XML вне `infra/xml/`.**
2. **Нет дублирующих реестров типов.** `Record<string,string>` с `Catalog:'Catalogs'` вне `META_TYPES` — баг архитектуры.
3. **Нет команд в `package.json`, не покрытых `CommandRegistry`.**
4. **`MetadataTreeProvider` не знает про типы метаданных** — делегирует в builder'ы.
5. **`TreeNode` не хранит XML-логику** — только отображение + ссылка на `TreeNodeModel`.
6. **Не импортировать `vscode` в `domain/` и `infra/`.**
7. **Сервисы не создаются через `new` в командах/builder'ах** — только через `Container`.
8. **Не использовать `any`.** Если неизбежно — комментарий `// any: <причина>`.
9. **Не сохранять пароли/токены в файлы проекта.** Секреты — через VS Code SecretStorage.
10. **Не создавать файлы при команде «Открыть».** Создание — только явным командам добавления/генерации.
11. **Не вешать синхронный I/O на getters, tooltip, decoration и hot path дерева.**
12. **Не терять формат XML.** Любой редактор существующего XML сохраняет BOM и стиль переводов строк исходного файла (`writeTextFilePreservingBomAndEol`).
13. **Справочники свойств не живут в UI** — только в `infra/xml/PropertySchema.ts` (или спец-реестре infra); UI рендерит готовое.
14. **Команды контекстного меню не хардкодятся в `UniversalPanelViewProvider`** — `addModuleActions` читает `META_TYPES[kind].modules` через `MODULE_SLOT_ACTIONS`.
15. **Нативный TreeView — не основной UI**; не дублировать логику меню в `package.json`, если она есть в `addModuleActions`.
16. **MCP-инструменты принимают только канон** (см. `./docs/mcp-paths.md`).
17. **God-объектов быть не должно.** Порог-ориентир — **~800 строк** на файл производственного кода; превышение требует либо явного обоснования, либо декомпозиции. Дробить **по ответственности/домену, а не механически по строкам**. Каноничные приёмы: регистрация MCP-инструментов дробится по доменам (`src/ui/mcp/registration/*`, образец — `McpAddToolsRegistration`); диспетчер `switch (kind)` заменяется **таблицей** `Record<MetaKind, …>` — данные типа в `META_TYPES`, XML-литералы формата в спец-реестре `infra/` (параллельные словари вне `META_TYPES` запрещены, см. п.2); класс-фасад остаётся тонким, логика — в module-level функциях/подмодулях того же слоя. **Любое дробление XML-генератора обязано сохранять байт-в-байт выход** (BOM/EOL/порядок атрибутов/самозакрытие, см. п.12) и предваряться байт-golden-тестом; декомпозиция `MetadataXmlCreator`/`FormBuilders` без такого эталона — запрещена (идёт вслепую).
18. **Внутри аренды `ConfigurationOperationGuard` (или любой другой эксклюзивной операции) уведомления показываются без `await`.** `await vscode.window.showInformationMessage(...)`/`showWarningMessage(...)` до `release()` держит guard занятым до закрытия нотификации пользователем — любая параллельная операция всё это время отбивается сообщением «уже выполняется», хотя фактически ничего не выполняется.

## Ключевые принципы

- Один декларативный реестр `META_TYPES` → один конвейер. Поведение — функции/сервисы поверх таблицы, без дублирующих словарей.
- Все пути (XML и BSL-модули) резолвятся только через `MetaPathResolver`.
- `bsl-analyzer` — единственный LSP; BSL-файлы открываются напрямую через `file://`.
- Ленивая загрузка дерева: дочерние узлы строятся при раскрытии.
- **Генерация XML привязана к версии формата через ruleset** (`infra/xml/format/`, текущий — 2.21). См. `docs/xml-format-rulesets.md`.

## TDD и покрытие

1. **Любое изменение поведения начинается с теста** (красный → код → зелёный).
2. **Покрытие кода, ЗАТРОНУТОГО изменением, — 100%** по строкам, веткам, функциям, операторам. Гейт — `npm run coverage:changed` (patch coverage: новые файлы целиком, изменённые — только строки диффа), в конвейере — через `.claude/scripts/qa-gate.sh`, который всегда передаёт `COVERAGE_BASE_REF=<база>` (иначе сравнение с `HEAD` видит лишь незакоммиченное). `--ignore-test-failures` (`COVERAGE_IGNORE_TEST_FAILURES=1`) — только после классификации падений как унаследованных; флаг не подменяет проверку регресса, она делается отдельным полным `npm test`. Глобальный `npm run coverage --100` красный из-за легаси-долга (`ui/tree/nodeBuilders/*`, `ExtensionCommandRunner`, `RepositoryCommandRunner`, `InitializeProjectCommand`, `infra/xml/form/*` и др.) — **известное состояние, не предмет задачи**; не доказывать это заново через stash/baseline. `Container.ts`/`extension.ts` c8 не инструментирует — они покрываются интеграционно и исключены из гейта.
3. **Заглушки/фиктивные ассёрты/тесты ради покрытия запрещены.** Тест проверяет реальное поведение на настоящих XML-фикстурах (`example/2.20/src/cf`, `example/2.21/src/cf`, `example/2.21/src/cfe/EVOLC`), реальных временных файлах или реальном процессе; mock/stub — только для недоступной внешней системы с обоснованием. Тесты **детерминированы** — без гонок/угадывания таймингов; учитывай фоновое поведение SDK/клиентов.
4. Непокрываемую из-за VS Code API логику выносить в `domain/`/`infra/` и покрывать unit-тестом; тонкий UI-адаптер — интеграционным тестом. Осознанно недостижимую защитную ветку — `/* c8 ignore */` с обоснованием.
5. **Все тесты задачи — за один проход** (ветки заранее: ошибки, таймауты, guard'ы, граничные входы; параметризация по конечным множествам — enum/настройки, напр. `host ∈ {127.0.0.1, localhost, ::1}`), чтобы не гонять ре-цикл через гейт.
6. Перед завершением задачи QA-гейт — GREEN. Если его нельзя выполнить локально — зафиксировать причину, задачу не считать завершённой.

## Рабочий процесс и отладка

- Запуск: `npm install` → `npm run watch` → `F5` (Extension Development Host), `Ctrl+Shift+F5` — перезапуск.
- Каналы вывода: «BSL LSP Trace» (JSON-RPC), «1С Редактор» (лог расширения), «BSL Analyzer» (stdout/stderr сервера).
- Инкрементальность: менять не более одного слоя за коммит; после каждого коммита проходят `npm run compile` и `npm run lint`.
- Новый код — только в целевых папках. Создание новых файлов в корне `src/` запрещено (кроме `Container.ts`, `extension.ts`). Папки `src/handlers|nodes|services|views|language|language-server|formEditor` не существуют — не создавать.
- Не создавать параллельные версии сервисов («v2»). При переносе файла — `git mv` + обновить импорты + `compile`/`lint`.

### Sanity-чек после изменений

1. `npm run compile` — 0 ошибок.
2. `npm run lint` — 0 ошибок и предупреждений.
3. `npm run build` — Vite собирается.
4. `rg "typeToFolder\s*:" src` — 0.
5. `rg "import .* from 'vscode'" src/domain src/infra` — 0.
6. `rg "from ['\"].*cli|from ['\"].*/cli" src/domain src/infra` — 0.
7. `rg "require\(|readFileSync" src/domain` — 0.
8. `rg "FOLDER_MAP|FOLDER_RU" src` — 0.

## Известные технические долги

Перечень — [tech-debt.md](./docs/tech-debt.md). Сверяться при планировании задач в затронутых областях (`CommandRegistry`, `TreeNode`, XML-парсинг на регулярках, панель «Изменения метаданных», блок «История», хранилище).

## `.cursor/`, `.codex/`, `.claude/skills/` — это доменные 1С-скилы, а не разработка расширения

`.cursor/rules/` и `.cursor/skills/`, а также скилы в `.claude/skills/` (перенесены из `.codex/skills/`: `cf-*`, `cfe-*`, `epf-*`, `erf-*`, `meta-*`, `form-*`, `role-*`, `skd-*`, `mxl-*`, `subsystem-*`, `web-*`, `db-*`, `interface-*`, `template-*`, `help-add`, `img-grid` и т.п.) — это **стандарты написания кода 1С/BSL и навыки работы с метаданными редактируемых конфигураций 1С**. Расширение устанавливает их пользователям как проектные ИИ-роли.

**Важно: эти 1С-скилы нужны только для справки** — как ориентир, что и как должно делать само расширение с выгрузкой 1С (канон операций, форматы, DSL). Они относятся к редактируемым конфигурациям 1С, **не** к TypeScript-коду этого репозитория. При разработке самого расширения руководствуйтесь этим файлом, а не BSL-правилами из `.cursor/rules/` и не 1С-скилами.
