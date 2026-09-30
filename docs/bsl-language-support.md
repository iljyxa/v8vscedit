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

`LspManager` читает настройку `v8vscedit.lsp.mode`. Клиент подписывается на `.bsl`-документы
без `synchronize.fileEvents` (`buildBslAnalyzerDocumentOptions`, `lsp/LspManager.ts`): сервер не
обрабатывает `workspace/didChangeWatchedFiles` и следит за файлами сам, поэтому события клиента —
лишний трафик на каждую выгрузку во временный каталог операции.

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

### Перезапуск при появлении основной конфигурации

`bsl-analyzer` выбирает корень конфигурации только один раз при старте: если тогда основной
выгрузки `src/cf/Configuration.xml` ещё не было, сервер индексирует и отслеживает всю рабочую
область целиком, включая `.v8vscedit/**` — на Windows его watcher держит дескрипторы этих файлов,
из-за чего удаление временных каталогов операций (хранилище, импорт) падает с `ENOTEMPTY`/`EPERM`.

`Container.reloadEntries()` после перестроения дерева вызывает `restartLspOnRootsChange`, который
через `BslAnalyzerRootTracker` (`infra/environment/BslAnalyzerRootTracker.ts`, чистый домен без
`vscode`) перезапускает `LspManager` **ровно** при переходе «нет основной конфигурации → есть»:

- на bootstrap (первое наблюдение) — не перезапускает: сервер и так стартует с текущим составом;
- появление/переименование cfe без основной cf — не перезапускает: сервер `bsl-analyzer` выбирает
  корень по `.toml`, а не по составу расширений;
- исчезновение основной конфигурации — не перезапускает (сервер уже проиндексирован так, как есть,
  откатывать нечего);
- `v8vscedit.lsp.mode = off` — не перезапускает, при последующем включении сервер стартует заново
  и сам увидит актуальный состав.

`BslAnalyzerRootTracker.observe()` хранит только факт «есть/нет основной конфигурации» между
вызовами и не хранит `vscode`-состояние — логика решения (`decideBslAnalyzerRestart`) покрыта
unit-тестами домена, а сам вызов рестарта — тонкая обвязка в `Container.ts`.

## Открытие BSL-модулей

Модули открываются напрямую как `file://` документы. Виртуальная схема `onec://`
не используется.

Readonly для модулей под замком поддержки или хранилища обеспечивают:

1. `OpenModuleCommand` — сразу помечает редактор readonly при открытии из дерева.
2. `BslReadonlyGuard` — перехватывает открытие `.bsl` файлов с диска.

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
