# Известные технические долги

Перечень осознанных отступлений от архитектуры. Раньше был разделом корневого `CLAUDE.md`. При закрытии
долга пункт удаляется, при появлении нового — добавляется со ссылкой на профильный документ.

1. `CommandRegistry.ts` — один файл, пока не разбит на `open/`, `properties/`, `support/`, `ext/`.
2. `TreeNode.ts` не разделён на `TreeNodeModel` (POJO) + vscode-обёртку.
3. Миграция XML-парсинга на `fast-xml-parser` (внутри `infra/xml/*` — регулярки), без изменения публичного API ридеров.
4. Сильная типизация дерева: `TreeNodeModel` → discriminated union по `kind`.
5. `ui/views/properties/_types.ts` — окончательно отделить типы панели свойств.
6. `infra/git/GitStatusReader.ts` дублирует запуск `git status`/поиск корня с `GitMetadataStatusService`
   (панель «Изменения метаданных» vs декорации навигатора) — кандидат на объединение, см.
   [git-metadata-changes.md](./git-metadata-changes.md#известные-ограничения).
7. Панель «Изменения метаданных» показывает дерево навигаторной иерархии, но лист (объект) раскрывается
   только до глубины «объект → изменённая часть» (модуль/Свойства/форма), без разворота части до
   атрибута/колонки — см. [git-metadata-changes.md](./git-metadata-changes.md#известные-ограничения).
8. Панель «Изменения метаданных»: `findNavigatorNode` ищет узел объекта в `MetadataTreeProvider`
   отдельным DFS-обходом на КАЖДУЮ изменённую группу (O(изменения × размер дерева) на `refresh()`) —
   кандидат на индексацию дерева одним проходом; `synthesizeAncestors` для удалённых объектов группы
   `documents-branch` не восстанавливает промежуточную ветвь «Документы» — см.
   [git-metadata-changes.md](./git-metadata-changes.md#известные-ограничения).
9. Блок «История» панели «Изменения метаданных»: пагинация графа — полная перераскладка растущего окна
   `git log --max-count` на каждый `historyLoadMore` (без курсора/`--skip`, осознанно ради детерминизма
   дорожек); резолвинг принадлежности файлов коммита объектам идёт по ТЕКУЩЕМУ списку `configRoots`, а не
   по структуре выгрузки на момент коммита — см. [git-history-graph.md](./git-history-graph.md#известные-ограничения).
10. Хранилище (`infra/repository/`): `ONE_C_TYPE_NAMES` (русские имена типов для `-listFile`/`Objects.xml`) и
    `REPOSITORY_SUBORDINATE_LAYOUT` (каталоги и имена подчинённых объектов с собственным XML — перерасчёты,
    таблицы, кубы, таблицы измерения не являются `MetaKind`) живут вне `META_TYPES`; при появлении этих видов в
    навигаторе данные переезжают в реестр. `SupportInfoService.CHILD_FOLDERS_WITH_OWN_XML` дублирует часть
    таблицы (issue #47). Команды `repository.bind`/`create`/`unbind`/`report`/`dump`/`users`/`label` идут мимо
    `ConfigurationOperationGuard` (issue #40). См.
    [repository-file-sync.md](./repository-file-sync.md#известные-ограничения).
