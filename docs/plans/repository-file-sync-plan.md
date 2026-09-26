# План архитектора — issue #1: синхронизация файлов с хранилищем 1С

> Рабочий план FULL-трека issue #1 (архитектор + решения test-writer). Разделы 1–9 реализованы; раздел 10 — доработка по фактам платформы. Реализация выполнена по нему в ветке `feature/repository-lock-unlock-file-sync`; отклонения developer — в комментарии issue #1. Итоговая документация — задача documenter (см. раздел 7).

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
7. «Сравнить» → `openDiffs` пар, только текстовые, ≤ MAX_DIFF_TABS=10, остальные и бинарные — в лог/сообщение (void). Открывать после applyLock (файл редактируем); после vscode.diff для разрешённых — снятие readonly сессии. (Актуальная конвенция сторон и реализация после issue #63 — см. [repository-file-sync.md](../repository-file-sync.md#трёхстороннее-слияние) и [#readonly](../repository-file-sync.md#readonly): слева всегда локальное состояние, справа — версия хранилища, независимо от того, какая сторона — файл проекта; readonly левой стороны снимается через временную вкладку.)
8. temp удаляется в finally.
Esc/закрытие = `keep-local`: конфликтные файлы не трогаются, версия хранилища сохраняется в `.../merge/.../repository/<rel>`, хеш в кэше = хеш хранилища (файлы помечаются изменёнными, markChangedConfigurationByFiles), снимок = версия хранилища; немодальное сообщение (void) с кнопкой «Сравнить». Для получения незахваченного объекта «Сравнить» открывает дифф readonly + подсказка «захватите объект, чтобы перенести правки».

### B. Поток «отмена захвата»
В аренде: CLI unlock → applyUnlock → при необходимости выгрузка во temp (дефекты 3, 10). Вне аренды: эталон на объект (снимок или temp); сравнение с текущими файлами области changed/missing/extra; расхождения → модальный «Откатить к версии хранилища» / «Оставить изменения», Esc = оставить. Откат: бэкап отбрасываемых, восстановление эталона, удаление лишних. При обоих исходах хеш-кэш = хеши эталона; «оставленные» помечаются изменёнными. Post-mutation, снимки удаляются всегда.

### C. Readonly
`RepositoryService.onDidChangeLocks(listener)` без vscode, событие `{ target, fullNames, allObjects }`. `EditorReadonlyController` (ui/readonly) подписан: собирает открытые вкладки tabGroups (TabInputText и TabInputTextDiff.modified, схема file, внутри target.configRoot), желаемое состояние = `supportService.isLocked(f) || repositoryService.isEditRestricted(f)`; чистый `planReadonlyTransitions` → applyNow (видимые) / defer (невидимые), трогаются только файлы объектов события. Видимые: showTextDocument(doc,{viewColumn, preserveFocus:true}) (для диффа — vscode.diff preserveFocus) → set…ReadonlyInSession или reset…ReadonlyInSession (reset уважает files.readonlyInclude) → восстановить исходный активный редактор. Невидимые: pending map, применяется в onDidChangeActiveTextEditor, очистка при onDidCloseTextDocument. `BslReadonlyGuard.forget(uri)` — вызывается контроллером при переходе в writable. (Issue #63 добавил обработку левой file:-стороны диффа — readonly-команда действует лишь на правую сторону активного редактора, поэтому левая сторона снимается/ставится через временную вкладку и применяется сразу, минуя pending; актуальное описание — [repository-file-sync.md#readonly](../repository-file-sync.md#readonly), реализация — `ui/readonly/sessionReadonly.ts` и `ui/readonly/readonlyTabSelection.ts`.)

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


## 10. Доработка по фактам платформы: подчинённые объекты с собственным XML (D1–D3)

> Разделы 1–9 остаются контрактом; раздел 10 заменяет их только там, где это сказано явно («заменяет §…»). Основание — проверки на платформе 1С 8.5.1 (пакетный Конфигуратор, файловые базы, файловое хранилище с двумя пользователями, фикстура `example/2.21/src/cf`), см. 10.12.

### 10.0 Подтверждение дефектов по коду

- **D1.** `RepositoryObjectNames.ts` — `FunctionalOptionsParameter: 'ПараметрФункциональнойОпции'`; платформа принимает только `ПараметрФункциональныхОпций`. Та же таблица идёт и в `-listFile`, и в `Objects.xml` захвата (`RepositoryService.buildRootObjectFullName`).
- **D2.** Частичная выгрузка владельца не включает подчинённые объекты с собственным XML (формы, макеты, перерасчёты, таблицы/кубы/таблицы измерений внешних источников, вложенные подсистемы). Цепочка кода работает на уровне объекта верхнего уровня:
  - `ObjectXmlReader.parseChildren` возвращает только Form/Template/Subsystem;
  - `CHILD_ELEMENT_DIRS`/`collectIncompleteChildDirs` (`RepositoryMergePlanner.ts`) защищают только Forms/Templates/Commands/Subsystems — файлы Recalculations/Tables/Cubes считаются сиротами и удаляются (D2b, потеря данных);
  - снимок пополняется проектными версиями `skip-incomplete` файлов (D2a: откат восстанавливает не версию хранилища);
  - владелец ConfigDumpInfo = два сегмента имени (D2c: изменённая форма не попадает в проект при root-incremental);
  - readonly определяется по владельцу верхнего уровня (`RepositoryService.isEditRestricted`, `resolveOwnerFullNameByRelativePath`, `EditorReadonlyController`) — файлы форм редактируемы при нерекурсивном захвате, хотя на сервере форма не захвачена (D2d).
- **D3.** `resolveSubsystemMemberFullNames` называет вложенную подсистему `Подсистема.B` вместо `Подсистема.A.Подсистема.B`; несуществующее имя роняет всю выгрузку, поэтому рекурсивная подсистема с вложенными не синхронизируется. Обходы `isNestedSubsystemMember`, `includeNestedSubsystems`, `resolveNewSubsystemMembers` опираются на опровергнутое допущение «вложенные приходят в составе родителя».

### 10.1 Критерии приёмки

1. `ONE_C_TYPE_NAMES.FunctionalOptionsParameter === 'ПараметрФункциональныхОпций'`; таблица имён закреплена эталонным тестом со значениями, проверенными на платформе.
2. Рекурсивный захват/получение `Справочник.Контрагенты` (2.21) при наличии XML подчинённых в хеш-кэше: ровно один `dumpToTemp` со списком `Справочник.Контрагенты`, `…Форма.ФормаСписка`, `…Форма.ФормаЭлемента`, `…Макет.ЗагрузкаИзФайла`; файлы форм и макета записаны из выгрузки; 4 снимка (по одному на единицу, манифест v3, `depth: 'unit'`); `lockGroups['Справочник.Контрагенты']` = 4 единицы, `lockModes[…] = 'recursive'`.
3. Нерекурсивный захват/получение `Справочник.Контрагенты`: один `dumpToTemp` со списком `[Справочник.Контрагенты]` (плюс новые в хранилище подчинённые по стратегии `new-subordinates`); файлы `Forms/**`, `Templates/**` существующих подчинённых побайтово не меняются и не удаляются; снимок только у владельца; `isEditRestricted`: файлы форм/макета → `true`, файлы владельца (`Контрагенты.xml`, `Ext/*.bsl`, `Commands/**`) → `false`.
4. Регресс D2b: нерекурсивная и рекурсивная операция над `РегистрРасчета.Начисления` и `ВнешнийИсточникДанных.ИнтернетМагазин` не удаляет `Recalculations/**`, `Tables/**`, `Cubes/**`, `Cubes/*/DimensionTables/**`, если единицы есть в версии хранилища.
5. Рекурсивная операция над `ВнешнийИсточникДанных.ИнтернетМагазин`: выгружены `…Таблица.Заказы`, `…Куб.Продажи`, `…Куб.Продажи.ТаблицаИзмерения.Товары/Регионы`; подчинённые в хеш-кэше → 1 вызов `dumpToTemp`; хеш-кэш пуст по подчинённым → 3 вызова (владелец; таблица + куб; таблицы измерений); все вызовы при `guard.isBusy === true`.
6. Оптимистичный раунд 0 упал (в списке имя, которого нет в «базе») → следующий вызов только якоря, затем раунды по выгруженному XML; итоговый набор единиц совпадает с успешным сценарием; всё в одной аренде.
7. root-incremental: изменены только `Catalog.Контрагенты.Form.ФормаЭлемента(.Form)` → список частичной выгрузки ровно `[Справочник.Контрагенты.Форма.ФормаЭлемента]`; удалённая единица-подчинённый → её файлы удаляются по правилам конфликтов; имена Recalculation/Table/Cube/DimensionTable/`Subsystem.A.Subsystem.B` переводятся в `-listFile` точно по таблице.
8. unlock рекурсивного корня по манифесту: изменён только модуль формы → выгрузка ровно `[Справочник.Контрагенты.Форма.ФормаЭлемента]`; ничего не изменено → Конфигуратор не запускается.
9. Совместимость state.json v2: старая запись (`lockedFullNames: [Справочник.Контрагенты]` без `lockModes`) → файлы форм редактируемы, как раньше; новый нерекурсивный захват → формы readonly; рекурсивный → редактируемы; нерекурсивная отмена после рекурсивного захвата → владелец readonly, формы редактируемы (на сервере остаются захваченными, P4); рекурсивная отмена → всё readonly.
10. Отмена захвата: нерекурсивная → сравнение и откат только в области единицы владельца, снимки подчинённых сохраняются; рекурсивная → каждая единица со своим снимком; подчинённый, созданный локально (нет в `subordinates` снимка владельца) → эталон «пусто» без Конфигуратора; старый снимок (манифест v1/v2 = глубокий) при рекурсивной отмене → область `tree`, без выгрузки.
11. Вложенные подсистемы везде (планы, `-listFile`, `lockGroups`, снимки) называются `Подсистема.A.Подсистема.B`.
12. Контроллер readonly: событие с `…Форма.Y` пересчитывает только вкладки файлов формы Y; событие с `Справочник.X` — вкладки X и его подчинённых.
13. Вывод `parseObjectXml` не меняется: `validate_metadata` для `Начисления` и `ИнтернетМагазин` даёт тот же результат, что до задачи.
14. compile, lint, `coverage:changed` = 100% на изменённых файлах; каждый затронутый production-файл ≤ ~800 строк.

### 10.2 Решения

**Р1. D1.** Исправить литерал; тест — эталон проверенных имён и сопоставление каждого каталога верхнего уровня `example/2.21/src/cf` записи таблицы.

**Р2. Единица хранилища** — объект верхнего уровня ИЛИ подчинённый объект с собственным XML; у единицы свои захват, имя в `-listFile`, запись в ConfigDumpInfo, область файлов и снимок.
- Грамматика имён в трёх алфавитах (единственное место перевода — `RepositoryObjectNames`): fullName хранилища `Тип.Имя(.ПодТипRu.Имя)*`; ChildObjects/ConfigDumpInfo `Kind.Name(.Tag.Name)*`; путь `Folder/Name(/SubFolder/Name)*` с XML `…/Name.xml` (плоская) или `…/Name/Name.xml` (глубокая).
- `REPOSITORY_SUBORDINATE_LAYOUT: Record<RepositorySubordinateTag, {folder, oneCName}>` для тегов Form, Template, Recalculation, Table, Cube, DimensionTable, Subsystem (в `RepositoryObjectNames.ts`, заменяет `CHILD_ELEMENT_DIRS`). Выводится из существующих данных, где они есть (`CHILD_TAG_CONFIG[tag].pathSegment` для Form/Template, `ONE_C_TYPE_NAMES.Subsystem`, `META_TYPES.Subsystem.folder`); литералы — только для Recalculation/Table/Cube/DimensionTable и каталогов Forms/Templates. Это не нарушение запрета №2: эти виды не `MetaKind`; при появлении их в навигаторе `folder` переезжает в реестр (тех. долг в CLAUDE.md). `Command` в таблицу не входит — выгружается вместе с владельцем.
- `parseObjectXml` не расширять (иначе `MetadataValidationService.validateChildTags` начнёт выдавать `disallowed-child`/`unexpected-child`, изменится `MetadataInfoService`). Вместо этого — узкий ридер `readChildObjectRefs` в `infra/xml`.
- Группировка ConfigDumpInfo `extractDumpInfoUnit(name)`: к `Kind.Name` добавляются пары `(Tag, Name)`, пока `Tag` из таблицы и за ним есть сегмент (`Catalog.X.Form.Y.Form` → `Catalog.X.Form.Y`; `Catalog.X.Command.C.CommandModule` → `Catalog.X`; `CommonForm.F.Form` → `CommonForm.F`; `ExternalDataSource.E.Cube.C.DimensionTable.D.Field.F` → `…DimensionTable.D`; `Configuration.X.SessionModule` → `Configuration.X`).

**Р3. Области: глубина `unit`/`tree`.** `ObjectScope` (`object`) получает `depth`; `resolveObjectScope(configRoot, fullName, target, depth = 'tree')` понимает имена единиц. `unit`: `excludeDirRels` = все каталоги таблицы раскладки непосредственно под `dirRel`; `tree`: весь каталог. `includeNestedSubsystems` удаляется. Слияние, снимки, сравнение — `unit`; `tree` — только для единиц, удалённых из хранилища, и старых глубоких снимков. `collectScopeFiles` не обходит исключённые каталоги (горячий путь).

**Р4. Выгрузка подчинённых — оптимистично с откатом** (обычный случай 1 запуск вместо 2–3, редкий +1; корректность не зависит от проектных имён: успех раунда 0 = все имена есть в базе, полнота проверяется по XML владельцев из выгрузки). `runDumpRounds` (infra, выгрузка внедрена функцией):
1. Раунд 0 — якоря + замыкание раскрытия по проектному XML; не-якорные имена — только если основной XML единицы есть в хеш-кэше (при пустом кэше фильтр не применяется). Хеш-кэш загружается ДО аренды.
2. Сбой раунда 0 при списке длиннее якорей → лог и повтор только якорей; повтор упал → `failed`.
3. Раунды 1..N: ожидаемые = раскрытие новых найденных единиц по их XML из выгрузки минус известные; пусто → стоп; сбой раунда → стоп с логом, недовыгруженные → `missing`; `MAX_DUMP_ROUNDS = 5` (заменяет `MAX_SUBSYSTEM_DUMP_ROUNDS`).
4. Найденная единица — её основной XML есть в каталоге раунда; каждый раунд в свой temp; все `dispose` в `finally`; всё в той же аренде.
5. `missing` не входят в слияние, их файлы не трогаются; после аренды — `notifyWarning`.

Стратегии раскрытия `UnitExpansion = (unit, unitXmlPath) => string[]`: `subordinates` (рекурсивный объект; куб раскрывается в таблицы измерений); `subsystem` (рекурсивная подсистема: вложенные `Подсистема.A.Подсистема.B` и участники `<Content>`; для участника — его подчинённые, `SUBSYSTEM_MEMBERS_INCLUDE_SUBORDINATES = true` по P1); `new-subordinates` (нерекурсивная операция: подчинённые якоря из XML версии хранилища, которых нет в проекте — применимо по P2); `towards(wanted)` (отмена захвата без снимка); `none` (root-incremental и откат корня: точные имена, один раунд). Подчинённые, удалённые из хранилища, при рекурсивной операции: подчинённые найденной единицы по проектному XML минус по XML выгрузки → `removed` с областью `tree`; при нерекурсивной — не трогаются, предупреждение в лог.

**Р5. root-incremental по единицам (заменяет §2.10 в части группировки).** `diffConfigDumpInfo(prev, next, keyOf = extractDumpInfoOwner)`, в root-incremental `keyOf = extractDumpInfoUnit`; пороги `ROOT_INCREMENTAL_*` в единицах (значения прежние); `dumpInfoOwnerToRepositoryFullName` принимает единицы (неизвестный тег подчинённого → единица-родитель); удалённые → `tree`; добавленные/изменённые — одним списком, стратегия `none`; в `ChildObjects` `Configuration.xml` — только верхний уровень.

**Р6. Нерекурсивная операция.** Якорь в области `unit` для всех видов из D2; файлы подчинённых исключены из области (не `skip-incomplete`). `collectIncompleteChildDirs`, `CHILD_ELEMENT_DIRS` и импорт `parseObjectXml` из планировщика удаляются; `requirePrimaryFile` остаётся.

**Р7. Состояние захвата (state.json остаётся `version: 2`).**
- Новое необязательное поле `lockModes?: Record<string, 'recursive' | 'object'>` — режим последнего захвата для всех `members` операции; некорректные значения отбрасываются; пустое поле не пишется.
- Рекурсивный захват объекта: `members` = якорь + подчинённые по проекту, после выгрузки — плюс найденные (повторный `applyLock`); нерекурсивный — только якорь.
- `isLocked(target, unit)` = явно в `lockedFullNames` ИЛИ участник группы ИЛИ (`rootRecursive` и не в `releasedUnderRoot`) ИЛИ правило старых записей: предок единицы захвачен явно/через группу и у него нет `lockModes`.
- Нерекурсивная отмена якоря с группой: из группы убирается только якорь (P4); рекурсивная — как раньше; `lockModes` удаляется у освобождённых. Под рекурсивным корнем: нерекурсивная отмена X → в `releasedUnderRoot` только X; рекурсивная → X и его подчинённые.
- `RepositoryLockRequest.mode: 'recursive' | 'object'`.

**Р8. Снимки по единицам.** Снимок на каждую единицу из её каталога выгрузки. Манифест v3: `{version: 3, files, hashes, depth: 'unit' | 'tree', subordinates?: string[]}`; v1/v2 читаются как `depth: 'tree'` без `subordinates`. `restoreToProject` и сравнение отбрасывают файлы снимка вне области. Эталоны отмены (не рекурсивный корень), обход от предков к потомкам: (1) покрыта предком с `tree` → пропуск; (2) свой снимок → `snapshot` (`tree` только если снимок глубокий И отмена рекурсивная); (3) нет снимка, у ближайшего предка снимок v3 с `subordinates` без этой единицы → `empty` без Конфигуратора; (4) иначе → `dump` через `runDumpRounds` (`towards(wanted)`, откат к якорям); единица без выгрузки, чей выгруженный родитель её не перечисляет → `empty`; остальное → `missing` (лог, без эталона, хеш-кэш не патчится). Рекурсивный корень: `diffOwnersAgainstBaseline` группирует по единицам (`resolveLockUnitByRelativePath`). Помещение с `keepLocked` → `captureFromProject` на каждую единицу `members`.

**Р9. Readonly.** `RepositoryService.isEditRestricted(filePath)`: владелец верхнего уровня — как сейчас, плюс суффикс единицы по сегментам пути после каталога объекта (только строковые операции, запрет №11); суффикс пуст → прежняя логика; иначе → `!isLocked(target, unit)`. `isMetadataEditRestricted` — на уровне владельца. `readonlyTransitionPlan`: `ownerOf` → `ownerChainOf(path) => string[]` (единица, затем предки).

**Р10. D3.** Вложенные — `subordinateUnitFullName(parent, 'Subsystem', child)`; `resolveNewSubsystemMembers`, `isNestedSubsystemMember`, `includeNestedSubsystems` удаляются; вложенная подсистема — обычная единица (`Subsystems/A/Subsystems/B.xml` + `…/B/**` без `…/B/Subsystems`).

### 10.3 Файлы и сигнатуры

- **НОВЫЙ** `src/infra/xml/ChildObjectRefsReader.ts`: `readChildObjectRefs(xmlPath, tags: ReadonlySet<string>): {tag; name}[] | null` — прямые дети `<ChildObjects>` корня, только текстовые ссылки; `null` — нет файла/не разбирается. `ObjectXmlReader.ts` — не менять.
- `RepositoryObjectNames.ts`: D1; `RepositorySubordinateTag`, `REPOSITORY_SUBORDINATE_LAYOUT`, `isRepositorySubordinateTag`, `RepositoryUnitPath`, `parseRepositoryUnit`, `formatRepositoryUnit`, `subordinateUnitFullName`, `getRepositoryUnitAncestors`; `parseRepositoryFullName` — только верхний уровень; `dumpInfoOwnerToRepositoryFullName` — единицы.
- `ConfigDumpInfoDiff.ts`: `extractDumpInfoUnit`; `diffConfigDumpInfo(prev, next, keyOf)`.
- `RepositoryObjectScope.ts`: `ScopeDepth`, `depth` в `object`; `resolveObjectScope(…, depth)`; `resolveUnitXmlRel(baseDir, fullName)`; `resolveLockUnitByRelativePath(rel, target)`; `collectScopeFiles` пропускает исключённые каталоги; удалить `includeNestedSubsystems`.
- `RepositoryDumpPlan.ts`: `DumpExpansion`; вариант `{kind: 'objects'; anchors; fullNames; expansion}`; `buildRepositoryDumpPlan(node, objects, recursive, configRoot)`; `resolveXmlPathByFullName` → `resolveUnitXmlRel`; D3; удалить `resolveNewSubsystemMembers`; `SUBSYSTEM_MEMBERS_INCLUDE_SUBORDINATES = true`.
- **НОВЫЙ** `RepositoryDumpRounds.ts` (~300 строк): `UnitExpansion`, `expandSubordinateUnits`, `createSubsystemExpansion`, `createNewSubordinatesExpansion`, `createTowardsExpansion`, `collectUnitClosure`, `buildOptimisticDumpList`, `collectRemovedSubordinates`, `runDumpRounds`, `MAX_DUMP_ROUNDS = 5`.
- `RepositoryMergePlanner.ts`: удалить `CHILD_ELEMENT_DIRS`, `collectIncompleteChildDirs`, импорт `parseObjectXml`.
- `RepositoryLockState.ts`: `lockModes`, `mode`, правило старых записей, частичное усечение группы.
- `RepositoryLockSnapshotStore.ts`: манифест v3, `readSnapshotInfo`, фильтр по области в `restoreToProject`, `diffOwnersAgainstBaseline` по единицам.
- `RepositoryService.ts`: `isEditRestricted` на уровне единицы.
- `RepositoryFileSyncShared.ts`: `resolveMergeScope(…, depth)`; удалить `isNestedSubsystemMember`; `RepositorySubject` + `mode`, `anchors`, `expansion`; `loadBaseHashes` до аренды.
- `RepositoryLockSync.ts`: `acquireObjectsDump` → `runDumpRounds` + `removed` + `missing`; root-incremental по единицам; `applySubjectLock` с `mode`; предупреждение о `missing` вне аренды.
- `RepositoryUnlockSync.ts`: эталоны по Р8 (при росте — вынос в `RepositoryUnlockEtalons.ts`).
- `RepositoryCommandRunner.ts`: `runRepositoryCliCommand(options, services, execute = executeRepositoryCli)`.
- `readonlyTransitionPlan.ts`: `ownerChainOf`; `EditorReadonlyController.ts`: цепочка единиц, публичные `onActiveEditorChanged`/`onDocumentClosed`.
- `RepositoryCommands.ts`, `Container.ts`, `package.json` — без изменений.

### 10.4 Шаги developer (один слой за шаг; после каждого — compile, lint, связанные тесты)

1. D1 (можно отдельным коммитом). 2. infra/xml: `ChildObjectRefsReader`. 3. infra/repository: имена, `ConfigDumpInfoDiff`, области. 4. infra/repository: `RepositoryDumpRounds`, `RepositoryDumpPlan`, `RepositoryMergePlanner`. 5. infra/repository: состояние, снимки, `RepositoryService.isEditRestricted`. 6. ui/commands/repository. 7. ui/readonly. Sanity-чеки CLAUDE.md п.4–8 — после шагов 3–5.

### 10.5 План тестов (один пакет, 100% новых и изменённых строк)

Только копии реальных файлов (`example/2.21/src/cf`: Контрагенты, Начисления, ИнтернетМагазин, FunctionalOptionsParameters, ConfigDumpInfo.xml; `example/2.20/src/cf`; `example/2.21/src/cfe/EVOLC`). Правка текста `.bsl` в копии и удаление реальных файлов допустимы; ручная сборка/правка XML объектов и подсистем — нет. Имитация платформы — хелпер `src/test/suite/support/partialDumpFixture.ts`: копирует ровно основной XML единицы и её каталог без подкаталогов Forms/Templates/Recalculations/Tables/Cubes/DimensionTables/Subsystems (поведение D2 литералом, независимо от production-кода); имя, которого нет в фикстуре → `{ok: false}` (как rc=1); пишет список имён каждого вызова. Харнессы `repositoryLockSync`/`repositoryUnlockSync` переводятся на копию фикстуры (синтетические `<MetaDataObject/>` и `buildSubsystemXml` удаляются в затронутых наборах).

Модули: `repositoryObjectNames`, `childObjectRefsReader` (новый; включая регресс `parseObjectXml`/`validate_metadata`), `configDumpInfoDiff`, `repositoryObjectScope`, `repositoryDumpRounds` (новый), `repositoryMergePlanner`, `repositoryLockState`, `repositoryLockSnapshotStore`, `repositoryLockSync`, `repositoryUnlockSync`, `readonlyTransitionPlan`, `editorReadonlyController`, `repositoryDumpPlan` — ветки по критериям 10.1. Параметризация: теги таблицы (7), `depth`, режим захвата (`recursive`/`object`/старая запись), версия фикстуры (2.20/2.21), вид цели (cf/cfe), исход выгрузки (ok/fail).

### 10.6 Ранее непокрытые ветки

- `resolveMergeScope` без `dumpDir` для объекта не в проекте → unit-тест `null`.
- `conflict-write` при `localHash === null` и базовом хеше → тест `applyMergeWithPostMutation`, `choice ∈ {replace, compare, keep-local}`.
- `captureFetchSnapshots`: рекурсивный корень + конфликт + keep-local; получение на рекурсивно захваченном корне.
- `RepositoryUnlockSync`: помещение без `node.label`; `recaptureSnapshotsFromProject` (объект и корень); ветка `readSnapshotHashes ?? {}` исчезает после Р8.
- `runRepositoryCliCommand` — внедрение `execute` вместо c8 ignore: done/`showSuccessMessage:false`/`afterSuccess` бросает/interrupted/failed.
- `EditorReadonlyController`, скрытая вкладка: `pending` → `onActiveEditorChanged` → `set/reset`; `onDocumentClosed` → `pending` очищен; ожидание по эффекту, не по таймеру.

### 10.7 Фикстуры через Конфигуратор (пользователь)

- **F1.** В `example/2.21/src/cf` (желательно и 2.20): вложенная подсистема `Подсистема.Продажи.Подсистема.Розница` (Content: `Справочник.Контрагенты`) и `…Розница.Подсистема.Интернет` (Content: другой справочник).
- **F2 (желательно).** В `example/2.21/src/cfe/EVOLC`: собственная форма у `Справочник.ев_РабочийПроцесс`.
- **F4.** «Версия хранилища» со структурными отличиями (например `example/2.21/repo-next/`): частичная выгрузка из базы, где в `Справочник.Контрагенты` удалена `ФормаСписка`, добавлена `ФормаВыбора`, изменён модуль `ФормаЭлемента`; в `ИнтернетМагазин` добавлена таблица `Клиенты`, удалена таблица измерения `Регионы`; плюс `-configDumpInfoOnly` той же базы.

### 10.8 Проверки на платформе — выполнены, см. 10.12

### 10.9 Риски

- Сложность отмены захвата (4 источника эталона) — порядок «предки → потомки» и покрытие `tree` проверяются отдельными тестами; `RepositoryUnlockSync` ≤ 800 строк.
- Флаги раскрытия и «оптимистичный список» — по одной константе/функции; переход на двухфазную схему — `optimistic := anchors`.
- Старые записи state.json: формы при старых нерекурсивных захватах остаются редактируемыми до следующего захвата/отмены — описать в документации.
- Хеш-кэш большой конфигурации загружается до аренды; внутри аренды только CLI, `applyLock`/`applyUnlock`, `runDumpRounds` (запрет №18, ассерты `isBusy`).
- Пустые каталоги-контейнеры (`Forms/`) после удаления последней формы остаются — ограничение.
- Слои: `RepositoryDumpRounds`, `ChildObjectRefsReader` без vscode; разбор XML — только `infra/xml`. Запрет №12 — побайтовое копирование. Запрет №2 — тех. долг `REPOSITORY_SUBORDINATE_LAYOUT`.

### 10.10 Документация (documenter)

- `docs/repository-file-sync.md`: единица хранилища и таблица раскладки; области `unit`/`tree`; раунды и откат оптимистичной выгрузки, число запусков; `lockModes` и правило старых записей; манифест v3; алгоритм эталонов отмены; поведение нерекурсивных операций; «повторный захват `-revised` перетирает непомещённые правки в базе, файлы защищает слияние».
- CLAUDE.md, тех. долги: `REPOSITORY_SUBORDINATE_LAYOUT` вне `META_TYPES`; `SupportInfoService.CHILD_FOLDERS_WITH_OWN_XML` дублирует часть таблицы.
- `docs/metadata-navigator.md`: readonly файлов форм/макетов зависит от режима захвата владельца.

### 10.11 Попутные находки вне объёма (issues форка)

1. Захват/отмена/помещение с узла формы или макета захватывает владельца (`RepositoryService.resolveFullName`, `CHILD_LIKE_KINDS`).
2. ~~Значок захвата и `isMetadataEditRestricted` для узлов Form/Template проверяют владельца; панель свойств позволяет править `Forms/Y.xml` незахваченной формы.~~ Закрыто issue #46: дерево, панель свойств и MCP-шлюз содержимого (`assertNodeContentEditable`) проверяют захват формы/макета по её собственной единице, откат к владельцу — только при отсутствии собственного дескриптора.
3. `SupportInfoService.CHILD_FOLDERS_WITH_OWN_XML = ['Forms', 'Templates']`: режим поддержки файлов Recalculations/Tables/Cubes/DimensionTables и вложенных подсистем берётся от владельца.
4. Синтетический XML в наборах тестов вне этой задачи — долг относительно правила «только реальные фикстуры».

### 10.12 Результаты проверок на платформе 1С 8.5.1

Стенд: файловые базы из `example/2.21/src/cf` (ibcmd), файловое хранилище, пользователи Admin и Bob, пакетный Конфигуратор под xvfb.

| Проверка | Результат |
|---|---|
| `-listFile` `Справочник.X`, корень `Конфигурация.<Name>` (cf и cfe `-Extension`) | принимаются; корень cf → `Configuration.xml` + `Ext/**`, cfe → `Configuration.xml` |
| 84 русских имени типов верхнего уровня | приняты все, кроме `ПараметрФункциональнойОпции` (верно `ПараметрФункциональныхОпций`, D1) |
| Состав частичной выгрузки владельца | нет форм, макетов, перерасчётов, таблиц/кубов/таблиц измерений внешних источников, вложенных подсистем; модули, команды, справка, `Rights.xml` есть; побайтово = полной выгрузке |
| Имена подчинённых | `…Форма.Y`, `…Макет.Y`, `РегистрРасчета.X.Перерасчет.Y`, `ВнешнийИсточникДанных.X.Таблица.Y`, `…Куб.Y`, `…Куб.Y.ТаблицаИзмерения.Z`, `Подсистема.A.Подсистема.B` — приняты; `…Команда.Y` — отказ («нельзя сохранить в отдельный XML-файл») |
| Владелец + подчинённые одним списком (P5) | rc=0, без дублей, побайтово = проекту |
| Несуществующее имя в списке (P3) | вся выгрузка rc=1, файлов нет; время = успешной (~1.5 с на базе стенда) |
| Частичная выгрузка и `ConfigDumpInfo.xml` | не пишется |
| `-configDumpInfoOnly` в пустой каталог | только полный `ConfigDumpInfo.xml`, ~1.6 с |
| `configVersion` после захвата/получения | меняется только у полученных единиц (`Catalog.Контрагенты.Form.ФормаЭлемента` и `….Form`) |
| Вложенная подсистема в ConfigDumpInfo (P6) | своя строка `Subsystem.A.Subsystem.B` с `configVersion` |
| Захват владельца без `includeChildObjects` | формы/макеты НЕ захватываются (загрузка модуля формы — «не захвачен в хранилище»); изменённые в хранилище формы НЕ получаются |
| Рекурсивный захват объекта | захватываются и получаются формы и макеты |
| Рекурсивный захват подсистемы (P1) | захватываются участники, их формы и макеты, участники и сами вложенные подсистемы |
| Нерекурсивная отмена после рекурсивного захвата (P4) | снимается только владелец; формы остаются захваченными |
| Нерекурсивные получение/захват при новой форме в хранилище (P2) | новая форма получается в базу («требуется получение объектов»), но не захватывается; удалённая в хранилище форма — не проверено |
| `-revised` | получает версию хранилища; повторный захват уже захваченного объекта перетирает непомещённые правки в базе |
| `unlock` без `-force` при изменённом в базе объекте | rc=1 «Объект … был изменен», ничего не меняется |
| `unlock -force` | объект в базе возвращается к версии хранилища |
| Загрузка захваченного объекта в привязанную базу без аргументов `/ConfigurationRepository*` | проходит (база хранит признак захвата локально); с неверным пользователем хранилища — отказ |

### 10.13 Решения test-writer по неоднозначным сигнатурам раздела 10 (тесты в c25dad5 — реализовать ИМЕННО так)

1. `RepositoryLockRequest.mode?: 'recursive' | 'object'` — необязательное; пропуск = поведение старой записи. `lockModes` пишется всем `members` операции с одним значением, удаляется у освобождённых.
2. `isLocked(target, unit)`: явно ИЛИ участник группы ИЛИ правило рекурсивного корня ИЛИ предок единицы (`getRepositoryUnitAncestors`, от ближайшего) захвачен явно/через группу и у него НЕТ записи в `lockModes`.
3. `RepositoryUnitPath = {kind: MetaKind; name; segments: {tag: RepositorySubordinateTag; name}[]}`; `parseRepositoryUnit`/`formatRepositoryUnit` — round-trip; `subordinateUnitFullName(parent, tag, name)` бросает на нераспознанном `parent`; `getRepositoryUnitAncestors` — от ближайшего к дальнему, `[]` для верхнего уровня и нераспознанного имени.
4. `extractDumpInfoUnit` — в `ConfigDumpInfoDiff.ts`; `diffConfigDumpInfo(prev, next, keyOf = extractDumpInfoOwner)`.
5. `resolveObjectScope(configRoot, fullName, target, depth = 'tree')` понимает единицы; `resolveUnitXmlRel(baseDir, fullName)`; `resolveLockUnitByRelativePath(rel, target)` — самая конкретная единица по пути.
6. `captureFromDirectory(target, fullName, sourceDir, scope, keepFromProject = [], depth: ScopeDepth = 'unit', subordinates?)`; `readSnapshotInfo(target, fullName) → {hashes; depth; subordinates?} | undefined` (v1/v2 → `tree`); `restoreToProject`/сравнение фильтруют файлы снимка по переданной `scope` (`isPathInScope`); `diffOwnersAgainstBaseline` группирует по `resolveLockUnitByRelativePath`.
7. `RepositoryDumpRounds`: `UnitExpansion = (unit, unitXmlPath) => string[]`; `runDumpRounds(request) → {status:'ok'; found:{fullName, dir}[]; missing: string[]; dispose()} | {status:'failed'; reason}`; `removed` — отдельная `collectRemovedSubordinates(target, ownerUnit, projectXmlPath, dumpXmlPath): string[]`; список раунда 0 длиннее `anchors` и упал → повтор только `anchors`; равен `anchors` и упал → сразу `failed`; `optimistic: false` для `towards`/`none`.
8. `readonlyTransitionPlan`: `ownerChainOf(path) => string[]`; файл затронут, если хоть одно звено в `changedOwnerFullNames ∪ allObjects`.
9. `EditorReadonlyController`: публичные идемпотентные `onActiveEditorChanged(editor | undefined)` и `onDocumentClosed(document)`.
10. `resolveMergeScope(target, fullName, dumpDir, depth: ScopeDepth)`.
11. `runRepositoryCliCommand(options, services, execute = executeRepositoryCli)`.
12. `RepositoryMergePlanner`: `CHILD_ELEMENT_DIRS`/`collectIncompleteChildDirs`/импорт `parseObjectXml` удалены; `incomplete`/`requirePrimaryFile` остаются.
13. `buildRepositoryDumpPlan` в новой форме отдельным юнит-тестом не зафиксирован — наблюдается через потоки; сквозные flow-сценарии (критерии 10.1.2, 5–8, 10) добираются после реализации сборки потоков.
