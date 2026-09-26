#!/usr/bin/env bash
# QA-гейт конвейера v8vscedit: механическая стадия вместо LLM-агента qa-e2e.
#
# Зачем скрипт, а не агент: стадия сводится к запуску команд, а LLM-агент на каждом прогоне
# заново читает контекст проекта и логи тестов. Агент qa-e2e зовётся только когда гейт красный,
# чтобы разобрать причину по полному логу.
#
# Почему один прогон: `coverage:changed` сам запускает полный `npm test` (вместе с pretest) под c8,
# поэтому отдельный `npm test` перед ним дублировал сборку и регресс-прогон.
#
# Использование: bash .claude/scripts/qa-gate.sh [база]   (по умолчанию база — main)
# Выход: 0 — GREEN, 1 — RED. Полный лог — в $QA_GATE_LOG (по умолчанию out/qa-gate.log).

set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1

BASE_REF="${1:-${COVERAGE_BASE_REF:-main}}"
LOG="${QA_GATE_LOG:-out/qa-gate.log}"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

status=0
fail() { echo "RED  $*"; status=1; }
pass() { echo "OK   $*"; }

MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null)" || {
  echo "RED  не найдена общая точка HEAD и '$BASE_REF'"
  exit 1
}

# Изменения задачи: коммиты ветки от точки ответвления + незакоммиченное + новые файлы.
CHANGED="$( { git diff --name-only "$MERGE_BASE"; git ls-files --others --exclude-standard; } | sort -u )"
if [ -z "$CHANGED" ]; then
  echo "QA-гейт: относительно $BASE_REF изменений нет — проверять нечего."
  exit 0
fi

# Рантайм — всё, что влияет на сборку или тесты. Остальное (.claude/**, docs/, .gitignore) —
# нерантайм-изменение: полный прогон не нужен (см. docs/agentic-pipeline.md).
# example/ — фикстуры тестов; syntaxes/snippets/language-configuration — contributes из package.json.
RUNTIME="$(printf '%s\n' "$CHANGED" | grep -E '^(src/|src-ui/|scripts/|example/|syntaxes/|snippets/|language-configuration\.json$|package(-lock)?\.json$|tsconfig[^/]*\.json$|vite\.[^/]*$|\.c8rc|\.mocharc|eslint\.config)' || true)"

echo "QA-гейт: база $BASE_REF (${MERGE_BASE:0:10}), изменено файлов: $(printf '%s\n' "$CHANGED" | wc -l), рантайм: $(printf '%s' "$RUNTIME" | grep -c . || true)"

if npm run lint >>"$LOG" 2>&1; then pass "lint"; else fail "lint (см. $LOG)"; fi

# Sanity-чеки архитектурных инвариантов из CLAUDE.md.
sanity() {
  local title="$1"; shift
  local hits rc
  hits="$(rg -n "$@" 2>&1)"; rc=$?
  # rg: 0 — есть совпадения, 1 — нет, 2+ — ошибка вызова (её нельзя принимать за «чисто»).
  case $rc in
    1) pass "sanity: $title" ;;
    0) fail "sanity: $title"; printf '%s\n' "$hits" | head -5 | sed 's/^/       /' ;;
    *) fail "sanity: $title — ошибка rg (код $rc): $(printf '%s' "$hits" | head -1)" ;;
  esac
}
sanity "typeToFolder" "typeToFolder\s*:" src
sanity "vscode в domain/infra" "import .* from 'vscode'" src/domain src/infra
sanity "cli в domain/infra" "from ['\"].*cli|from ['\"].*/cli" src/domain src/infra
sanity "require/readFileSync в domain" "require\(|readFileSync" src/domain
sanity "FOLDER_MAP/FOLDER_RU" "FOLDER_MAP|FOLDER_RU" src

if [ -z "$RUNTIME" ]; then
  echo "N/A  npm test / coverage:changed — нерантайм-изменение"
  [ $status -eq 0 ] && echo "ИТОГ: GREEN" || echo "ИТОГ: RED"
  exit $status
fi

RUN=()
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then RUN=(xvfb-run -a); fi

# pretest (typecheck + сборка + test:compile) выполняется внутри npm test, отдельный compile не нужен.
# Какие файлы подлежат покрытию, решает только patch-coverage.mjs (isProdTs, NOT_INSTRUMENTED):
# дублировать фильтр здесь — второй источник правды.
COVERED=1
COVERAGE_BASE_REF="$BASE_REF" "${RUN[@]}" npm run coverage:changed >>"$LOG" 2>&1
code=$?
gate="coverage:changed (npm test под c8)"
if [ $code -eq 2 ] && grep -q 'изменённых production-файлов нет' "$LOG"; then
  # Правки только в тестах/фикстурах/сборке/Container.ts: покрывать нечего, нужен лишь регресс.
  # coverage:changed отказывает до запуска тестов, так что прогон здесь не дублируется.
  COVERED=0
  "${RUN[@]}" npm test >>"$LOG" 2>&1
  code=$?
  gate="npm test (файлов для patch-покрытия нет)"
fi

# mocha красит вывод ANSI-кодами — снимаем их, иначе итоговые строки не находятся.
PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "$LOG")"
echo "---- тесты"
printf '%s\n' "$PLAIN" | grep -E '^\s+[0-9]+ (passing|failing|pending)' | sed 's/^ */     /'
if printf '%s\n' "$PLAIN" | grep -qE '^\s+[0-9]+ failing'; then
  # Блок mocha со списком упавших: заголовки «N) suite / test» и первая строка ошибки.
  printf '%s\n' "$PLAIN" | awk '/^ +[0-9]+ failing/{f=1;next} f' | grep -E '^\s+[0-9]+\) |Error|expected' | head -30 | sed 's/^ */     /'
fi
if [ $COVERED -eq 1 ]; then
  echo "---- покрытие изменённого"
  printf '%s\n' "$PLAIN" | grep -E '^\[coverage:changed\]|✗' | head -40 | sed 's/^/     /'
fi

if [ $code -eq 0 ]; then pass "$gate"; else fail "$gate — код $code (см. $LOG)"; fi

[ $status -eq 0 ] && echo "ИТОГ: GREEN" || echo "ИТОГ: RED — разбор причины: агент qa-e2e по $LOG"
exit $status
