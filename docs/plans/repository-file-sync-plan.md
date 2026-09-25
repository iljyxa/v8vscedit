# План архитектора — issue #1: синхронизация файлов с хранилищем 1С

> Рабочий план FULL-трека issue #1 (архитектор + решения test-writer). Реализация выполнена по нему в ветке `feature/repository-lock-unlock-file-sync`; отклонения developer — в комментарии issue #1. Итоговая документация — задача documenter (см. раздел 7).

Ветка: `feature/repository-lock-unlock-file-sync`. Трек: FULL.

## Постановка пользователя
0. Файлы проекта — форк хранилища: захват = получить актуальное состояние хранилища, отпускание = сбросить свои изменения и вернуться к хранилищу. Выгрузка небыстрая — минимум долгих и БЛОКИРУЮЩИХ операций, только в необходимом объёме.
1. Все найденные проблемы закрыть. 2. Детально проверить захват/отпускание.
3. Локально изменённый файл при захвате/получении — сравнение и окно диффа для переноса наработок; возможность отказаться и просто заменить из хранилища.
4. Непроверяемое без Конфигуратора — в комментарий issue.
5. Захваченный объект с разрешающим режимом поддержки — редактируем без дополнительного запроса.

## 1. Критерии приёмки
1. lock/unlock/update/commit запускают Конфигуратор ТОЛЬКО внутри `configurationOperationGuard.runExclusive`; выгрузка во temp — в той же аренде; модальные диалоги/диффы/сообщения об ошибках — только после release() (в заглушках deps `guard.isBusy === false`). Внутри аренды нет `await vscode.window.show*`.
2. Занятость guard'а проверяется ДО askRecursiveMode/pickBoolean/showInputBox: QuickPick не показан, лог `[repository][file-sync][busy] … "<heldBy>"`, `notifyBusy` без await, setContext не трогается. Guard заняли между предпроверкой и runExclusive → CLI не запускается, state не меняется.
3. CLI-аргументы lock всегда содержат `-Revised`, designer-аргументы — `-revised`.
4. lock/update никогда не пишут выгрузку сразу в проект: temp → план слияния → применение. `ConfigDumpInfo.xml` из частичной выгрузки не копируется; `Configuration.xml` — только если в плане есть корневая область.
5. Трёхсторонний план (хранилище R / локальный L / база B из хеш-кэша) → ровно один модальный диалог на операцию и только при конфликтах; исходы «Сравнить» / «Заменить» / Esc=`keep-local`.
6. Перед перезаписью/удалением локально изменённого файла — бэкап `.v8vscedit/repository/merge/<scopeKey>/<метка>/<rel>`.
7. После применения хеш-кэш = состояние базы: записанные → хеш версии хранилища, удалённые → убраны из кэша, keep-local → хеш версии хранилища.
8. Снимок захвата = ровно версия хранилища (из temp). update → пересъём снимка только для захваченных. commit keepLocked → пересъём из проекта; без keepLocked → удаление.
9. unlock со снимком не запускает выгрузку; без снимка (настройка включена) — выгрузка в той же аренде, что unlock. Откат удаляет лишние файлы в области объекта. Снимок удаляется всегда.
10. Корень нерекурсивно → частичная выгрузка только корневого объекта. Рекурсивно → UpdateInfo + сравнение ConfigDumpInfo.xml + частичная выгрузка только изменённых владельцев; нет изменений → второго запуска нет. Полный импорт — только fallback.
11. isLocked/isMetadataEditRestricted/isEditRestricted учитывают раскрытый состав рекурсивной подсистемы и признак рекурсивного захвата корня. Старый state.json (v2 без новых полей) читается без потерь.
12. Новый в хранилище объект после получения → в ChildObjects Configuration.xml через `ConfigurationXmlEditor.addChildObject` (порядок META_TYPES, BOM/EOL сохраняются).
13. После lock открытые редакторы файлов захваченных объектов (поддержка разрешает) — редактируемы без действий пользователя; после unlock — снова readonly. План переходов — чистая функция с unit-тестом.
14. compile, lint, coverage:changed = 100%; новые production-файлы ≤ ~800 строк; RepositoryService.ts ≤ 800 строк.

## 2. Решения по дефектам
1. Guard: новая `executeRepositoryCli` → `{status:'done'} | {status:'interrupted';message} | {status:'failed';message}` без модальных окон (сбой env.json/привязки тоже `failed`, не throw). Цепочка «CLI → state → выгрузка в temp» — один `runExclusive`. Ошибки/сообщения — `deps.notifyError/Warning/Info` (void) после аренды. Старая `runRepositoryCliCommand` остаётся обёрткой для bind/create/unbind/dump/report/users/label (её await showErrorMessage вне guard'а допустим). commit тоже под guard. bind/create/unbind/report/dump мимо guard'а — известное ограничение (документация).
2. lock всегда с `-Revised` (корректность, вне настройки). Ручная проверка.
3. unlock без снимка: объект/подсистема — в той же аренде частичная выгрузка объектов без снимка, затем тот же поток отката. Корень рекурсивно без снимка — владельцы, чьи файлы отличаются от хеш-кэша; нет таких — Конфигуратор не запускается; хеш-кэш пуст — пропуск с логом. Настройка выключена — выгрузки нет, мусорные снимки удаляются.
4. Сироты: область объекта одинакова для проекта и temp: XML объекта + каталог объекта; корень — Configuration.xml + корневой Ext/**; для подсистемы вложенные Subsystems/** исключаются. Локальный файл в области, которого нет в выгрузке: == база → удалить молча, иначе `conflict-delete`. Защита от неполной выгрузки: форма/макет/команда N есть в ChildObjects XML версии хранилища, но файлов Forms/N/** (Templates/, Commands/) в выгрузке нет → локальные не трогать (`skip-incomplete` + предупреждение). Откат по снимку удаляет лишние файлы с бэкапом.
5. Post-mutation (и для применения, и для отката): (1) `suppressConfigurationReloadForFiles(changed)` до и после записи; (2) запись + патч хеш-кэша; (3) `markChangedConfigurationByFiles(keptDivergent)` только если есть файлы, оставленные с расхождением от базы; (4) структурные изменения (Configuration.xml, добавлены/удалены владельцы) → `await reloadEntries()`, иначе `treeProvider.refreshCacheForFiles(changed) || treeProvider.refresh()`; (5) `refreshActionsView()`. `changeDetector.detect()` не вызывается.
6. update пересоздаёт снимок только при `isLocked(target, fullName)`.
7. Новые объекты: для рекурсивной подсистемы после первой выгрузки состав читается из XML подсистемы в temp; недостающих участников выгружать ещё раз в той же аренде в отдельный подкаталог temp, до неподвижной точки, ≤ 5 раундов. Новые владельцы → `ConfigurationXmlEditor.addChildObject(Catalog.X)`; удалённые (только рекурсивный корень по ConfigDumpInfo) → `removeChildObject` + удаление файлов по правилам конфликтов. Хеш Configuration.xml патчится после правки только если файл был чист до правки. ConfigDumpInfo.xml из частичной выгрузки игнорируется.
8. commit keepLocked → снимок пересоздаётся из проекта (для рекурсивного корня — хеш-манифест); без keepLocked → applyUnlock с раскрытым составом, снимки удаляются.
9. Корень нерекурсивно: выгрузка `{mode:'partial', fullNames:[корневое имя]}` + область «корень». Имя корня для listFile — одна константа `buildRootDumpListName` (`Конфигурация.<Имя>`), ручная проверка. Сбой — без полного импорта, только предупреждение.
10. Корень рекурсивно: в аренде после lock/update — `export-configuration -Mode UpdateInfo` в temp; `diffConfigDumpInfo(проектный, новый)` группирует по владельцу (`Catalog.X.Form.Y.Form`→`Catalog.X`, `Configuration.X.SessionModule`→корень); `-Mode Partial` только изменённые+добавленные владельцы, удалённые владельцы — удаление файлов. После успешного применения всех владельцев проектный ConfigDumpInfo.xml заменяется новым. Fallback — полная выгрузка во temp + слияние областью «вся конфигурация» тем же планировщиком, если: нет проектного ConfigDumpInfo.xml; ошибка разбора; сбой UpdateInfo; изменённых владельцев > ROOT_INCREMENTAL_MAX_OWNERS (400) или > 50% всех. unlock корня рекурсивно: при lock снимается хеш-манифест всех файлов корня (sha1, без ConfigDumpInfo.xml, без копирования контента); при unlock текущие хеши сравниваются с манифестом, изменённые файлы группируются по владельцам; нет изменений → Конфигуратор после unlock не запускается; есть → в той же аренде частичная выгрузка только этих владельцев, затем поток отката.
11. state.json остаётся `version: 2`, в RepositoryScopeState необязательные поля: `rootRecursive?: boolean`, `lockGroups?: Record<string,string[]>` (якорь рекурсивной подсистемы → состав), `releasedUnderRoot?: string[]`. Некорректные типы отбрасываются. `isLocked(fullName)` = явно в lockedFullNames ИЛИ (rootRecursive И не в releasedUnderRoot); корневое имя — только явно.
    | Операция | Изменение |
    |---|---|
    | lock корня рекурсивно | + корень, rootRecursive=true, releasedUnderRoot=[] |
    | lock корня нерекурсивно | + корень |
    | lock подсистемы рекурсивно | + якорь и участники, lockGroups[якорь]=участники |
    | lock объекта | + fullName, убрать из releasedUnderRoot |
    | unlock корня рекурсивно | очистка всего |
    | unlock корня нерекурсивно | − корень |
    | unlock подсистемы рекурсивно | − (lockGroups[якорь] ∪ состав по текущему XML) |
    | unlock объекта при rootRecursive | + в releasedUnderRoot |
    commit без keepLocked = unlock.
12. Формы/макеты как отдельные объекты хранилища — не чиним, ручная проверка.

### A. Поток «захват / получение»
В аренде: CLI → applyLock (для lock) → выгрузка во temp → дескриптор temp с dispose(). Вне аренды:
1. Состояния файлов: R из temp, L локальный, B из хеш-кэша (для файлов вне кэша — из снимка, если есть). Несохранённые редакторы (`deps.getDirtyFilePaths`) → принудительный конфликт.
2. Чистый план: L==R → noop; L==B → write (молча); нет L и нет B → write; есть B нет L → conflict-write; иначе → conflict-write; нет R: L==B → delete, иначе conflict-delete.
3. Конфликты → один модальный диалог.
4. Применение: бэкап конфликтных (и любых, чей хеш изменился между планом и применением), запись/удаление побайтовым копированием, удаление пустых каталогов в области, патч хеш-кэша, синхронизация ChildObjects.
5. Снимок из temp (lock) / пересъём для захваченных (update).
6. Post-mutation.
7. «Сравнить» → `openDiffs` пар (бэкап «мои изменения», файл проекта «хранилище»), только текстовые, ≤ MAX_DIFF_TABS=10, остальные и бинарные — в лог/сообщение (void). Открывать после applyLock (файл редактируем); после vscode.diff для разрешённых — `workbench.action.files.resetActiveEditorReadonlyInSession`.
8. temp удаляется в finally.
Esc/закрытие = `keep-local`: конфликтные файлы не трогаются, версия хранилища сохраняется в `.../merge/.../repository/<rel>`, хеш в кэше = хеш хранилища (файлы помечаются изменёнными, markChangedConfigurationByFiles), снимок = версия хранилища; немодальное сообщение (void) с кнопкой «Сравнить». Для получения незахваченного объекта «Сравнить» открывает дифф readonly + подсказка «захватите объект, чтобы перенести правки».

### B. Поток «отмена захвата»
В аренде: CLI unlock → applyUnlock → при необходимости выгрузка во temp (дефекты 3, 10). Вне аренды: эталон на объект (снимок или temp); сравнение с текущими файлами области changed/missing/extra; расхождения → модальный «Откатить к версии хранилища» / «Оставить изменения», Esc = оставить. Откат: бэкап отбрасываемых, восстановление эталона, удаление лишних. При обоих исходах хеш-кэш = хеши эталона; «оставленные» помечаются изменёнными. Post-mutation, снимки удаляются всегда.

### C. Readonly
`RepositoryService.onDidChangeLocks(listener)` без vscode, событие `{ target, fullNames, allObjects }`. `EditorReadonlyController` (ui/readonly) подписан: собирает открытые вкладки tabGroups (TabInputText и TabInputTextDiff.modified, схема file, внутри target.configRoot), желаемое состояние = `supportService.isLocked(f) || repositoryService.isEditRestricted(f)`; чистый `planReadonlyTransitions` → applyNow (видимые) / defer (невидимые), трогаются только файлы объектов события. Видимые: showTextDocument(doc,{viewColumn, preserveFocus:true}) (для диффа — vscode.diff preserveFocus) → set…ReadonlyInSession или reset…ReadonlyInSession (reset уважает files.readonlyInclude) → восстановить исходный активный редактор. Невидимые: pending map, применяется в onDidChangeActiveTextEditor, очистка при onDidCloseTextDocument. `BslReadonlyGuard.forget(uri)` — вызывается контроллером при переходе в writable.

### D. Настройка
`v8vscedit.repository.syncFilesOnLockUnlock` управляет синхронизацией файлов, снимками, откатом, fallback-выгрузкой. Пп. 1, 2, 11 и C — всегда.

MCP: `v8vscedit.repository.*` нет в ALLOWED_COMMANDS (`src/ui/mcp/registration/McpConfigLifecycleTools.ts`) → ConfigurationCommandOutcome не нужен; в документации — причина отсутствия MCP-инструмента.

## 3. Файлы и сигнатуры
### infra/xml
- НОВЫЙ `src/infra/xml/ConfigDumpInfoReader.ts`: `ConfigDumpInfoEntry {name,id,configVersion}`; `parseConfigDumpInfo(xmlText): ReadonlyMap<string,string>` (name→configVersion, только с configVersion, BOM снимается); `readConfigDumpInfoFile(filePath): ReadonlyMap|null` (null — нет файла/не разобрался).
### infra/cache
- `HashCache.ts`: экспорт `computeFileHash(filePath)`; `patchHashCacheEntries(projectRoot, target, configDir, extensionName, entries: Record<rel,hash>, deletedFiles)` (фильтр isSupportedConfigFile); `patchHashCacheForFiles(..., relativeFiles, deletedFiles = [])`.
### infra/repository (RepositoryService.ts 1300 → ≤800; фасад сохраняет публичные методы для внешних потребителей)
- НОВЫЙ `RepositoryObjectNames.ts`: перенос ONE_C_TYPE_NAMES, ONE_C_TYPE_NAMES_BY_PREFIX, convertContentRefToRepositoryFullName + `parseRepositoryFullName(fullName): {kind,name}|null`; `toChildObjectRef(fullName)` (`Справочник.X`→`Catalog.X` через `META_TYPES[kind].englishKind ?? kind`); `dumpInfoOwnerToRepositoryFullName(owner, target)` (`Catalog.X`→`Справочник.X`, `Configuration.X`→корневое имя); `buildRootDumpListName(target)` (`Конфигурация.<Имя>`); `CONFIGURATION_ROOT_LOCK_NAME`, `EXTENSION_ROOT_LOCK_NAME`, `getRootLockName(target)`, `isRootLockName(name)`. Долг: таблица параллельна META_TYPES — только перенос, записать в тех. долги.
- НОВЫЙ `RepositoryObjectScope.ts`: `ObjectScope = {kind:'object'; fullName; xmlRel; dirRel; excludeDirRels} | {kind:'root'; fullName} | {kind:'all'}`; `resolveObjectScope(configRoot, fullName, target)` (папка из META_TYPES[kind].folder; плоская F/N.xml или глубокая F/N/N.xml); `isPathInScope(rel, scope)`; `collectScopeFiles(baseDir, scope)` (POSIX rel, без ConfigDumpInfo.xml); `mapDumpPathToProject(rel, scope, projectLayout)`; `resolveOwnerFullNameByRelativePath(rel, target)` (обход META_TYPES с folder; Configuration.xml и Ext/** → корень; без нового словаря).
- НОВЫЙ `ConfigDumpInfoDiff.ts`: `extractDumpInfoOwner(name)`; `diffConfigDumpInfo(prev,next) → {changedOwners, addedOwners, removedOwners}` (отсортированы); `decideRootIncrementalStrategy(diff|null, totalOwners) → 'none'|'partial'|'full'`; константы ROOT_INCREMENTAL_MAX_OWNERS, ROOT_INCREMENTAL_MAX_SHARE.
- НОВЫЙ `RepositoryMergePlanner.ts`: `MergeFileState`, `MergeAction = 'noop'|'write'|'delete'|'conflict-write'|'conflict-delete'|'skip-incomplete'`, `MergePlan {entries; conflicts; silent; skipped; hasConflicts}`; `planRepositoryMerge(states)` (чистая); `collectMergeFileStates({configRoot, dumpDir, scopes, baseHashes, snapshotHashes?, dirtyRelativePaths})` (ФС, parseObjectXml для защиты от неполной выгрузки); `isTextMergeFile(rel)`; `diffScopeAgainstEtalon(etalon, current) → {changed, missing, extra}`.
- НОВЫЙ `RepositoryMergeApplier.ts`: `applyRepositoryMerge({projectRoot, target, dumpDir, plan, choice:'compare'|'replace'|'keep-local', backupDir, beforeWrite(filePaths)}) → MergeApplyResult {writtenFiles; deletedFiles; keptLocalFiles; backups:{rel,backupPath,projectPath}[]; repositoryCopies}` (абсолютные пути); повторная проверка локального хеша, бэкап, copyFileSync, удаление пустых каталогов, patchHashCacheEntries; `buildMergeBackupDir(workspaceRoot, scopeKey, label, now)`.
- НОВЫЙ `RepositoryLockSnapshotStore.ts`: перенос capture/diff/restore/discard + `captureFromDirectory(target, fullName, sourceDir, scope)`, `captureFromProject(target, fullName, scope)`, `readSnapshotHashes(target, fullName)`, `restoreToProject(target, fullName, scope, backupDir) → {restored, deleted, backups}`, `captureRootManifest(target)`, `diffRootManifest(target) → {owners, hasManifest}`, `discardAll(target)`; манифест v1 ({files}) читается.
- НОВЫЙ `RepositoryLockState.ts`: load/save state.json с очисткой полей; `applyLock(target,{anchor, members, recursiveRoot})`, `applyUnlock(target,{anchor, members, recursive, isRoot}) → string[]`; `isLocked`, `isRootLocked`, `isRootRecursiveLocked`, `getLockGroup(anchor)`; `onDidChangeLocks(listener) → {dispose}` (ошибки слушателя перехватываются); setConnected/isConnected.
- НОВЫЙ `RepositoryDumpPlan.ts`: перенос buildPartialDumpPlan (новый результат), resolveSubsystemMemberFullNames, resolveXmlPathByFullName; `RepositoryDumpPlan = {kind:'objects'; fullNames} | {kind:'root-object'} | {kind:'root-incremental'}`; `resolveNewSubsystemMembers(dumpDir, subsystemFullNames, known)`.
- НОВЫЙ `ConfigurationChildObjectsSync.ts`: `syncConfigurationChildObjects(configRoot, {added, removed}, editor: ConfigurationXmlEditor) → {changedFiles, warnings}` (верхнеуровневые виды с folder; вложенные подсистемы и корень пропускаются).
- ИЗМЕНИТЬ `RepositoryService.ts` — фасад: `get lockState()`, `get snapshots()` (создаются в конструкторе; сигнатура `new RepositoryService(root, secrets)` не меняется); isLocked/isRootLocked/setLocked (совместимость), isEditRestricted/isMetadataEditRestricted делегируют в RepositoryLockState; onDidChangeLocks делегирует; createObjectsFileForNode/resolveFullName остаются. >800 строк — вынести env.json/привязку в `RepositoryBindingStore.ts`.
### domain/agent + infra/agent
- `src/domain/agent/AgentCommand.ts`: `AgentCommandOptions.configDumpInfoOnly` → `'config-dump-info-only'` (ручная проверка имени).
- `src/infra/agent/AgentOperationService.ts`: `importPartialFromDatabase` → `dumpToDirectory(target, request: ConfigurationDumpRequest, hooks) → {dir, relativeFiles, dispose()}`; режимы partial / dump-info-only / full; одноразовый workspace; проект не трогается. `ConfigurationDumpRequest` — общий тип в infra/agent или domain/agent.
### ui/commands/ext
- `ExtensionCommandRunner.ts`: удалить runPartialImportFromDatabase/runBatchPartialDump; в конце файла `export const configurationProcessPort = { runInternalCliCommand, runAgentConfigurationOperation, resolveSettingsPath, resolveConnectionFromSettings, buildConnectionCliArgs, createWorkspaceTempDir, removeTempDir }`.
- НОВЫЙ `src/ui/commands/ext/ConfigurationDumpRunner.ts`: `buildExportToTempCliArgs(target, request, tempDir, projectRoot, connectionArgs)` (чистая); `dumpConfigurationToTemp(target, request, workspaceFolder, outputChannel) → {ok:true; handle} | {ok:false; reason}`; batch/agent по isAgentConfigurationOperationMode(); в batch без showErrorMessage; запуск процесса — c8 ignore с обоснованием.
### ui/commands/repository
- `RepositoryCommandRunner.ts`: `executeRepositoryCli(options, services) → RepositoryCliResult`; `runRepositoryCliCommand` — обёртка; экспорт `buildCommandDesignerArgs`; `buildLockExtraArgs(objectsFile) → ['-ObjectsFile', f, '-Revised']`; lock/unlock/update/commit action → чистые запросы CLI без изменения state; удалить maybeRestoreLockSnapshot*.
- НОВЫЙ `RepositoryFileSyncShared.ts`: `RepositoryFileSyncServices` = Pick<CommandServices, configurationOperationGuard|workspaceFolder|outputChannel|repositoryService|projectSecretStorage|supportService|suppressConfigurationReloadForFiles|markChangedConfigurationByFiles|treeProvider|refreshActionsView|reloadEntries>; `RepositoryFileSyncDeps { runRepositoryCli; dumpToTemp; chooseConflictResolution(summary)→'compare'|'replace'|'keep-local'; confirmRollback(summary)→boolean; openDiffs(pairs); notifyBusy; notifyInfo; notifyWarning; notifyError; isFileSyncEnabled; getDirtyFilePaths; now }`, `DEFAULT_REPOSITORY_FILE_SYNC_DEPS`; `ensureRepositoryGuardFree(services, deps, label): boolean`; `applyMergeWithPostMutation(...)`.
- НОВЫЙ `RepositoryFileSyncDialogs.ts`: c8-ignore обёртки модальных showWarningMessage (две кнопки, Esc → keep-local / false); `openMergeDiffs` (vscode.diff + reset readonly, лимит вкладок).
- НОВЫЙ `RepositoryLockSync.ts`: `runRepositoryLockFlow(node, recursive, services, deps)`, `runRepositoryUpdateFlow(node, {recursive, force, version}, services, deps)`.
- НОВЫЙ `RepositoryUnlockSync.ts`: `runRepositoryUnlockFlow(node, {recursive, force}, services, deps)`, `runRepositoryCommitFlow(node, formData, services, deps)`. Все потоки → `RepositoryFlowOutcome = 'done'|'busy'|'failed'|'interrupted'`.
- ИЗМЕНИТЬ `RepositoryCommands.ts`: lock/unlock/update/commit — ensureRepositoryGuardFree первым шагом → диалоги → поток → refreshRepositoryUi; удалить runFileSyncAfter*, buildFileSyncHooks, isFileSyncOnLockUnlockEnabled; ~790 строк.
- `RepositoryDatabaseSync.ts` не меняется.
### ui/readonly + Container
- НОВЫЙ `src/ui/readonly/readonlyTransitionPlan.ts` (без vscode): `planReadonlyTransitions({openFiles:{path,visible}[], changedOwnerFullNames, allObjects, configRoot, ownerOf(path), isRestricted(path)}) → {applyNow:{path,readonly}[], defer:{path,readonly}[]}`.
- НОВЫЙ `EditorReadonlyController.ts` — `register(): vscode.Disposable`.
- `BslReadonlyGuard.ts` — `forget(uri)`.
- `src/Container.ts` `wireReadonlyGuard()` — создать контроллер, в subscriptions.
- `package.json` — описание `syncFilesOnLockUnlock` (убрать «вместо этого полный импорт», описать temp/слияние/диалог).

## 4. Шаги developer (один слой за шаг; после каждого compile + lint + связанные тесты)
1. infra/xml: ConfigDumpInfoReader.
2. infra/cache: HashCache.
3. infra/repository рефакторинг без изменения поведения: RepositoryObjectNames, RepositoryLockState (текущая семантика), RepositoryLockSnapshotStore (перенос), RepositoryDumpPlan (перенос); RepositoryService — фасад; старые тесты зелёные.
4. infra/repository новое поведение: ObjectScope, ConfigDumpInfoDiff, MergePlanner, MergeApplier, ChildObjectsSync; расширение state + события; снимки из temp, откат с удалением лишних, хеш-манифест корня.
5. domain/agent + infra/agent: configDumpInfoOnly; dumpToDirectory.
6. ui/commands/ext: configurationProcessPort, ConfigurationDumpRunner, удаление runPartialImportFromDatabase.
7. ui/commands/repository: executeRepositoryCli + -Revised; FileSyncShared/Dialogs/LockSync/UnlockSync; тонкий RepositoryCommands.
8. ui/readonly + Container + package.json.
Sanity-чеки CLAUDE.md п.4–8 после шагов 3–4.

## 5. План тестов (одним пакетом, 100% новых файлов)
Фикстуры: example/2.21/src/cf (ConfigDumpInfo.xml, Configuration.xml, Catalogs/Контрагенты с Forms/Templates/Command, Catalogs/Валюты с Ext/Help); example/2.20/src/cf; example/2.21/src/cfe/EVOLC; временные копии в os.tmpdir() (рабочая область = копия подмножества cf + Configuration.xml + ConfigDumpInfo.xml + env.json с привязкой + state connected; «версия хранилища» = temp-каталог с изменённой копией объекта; файл с BOM+CRLF). Процесс 1С — внедрённые deps (как repositoryDatabaseSync.test.ts). Guard — настоящий ConfigurationOperationGuard.
1. configDumpInfoReader.test.ts — разбор 2.21 cf / 2.20 cf / EVOLC (число записей с configVersion, конкретные Catalog.Валюты и Configuration.<Имя>.SessionModule), без configVersion игнор, BOM, пустой/битый → пусто/null, нет файла → null.
2. configDumpInfoDiff.test.ts — владелец параметризован (Catalog.X.ObjectModule, Catalog.X.Form.Y.Form, Catalog.X.Template.T.Template, Catalog.X.Command.C.CommandModule, Configuration.X.SessionModule, Subsystem.A.Subsystem.B, AccumulationRegister.R.RecordSetModule); сравнение (идентичные→пусто, изменён модуль, добавлен/удалён, изменён корень); decideRootIncrementalStrategy на границах (0→none, 1, MAX, MAX+1, 50%/51%, null→full).
3. repositoryObjectNames.test.ts — параметризация по всем ключам таблицы (kind→ru→kind), toChildObjectRef, contentRef (неизвестный префикс, UUID), dumpInfoOwnerToRepositoryFullName cf/cfe вкл. Configuration, buildRootDumpListName cf/cfe, isRootLockName.
4. repositoryObjectScope.test.ts — области (объект с Forms/Templates/Ext; плоский XML без каталога; глубокая раскладка; корень; подсистема с вложенными — исключены); неизвестный fullName → null; collectScopeFiles на проекте и temp (ConfigDumpInfo исключён); mapDumpPathToProject flat→deep; resolveOwnerFullNameByRelativePath параметризован.
5. repositoryMergePlanner.test.ts — таблица всех комбинаций R/L/B → действие; forceConflict; skip-incomplete; сирота delete/conflict-delete; isTextMergeFile по .bsl/.xml/.txt/.html/.json/.bin/.png/.zip/без расширения; diffScopeAgainstEtalon.
6. repositoryMergeApplier.test.ts — replace (бэкап по пути, байты = temp с BOM+CRLF, удаление сироты с бэкапом, удаление пустых каталогов только в области); keep-local; compare; хеш-кэш (записанные, удалённые, неподдерживаемые); изменение между планом и применением → бэкап; beforeWrite до записи; ConfigDumpInfo.xml не копируется.
7. repositoryLockSnapshotStore.test.ts — captureFromDirectory; diff (extra/missing/changed); restoreToProject (extras удалены, бэкап); манифест v1; discard/discardAll; корневой манифест (изменить 2 объекта + новый файл → owners); без манифеста → hasManifest:false; битый манифест.
8. repositoryLockState.test.ts (+ repositoryService.test.ts) — миграция v2; мусорные поля; v1 → пусто; матрица переходов; isEditRestricted на реальных путях 2.21 (участник подсистемы, rootRecursive, releasedUnderRoot, isRootLocked только явный); события (payload, dispose, исключение слушателя).
9. configurationChildObjectsSync.test.ts — добавление Справочник.Новый в порядке META_TYPES; BOM/EOL; уже есть; удаление; неизвестный тип → предупреждение; вложенная подсистема и корень пропущены (cf и EVOLC).
10. hashCache.test.ts — patchHashCacheEntries, patchHashCacheForFiles с deletedFiles, computeFileHash.
11. agentOperationService.test.ts — dumpToDirectory partial/dump-info-only/full: строки команд (--list-file, --config-dump-info-only), relativeFiles, проект не изменён, dispose, ошибка агента → отключение ИБ.
12. configurationDumpRunner.test.ts — buildExportToTempCliArgs {Partial, UpdateInfo, Full} × {cf, cfe с -Extension}.
13. repositoryCommandRunner.test.ts (переписать) — lock с -revised; unlock/update/commit флаги; executeRepositoryCli без env.json → failed без showErrorMessage; неизвестная команда → failed.
14. repositoryLockSync.test.ts — порядок вызовов deps и guard.isBusy в момент вызова: предпроверка busy; guard занят к runExclusive; CLI failed; interrupted; настройка выключена; выгрузка упала; без локальных изменений (молча, снимок==temp, suppress до записи, refreshCacheForFiles, markChanged не вызван); конфликт × {compare, replace, keep-local} (диалог при isBusy false; openDiffs только текстовые, isLocked true в момент вызова; бинарные в логе; keep-local → markChanged); несохранённый файл → конфликт; корень нерекурсивно; корень рекурсивно (dump-info→partial изменённых→ConfigDumpInfo заменён, rootRecursive, манифест; нет различий → без второй выгрузки; нет проектного ConfigDumpInfo → full; сбой dump-info → full; порог → full; удалённый владелец → файлы удалены, removeChildObject); рекурсивная подсистема (вторая волна, ChildObjects, reloadEntries, группа расширена); сирота-форма удалена; update (незахваченный без снимка, захваченный пересъём, version/force, сбой).
15. repositoryUnlockSync.test.ts — снимок без изменений; изменения × {откат, оставить, Esc}; нет снимка (unlock→dumpToTemp при isBusy true, диалог при false); нет снимка + настройка выключена; корень рекурсивно с манифестом (без изменений — ноль выгрузок; 2 объекта — partial ровно их); без манифеста и без кэша → пропуск + лог; сбой unlock; рекурсивная подсистема; commit (keepLocked, без, занято, сбой).
16. readonlyTransitionPlan.test.ts — захват → writable (кроме запрещённых поддержкой); отмена → readonly; чужие не трогаются; allObjects; applyNow/defer; вне configRoot игнор; модифицированная сторона диффа.
17. editorReadonlyController.test.ts (Extension Host, заглушка executeCommand как в bslReadonlyGuard.test.ts) — видимый → reset + восстановление активного; скрытая вкладка → после showTextDocument; dispose; forget.
18. configurationOperationGuardCommands.test.ts — repository.lock/unlock/update при занятом guard'е: showQuickPick не вызывается, чужая аренда цела.
c8 ignore (с обоснованием) — только модальные обёртки RepositoryFileSyncDialogs.ts и запуск процесса в ConfigurationDumpRunner.ts.

## 6. Ручная проверка (Конфигуратор) — для issue
1. -revised при захвате (А с устаревшей базой захватывает X после помещения Б → файлы = версия Б).
2. Формат имён -listFile: `Справочник.X`; имя корня (`Конфигурация.<Имя>`?) для cf и cfe; вложенная подсистема.
3. Состав частичной выгрузки (Forms/*/Ext/Form/Module.bsl, Templates/*, Ext/ObjectModule.bsl, ManagerModule.bsl, Help, Predefined.xml); иначе skip-incomplete.
4. Побочные файлы частичной выгрузки (ConfigDumpInfo.xml, Configuration.xml в temp; проектные не меняются).
5. -configDumpInfoOnly во temp (полный ConfigDumpInfo, время, опция агента --config-dump-info-only, изменение configVersion только у полученных).
6. Рекурсивный захват корня: сколько выгружено, время против полного импорта; повтор без изменений — без второго запуска.
7. Семантика unlock без/с -force.
8. Отмена рекурсивного захвата корня / отдельного объекта при рекурсивном корне.
9. commit keepLocked: захват остаётся, unlock не предлагает откат.
10. Получение рекурсивной подсистемы с новым объектом: объект в дереве и в ChildObjects.
11. Нерекурсивный захват корня: только Configuration.xml + Ext; можно создавать объекты.
12. Формы/макеты как отдельные объекты хранилища.
13. Расширение (cfe): захват/отмена/получение, -Extension.
14. Режим агента: подключение после пакетного захвата; ошибка при открытом интерактивном Конфигураторе.
15. Readonly: видимые .bsl/.xml редактируемы без переоткрытия; скрытая вкладка; правая сторона диффа; после отмены — readonly; files.readonlyInclude.
16. Конфликт на реальном сценарии; бэкап; Esc оставляет файлы А помеченными изменёнными.
17. Кодировка и BOM после применения.

## 7. Документация (documenter)
- НОВЫЙ docs/repository-file-sync.md (модель форка; три состояния и таблица действий; диалоги и Esc; бэкапы merge/, снимки и хеш-манифест корня; стратегии выгрузки и порог; skip-incomplete; схема state.json; post-mutation без detect(); readonly-переходы; ручная проверка; ограничения).
- docs/architecture.md: пользователи guard'а RepositoryLockSync/UnlockSync; модули infra/repository/*.
- CLAUDE.md: раскладка каталогов; пункт инварианта «Новая операция хранилища, меняющая файлы проекта»; тех. долги (ONE_C_TYPE_NAMES параллелен META_TYPES; прочие команды хранилища мимо guard'а).
- docs/metadata-navigator.md: автоснятие/установка readonly.

## 8. Риски
- Запрет №17: RepositoryService ≤800 (при необходимости RepositoryBindingStore); RepositoryCommands ~790; ExtensionCommandRunner только уменьшается.
- Запрет №18: в runExclusive только CLI, applyLock/applyUnlock, выгрузка во temp; ассерты isBusy в тестах.
- Запрет №12: побайтовое копирование; единственный редактор существующего XML — ConfigurationXmlEditor.
- Слои: infra/repository/* без vscode; readonlyTransitionPlan без vscode.
- Конкурентность вне аренды — повторная проверка хеша при применении.
- Устаревший флаг «изменено» после молчаливой замены — безвреден.

## Окружение
- Зависимости: `npm ci --ignore-scripts` (уже выполнено). Тесты: `xvfb-run -a npm test`, `xvfb-run -a npm run test:fast`, `MOCHA_GREP='…'`.
- Базовый прогон в этом окружении: 1903 passing / 0 failing / 12 pending.
- Гейт покрытия: `COVERAGE_BASE_REF=origin/main xvfb-run -a npm run coverage:changed`.
- Коммиты — на русском, без упоминаний ИИ/Claude и без трейлеров Co-Authored-By. Ветки не создавать.

## 9. Решения test-writer по неоднозначным сигнатурам (тесты закоммичены в 949df21 — реализовать ИМЕННО так)
1. `RepositoryLockSnapshotStore`/`RepositoryLockState` — КЛАССЫ: `new RepositoryLockSnapshotStore(workspaceRoot)` / `new RepositoryLockState(workspaceRoot)`; `RepositoryService.get lockState()`/`get snapshots()` возвращают инстансы из конструктора.
2. Раскладка снапшотов как в старом `getSnapshotDir`: `.v8vscedit/repository/snapshots/<sha1(scopeKey)>/<sha1(fullName)>/{manifest.json,files/<rel>}` (совместимость с манифестом v1).
3. `applyLock(target,{anchor,members,recursiveRoot})`: `lockGroups[anchor]` только при `members.length > 1`; все members → lockedFullNames и убираются из releasedUnderRoot; `recursiveRoot:true` → rootRecursive=true и releasedUnderRoot обнуляется.
4. `applyUnlock(target,{anchor,members,recursive,isRoot})→string[]`: unlock объекта при rootRecursive удаляет из lockedFullNames И добавляет в releasedUnderRoot. `isLocked(fullName) = lockedFullNames.has || Object.values(lockGroups).some(m=>m.includes) || (rootRecursive && !releasedUnderRoot.includes)`. isConnected/setConnected — `?? true` как в старом коде.
5. `RepositoryObjectNames.ts` экспортирует `ONE_C_TYPE_NAMES`/`ONE_C_TYPE_NAMES_BY_PREFIX` публично. `dumpInfoOwnerToRepositoryFullName('Configuration.X', target)` → `getRootLockName(target)`. `buildRootDumpListName` = `Конфигурация.<displayName>` для cf и cfe.
6. `syncConfigurationChildObjects` принимает added/removed как РУССКИЕ fullName, конвертирует через toChildObjectRef; корень-сентинел и вложенные подсистемы → warnings, не исключение.
7. `extractDumpInfoOwner(name)` = первые два сегмента `Kind.Name`.
8. `ConfigurationDumpRequest` (экспорт из infra/agent) = `{mode:'partial';fullNames}|{mode:'update-info'}|{mode:'full'}`. Batch `buildExportToTempCliArgs` — конвенция CLI `export-configuration` (`-ProjectRoot/-Target/-ConfigDir/-Mode/-Objects/-Extension`), Mode: Partial/UpdateInfo/Full.
9. `executeRepositoryCli`: команда валидируется (`buildCommandDesignerArgs`) ДО обращения к env.json; обе failure-ветки → `{status:'failed', message}` без showErrorMessage.
10. `RepositoryFileSyncDeps.runRepositoryCli(options,services)` → RepositoryCliResult; `dumpToTemp(target,request,services)→{ok:true;dir;dispose()}|{ok:false;reason}`.
11. readonlyTransitionPlan: файл затронут, если ownerOf(path) в changedOwnerFullNames ИЛИ allObjects. Дифф-вкладки — в контроллере.
12. `new EditorReadonlyController(repositoryService, supportService, bslReadonlyGuard, outputChannel)`.
Замечание test-writer: сквозные сценарии порогов ROOT_INCREMENTAL_MAX_*, многораундовой довыгрузки подсистемы и «удалённый владелец → removeChildObject» в flow-тестах не покрыты — developer/qa должны добрать покрытие изменённых строк до 100%.
Mocha грузит все out/test/suite/*.js до grep — пока хоть один модуль отсутствует, падает весь прогон; прогонять тесты после того, как все модули существуют (можно заглушками-экспортами на промежуточном шаге).
