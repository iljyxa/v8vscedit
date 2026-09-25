# Языковая поддержка BSL

## Назначение

Языковая поддержка BSL работает только через внешний LSP-сервер `bsl-analyzer`.
Расширение отвечает за жизненный цикл клиента: находит или скачивает бинарник,
запускает его в режиме `lsp`, подключает к `.bsl`-файлам и показывает состояние
в статус-баре.

Встроенного tree-sitter сервера в проекте нет. Ветка `built-in`, wasm-грамматики
и локальные провайдеры completion/hover/diagnostics удалены, чтобы не было двух
источников поведения.

## Архитектура

```
VS Code Extension Process (dist/extension.js)
    ├── LspManager
    │   ├── BslAnalyzerService      # установка, обновление, путь к бинарнику
    │   └── BslAnalyzerStatusBar    # состояние сервера в статус-баре
    │
    └── LanguageClient (stdio)
        └── bsl-analyzer lsp
```

`LspManager` читает настройку `v8vscedit.lsp.mode`.

Допустимые значения:

| Значение | Поведение |
|---|---|
| `bsl-analyzer` | Запустить внешний `bsl-analyzer lsp` |
| `off` | Не запускать языковой сервер |

## Настройки

| Настройка | Назначение |
|---|---|
| `v8vscedit.lsp.mode` | Включает `bsl-analyzer` или отключает LSP |
| `v8vscedit.bslAnalyzer.autoUpdate` | Проверять обновления при запуске |
| `v8vscedit.bslAnalyzer.path` | Использовать пользовательский путь к бинарнику |

Если `v8vscedit.bslAnalyzer.path` пустой, расширение хранит скачанный бинарник
в `globalStorageUri/bsl-analyzer`.

## Запуск

`LspManager.startWithAutoUpdate()`:

1. Запускает LSP по текущей настройке.
2. При режиме `bsl-analyzer` вызывает `BslAnalyzerService.ensureBinary()`.
3. Создаёт `LanguageClient` с командой `bsl-analyzer lsp`.
4. Подписывает клиент на `file://` документы языка `bsl`.
5. При включённом `autoUpdate` планирует проверку обновления через 30 секунд.

Для диагностики доступны команды:

| Команда | Назначение |
|---|---|
| `v8vscedit.bslAnalyzer.showMenu` | Открыть меню управления |
| `v8vscedit.bslAnalyzer.restart` | Перезапустить LSP |
| `v8vscedit.bslAnalyzer.update` | Проверить обновления |
| `v8vscedit.bslAnalyzer.showOutput` | Показать лог |

## Открытие BSL-модулей

Модули открываются напрямую как `file://` документы. Виртуальная схема `onec://`
не используется.

Readonly для модулей под замком поддержки или хранилища обеспечивают:

1. `OpenModuleCommand` — сразу помечает редактор readonly при открытии из дерева.
2. `BslReadonlyGuard` — перехватывает открытие `.bsl` файлов с диска.

### Определение режима поддержки BSL-модуля

Замок поддержки (`SupportMode`: `None`/`Editable`/`Locked`/`Removed` — трактовка кодов
`ParentConfigurations.bin` и формат файла подробно описаны в
[architecture.md](./architecture.md#режим-поддержки-поставщика-parentconfigurationsbin)) хранится по
UUID объекта, а UUID нужно взять из XML — модуль сам по себе его не содержит.
`SupportInfoService.resolveObjectXmlForBsl` (`infra/support/SupportInfoService.ts`) находит нужный XML
по пути к `.bsl`-файлу:

- модуль формы или макета (`.../{Forms|Templates}/<Имя>/Ext/...`) — берёт собственный XML
  `.../{Forms|Templates}/<Имя>.xml`, если он есть;
- иначе (модуль объекта, менеджера, команды и т.п.) — режим определяется по XML объекта-владельца.
  Владелец ищется через `findObjectXmlInFolder` (`infra/fs/ObjectLocation.ts`): сначала глубокая форма
  `<Папка>/<Имя>/<Имя>.xml`, затем плоская `<Папка>/<Имя>.xml`; стандартная выгрузка Конфигуратора —
  плоская, поэтому без этого поиска режим поддержки BSL-модулей почти никогда не определялся.
- если владелец не найден — режим `SupportMode.None`, событие пишется в лог как
  `[support] XML объекта не найден: <папка>/<имя>`. Исключение — конфигурация с флагом «изменения
  запрещены» в заголовке `.bin`: тогда `SupportInfoService.getSupportMode` возвращает `Locked` для
  ЛЮБОГО файла под её корнем ещё до поиска XML владельца, поиск XML в этом случае не выполняется
  вовсе (см. [architecture.md](./architecture.md#режим-поддержки-поставщика-parentconfigurationsbin)).

Режим команды объекта — приближение: у `<Command uuid=…>` внутри XML владельца свой UUID, и его
режим в `ParentConfigurations.bin` в принципе может отличаться от режима владельца, но поиск UUID
дочернего элемента внутри XML владельца не выполняется — модуль команды всегда наследует режим
владельца.

## Сборка

Webpack собирает только клиент расширения, тестовый entry и CLI:

```javascript
entry: {
  extension: './src/extension.ts',
  'test/runTests': './src/test/runTests.ts',
  'cli/onec-tools': './src/cli/onec-tools.ts',
}
```

Отдельного `dist/server.js` и копирования wasm-файлов нет.
