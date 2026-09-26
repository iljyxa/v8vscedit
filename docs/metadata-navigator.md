# Редактор конфигураций (v8vscedit)

## Назначение

Отображает структуру конфигураций и расширений 1С (XML-выгрузка) в виде дерева в Activity Bar VSCode. Поддерживает CF (основная конфигурация) и CFE (расширение).

Связанные модули: `MetadataTreeProvider.ts`, `MetadataNode.ts`, `MetadataGroups.ts`, `CommandRegistry.ts`, `ConfigFinder.ts`, `ModulePathResolver.ts`, `nodes/`.

## Поиск конфигураций (ConfigFinder)

`findConfigurations(rootDir)` рекурсивно (до 10 уровней) обходит файловую систему воркспейса, пропуская `node_modules`, `.git`, `.cursor`, `dist`, `out`.

При нахождении `Configuration.xml` читает **первые 8 КБ** и определяет тип:
- `cfe` — если присутствует тег `<ConfigurationExtensionPurpose>`
- `cf` — во всех остальных случаях

Внутрь найденной конфигурации рекурсия не заходит — это предотвращает обнаружение вложенных Configuration.xml внутри самой конфигурации.

Результат — массив `ConfigEntry[]`:
```typescript
interface ConfigEntry {
  rootPath: string;   // абсолютный путь к каталогу с Configuration.xml
  kind: 'cf' | 'cfe';
}
```

## Дерево узлов (MetadataTreeProvider)

Реализует `vscode.TreeDataProvider<MetadataNode>`. Стратегия — **полностью ленивая загрузка**: каждый узел хранит `childrenLoader: () => MetadataNode[]`, который вычисляется только при раскрытии узла в UI.

### Иерархия дерева

```
Конфигурация (configuration / extension)
  └── Общие (group-common)
  │     ├── Подсистемы (Subsystem)
  │     ├── Общие модули (CommonModule)
  │     ├── Роли (Role)
  │     └── ... (16 подгрупп из COMMON_SUBGROUPS)
  └── Справочники (group-type)
  │     ├── МойСправочник (Catalog)
  │     │     ├── Реквизиты (group-type)
  │     │     │     └── Наименование (Attribute)
  │     │     ├── Табличные части (group-type)
  │     │     │     └── МояТЧ (TabularSection)
  │     │     │           └── Колонка (Column)
  │     │     ├── Формы (group-type)
  │     │     │     └── ФормаЭлемента (Form)
  │     │     └── ...
  │     └── ...
  └── Документы / Регистры / ...
```

### Синонимы объектов (ленивые)

Синоним каждого объекта загружается из его XML только при первом обращении через `Object.defineProperty` с getter:

```typescript
Object.defineProperty(node, 'tooltip', {
  get: getSynonym,   // читает XML и кэширует результат в cachedSynonym
  enumerable: true,
  configurable: true,
});
```

### OWN / BORROWED (для расширений CFE)

Для узлов расширения определяется признак заимствования по `namePrefix` из `Configuration.xml`:
- `OWN` (`[свой]`) — имя объекта начинается с `namePrefix`
- `BORROWED` (`[заим.]`) — имя не начинается с `namePrefix` (объект заимствован из основной конфигурации)

## Тип узла (MetadataNode)

```typescript
class MetadataNode extends vscode.TreeItem {
  nodeKind: NodeKind;           // ~50 литеральных типов
  xmlPath?: string;             // путь к XML-файлу объекта
  childrenLoader?: () => MetadataNode[];
  ownershipTag?: 'OWN' | 'BORROWED';
}
```

`contextValue` = `nodeKind` или `nodeKind-hasXml` (суффикс `-hasXml` добавляется при наличии `xmlPath`). Этот суффикс используется в `when`-условиях контекстного меню `package.json`.

## Дескриптор-ориентированная архитектура (nodes/)

Каждый тип узла описан отдельным файлом-дескриптором `NodeDescriptor`:

```typescript
interface NodeDescriptor {
  icon: string;                         // имя SVG-иконки
  folderName?: string;                  // папка в выгрузке (Catalogs, Documents, ...)
  children?: ReadonlyArray<ChildTag>;   // допустимые дочерние теги XML
  singleClickCommand?: CommandId;       // команда при одиночном клике
}
```

`MetadataTreeProvider` использует дескрипторы через `getNodeDescriptor(kind)` — реестр `NODE_DESCRIPTORS` в `nodes/index.ts`. Никаких `switch/case` по типу узла в провайдере нет.

### Дочерние теги (ChildTag / CHILD_TAG_CONFIG)

Конфигурация в `_types.ts`:

| ChildTag | XML-тег | Метка группы | NodeKind |
|---|---|---|---|
| `Attribute` | `Attribute` | Реквизиты | `Attribute` |
| `TabularSection` | `TabularSection` | Табличные части | `TabularSection` |
| `Form` | `Form` | Формы | `Form` |
| `Command` | `Command` | Команды | `Command` |
| `Template` | `Template` | Макеты | `Template` |
| `Dimension` | `Dimension` | Измерения | `Dimension` |
| `Resource` | `Resource` | Ресурсы | `Resource` |
| `EnumValue` | `EnumValue` | Значения | `EnumValue` |
| `URLTemplate` | `URLTemplate` | URL-шаблоны | `URLTemplate` |
| `Method` | `Method` | Методы | `Method` |

### Контейнерные дочерние узлы: ТЧ→Колонка и HTTPСервис→URLШаблон→Метод

У части дочерних типов есть собственные вложенные листья — контейнерный узел
хранит список своих детей, а не только простое значение. Первый прецедент —
табличная часть с колонками, второй — HTTP-сервис с трёхуровневой
вложенностью `HTTPService → URLTemplate → Method`: `URLTemplate` — контейнер
(со своими свойствами `Template`), `Method` — его лист (`HTTPMethod`,
`Handler`).

Оба прецедента переиспользуют один и тот же слот `MetaChild.columns`
(`domain/MetaObject.ts`): для ТЧ там лежат колонки (`Attribute`), для
`URLTemplate` — методы (`Method`). Узел дерева для контейнера строится
**симметрично в двух источниках**:
- `infra/cache/MetadataCache.ts` — `buildTabularSectionNode`/`buildUrlTemplateNode`,
  фактический источник дерева основного UI (webview `UniversalPanelViewProvider`);
- `ui/tree/nodeBuilders/metaObjectTreeBuilder.ts` — те же билдеры для нативного
  `TreeView` и панели свойств.

Имя родителя-контейнера при обращении к листу передаётся отдельным
параллельным полем контекста — `tabularSectionName` у колонки, `urlTemplateName`
у метода (`ui/tree/TreeNodeModel.ts`, `domain/CanonicalNames.ts`). Это
осознанное дублирование одного и того же смыслового слота под разные
контейнеры, а не переименование существующего поля и не новый параллельный
реестр типов (см. запрет №2 в `CLAUDE.md`).

Полный канон путей `HTTPСервисы.X.URLШаблон.T[.Метод.M]` и состав
MCP-инструментов `v8vscedit_add_url_template`/`v8vscedit_add_method` — в
[mcp-paths.md](./mcp-paths.md).

## Команды навигатора (CommandRegistry)

Зарегистрированы 8 команд:

| Команда | Описание | Когда доступна |
|---|---|---|
| `v8vscedit.refresh` | Обновить дерево | Всегда (toolbar) |
| `v8vscedit.openXmlFile` | Открыть XML объекта | `.*-hasXml$` |
| `v8vscedit.openObjectModule` | Открыть модуль объекта | Catalog, Document, ... |
| `v8vscedit.openManagerModule` | Открыть модуль менеджера | Catalog, Document, Enum, ... |
| `v8vscedit.openConstantModule` | Открыть модуль константы | `Constant-hasXml` |
| `v8vscedit.openFormModule` | Открыть модуль формы | CommonForm, Form |
| `v8vscedit.openCommandModule` | Открыть модуль команды | CommonCommand, Command |
| `v8vscedit.openServiceModule` | Открыть модуль сервиса | WebService, HTTPService |
| `v8vscedit.openCommonModuleCode` | Открыть модуль | `CommonModule-hasXml` |

`CommandRegistry` также создаёт `FileSystemWatcher` на `**/Configuration.xml` — при изменении, создании или удалении вызывается `reloadEntries()`.

## Резолвинг путей к BSL-модулям (ModulePathResolver)

`getObjectLocationFromXml(xmlPath)` определяет структуру выгрузки по пути XML:

- **Глубокая структура**: `<Root>/<Folder>/<Name>/<Name>.xml` → `objectDir = <Root>/<Folder>/<Name>`
- **Плоская структура**: `<Root>/<Folder>/<Name>.xml` → `objectDir = <Root>/<Folder>/<Name>`

Все функции используют `firstExisting(candidates)` — возвращает первый существующий путь из списка:

| Функция | Путь |
|---|---|
| `getObjectModulePath` | `{objectDir}/Ext/ObjectModule.bsl` |
| `getManagerModulePath` | `{objectDir}/Ext/ManagerModule.bsl` |
| `getConstantModulePath` | `{objectDir}/Ext/ValueManagerModule.bsl` |
| `getServiceModulePath` | `{objectDir}/Ext/Module.bsl` |
| `getCommonFormModulePath` | `{objectDir}/Ext/Form/Module.bsl` |
| `getCommonCommandModulePath` | `{objectDir}/Ext/CommandModule.bsl` |
| `getCommonModuleCodePath` | `{objectDir}/Ext/Module.bsl` |
| `getFormModulePathForChild` | `{objectDir}/Forms/{name}/Ext/Form/Module.bsl` |
| `getCommandModulePathForChild` | `{objectDir}/Commands/{name}/Ext/CommandModule.bsl` |

`resolveObjectXmlPath(configRoot, objectType, objectName)` находит XML объекта: сначала пробует глубокую структуру, затем плоскую.

Сам поиск «глубокая форма → плоская форма» — не логика `MetaPathResolver`, а отдельная функция
`findObjectXmlInFolder(configRoot, folderName, objectName)` в `infra/fs/ObjectLocation.ts`: сначала
`<configRoot>/<folderName>/<objectName>/<objectName>.xml`, при отсутствии —
`<configRoot>/<folderName>/<objectName>.xml`, иначе `null`. Имя папки категории вычисляет вызывающий
код (обычно `getMetaFolder(kind)` из `META_TYPES`), у самой функции своего словаря «тип → папка» нет —
поэтому ей может пользоваться и код, не привязанный к реестру типов. Её вызывают:
`MetaPathResolver.resolveXml` (резолвинг XML объекта по типу и имени), `RepositoryService.
resolveOwnerObjectXmlPath` (поиск владельца для проверки захвата хранилища), `SupportInfoService.
resolveObjectXmlForBsl` (поиск владельца для режима поддержки BSL-модуля, см.
[bsl-language-support.md](./bsl-language-support.md#определение-режима-поддержки-bsl-модуля)),
`MetadataCache` и `SubsystemXmlService` (XML корневых подсистем в `Subsystems/` и вложенных — в
`Subsystems/` «дома» родителя) и `ConfigurationValidationService` (проверка, что у каждого объекта
из `ChildObjects` есть XML; здесь важен только факт наличия, поэтому приоритет раскладок на результат
не влияет).

## Readonly файлов при захвате в хранилище

Файлы объектов проекта, подключённого к хранилищу, редактируемы только если объект захвачен и режим
поддержки разрешает правку (`RepositoryService.isEditRestricted` + `SupportInfoService`). Захват
проверяется на уровне **единицы хранилища**: форма, макет, перерасчёт, таблица/куб внешнего источника и
вложенная подсистема — отдельные объекты хранилища. Поэтому при нерекурсивном захвате справочника файлы
его форм и макетов остаются только для чтения, при рекурсивном — становятся редактируемыми; команды
объекта (`Commands/**`) входят в сам объект.

После захвата и отмены захвата `EditorReadonlyController` (`ui/readonly/`) переключает readonly уже
открытых вкладок (в том числе правой стороны диффа) без переоткрытия: видимые — сразу, скрытые — при
активации. `files.readonlyInclude` соблюдается (снятие readonly идёт командой `reset…ReadonlyInSession`).
Старые записи `state.json` без режима захвата делают редактируемыми и файлы подчинённых, как до issue #1.
Подробно — [repository-file-sync.md](./repository-file-sync.md#readonly).

## Известные ограничения

Поиск XML объекта «глубокая форма → плоская форма» ещё не везде сведён к `findObjectXmlInFolder`.
Собственные копии этой логики остаются в `infra/cfe/CfeBorrowService.ts` (`resolveSourceXml`),
`infra/xml/SubsystemToolsService.ts` (проверка и чтение дочерних подсистем; при чтении, если нет
глубокой формы, берётся плоская без проверки её существования), `infra/xml/MetadataXmlRemover.ts`
(проверка наличия XML), `infra/cache/MetadataCache.ts` (XML макета в `Templates/`) и
`ui/tree/nodeBuilders/*`. Отдельно — `infra/xml/ExchangePlanContentService.ts`
(`resolveExchangePlanXml`): он проверяет раскладки в обратном порядке, сначала плоскую, поэтому при
одновременном наличии обоих файлов его результат расходится с `findObjectXmlInFolder`. При изменении
порядка/правил поиска в `findObjectXmlInFolder` эти места нужно проверять отдельно.

## Иконки (nodes/presentation/)

`getIconUris(nodeKind, ownershipTag, extensionUri)` возвращает пару URI для светлой и тёмной темы. Для заимствованных объектов (`BORROWED`) добавляет суффикс `-borrowed` к имени иконки.

`getIconName(kind)` в `iconMap.ts` читает `descriptor.icon` и возвращает имя SVG-файла. Иконки хранятся в `src/icons/light/` и `src/icons/dark/`.

## Отдельно: панель «Изменения метаданных»

Рядом с навигатором в том же контейнере активности `v8vscedit` есть независимая webview-панель
`v8vsceditChanges` — семантический `git status` в терминах объектов метаданных (stage/unstage/discard/
commit/diff). Она держит свою модель данных изменений (`ChangesModel` из `infra/git/*`, а не
`MetadataCache`), но её дерево **повторяет навигаторную иерархию** этой панели, обрезанную только до
изменённых объектов и их предков: `MetadataChangesViewProvider` для каждого изменённого объекта находит
его узел в `MetadataTreeProvider` (`findNode` по `nodeKind`+`textLabel`) и поднимается `getParent` до
корня конфигурации, собирая реальную цепочку групп (`Общее → Общие модули → ...`, `Справочники → ...` и
т.д.); для удалённых объектов (уже отсутствующих в дереве) цепочка синтезируется из `META_TYPES`. Секция
«Прочие» (файлы вне структуры выгрузки) исключение — она остаётся плоской, у таких файлов нет
владеющего объекта. Переиспользуется и сам Vue-компонент дерева
(`src-ui/shared/components/tree/UniversalTree*.vue`), что и у `UniversalPanelViewProvider`.
Подробности, включая ограничения синтеза для удалённых объектов и производительность поиска узла, — в
[git-metadata-changes.md](./git-metadata-changes.md#известные-ограничения).
