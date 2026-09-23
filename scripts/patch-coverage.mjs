// Patch-покрытие: 100% на коде, РЕАЛЬНО затронутом изменением, без ложных падений
// на легаси. Мотивация: глобальный `coverage --100` всегда красный из-за
// унаследованного долга, а гейт «весь изменённый файл → 100%» блокирует на старых
// непокрытых строках внутри модифицированного файла. Правильный критерий —
// покрытие самого патча (industry-standard patch coverage).
//
// Правила:
//   • НОВЫЙ файл (неотслеживаемый) — все исполняемые строки должны быть покрыты (=100%).
//   • МОДИФИЦИРОВАННЫЙ файл — покрыты должны быть только ДОБАВЛЕННЫЕ/изменённые строки
//     (из `git diff -U0 <база>`, см. COVERAGE_BASE_REF); легаси-строки того же файла не трогаем.
//     Закоммиченный в ветке новый файл при явной базе целиком попадает в дифф — эквивалент «нового».
//   • Чисто-типовой файл и composition root (Container/extension) — вне гейта.
//
// Источник данных — `coverage/lcov.info` (те же цифры, что и `coverage:report`).
// Использование: `npm run coverage:changed` (стадия qa-e2e TDD-конвейера).
//
// Параметры:
//   • COVERAGE_BASE_REF=<ref> — база сравнения (по умолчанию HEAD, т.е. только незакоммиченное).
//     Для закоммиченной ветки: `COVERAGE_BASE_REF=main npm run coverage:changed`. Сравнение идёт
//     с точкой ответвления (`git merge-base <ref> HEAD`), чтобы ушедший вперёд ref не подмешал
//     в патч чужие изменения. Если база задана явно, а изменений нет — это ошибка вызова (exit 2).
//   • --ignore-test-failures (или COVERAGE_IGNORE_TEST_FAILURES=1) — не останавливаться на
//     упавших тестах, а считать покрытие по сформированному lcov. Регресс ловит отдельный
//     полный `npm test` стадии qa; флаг нужен, когда красное — унаследованные падения вне патча.

/* global console, process */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const IGNORE_TEST_FAILURES =
  process.argv.includes('--ignore-test-failures') || process.env.COVERAGE_IGNORE_TEST_FAILURES === '1';
const EXPLICIT_BASE_REF = process.env.COVERAGE_BASE_REF?.trim() || undefined;

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
  } catch {
    return '';
  }
}

// Container/extension исполняются в Extension Host, который c8 не инструментирует
// (тонкие адаптеры, покрываются интеграционно) — из гейта исключены.
// Тот же класс уникально-неинструментируемых оркестраторов:
//   • src/cli/onec-tools.ts — самовыполняющаяся точка входа CLI (`void main()` на
//     верхнем уровне модуля), исполняется только как отдельный процесс
//     `node dist/cli/onec-tools.js`; покрывается E2E-тестом
//     src/test/suite/cliProcess.test.ts (спавн собранного бинарника), но c8 не
//     видит её из-за exclude dist/** до source-map ремапа.
//   • src/cli/commands/listDbExtensions.ts — CLI-оркестратор спавна реального
//     Конфигуратора 1С; в CI в процесс не загружается (только через тот же спавн
//     бинарника), поэтому lcov-записи нет вовсе. Вся тестируемая логика (разбор
//     вывода) вынесена в infra/environment/ExtensionListParser.ts (100%).
//   • src/ui/commands/ext/ExtensionCommands.ts — регистрация vscode-команд,
//     исполняется только в Extension Host при активации (как Container/extension);
//     решающая логика выбора вынесена в planExtensionChoices (100%). Ср.:
//     инструментируется лишь ExtensionCommandRunner.ts (извлечённая логика).
const NOT_INSTRUMENTED = new Set([
  'src/Container.ts',
  'src/extension.ts',
  'src/cli/onec-tools.ts',
  'src/cli/commands/listDbExtensions.ts',
  'src/ui/commands/ext/ExtensionCommands.ts',
]);

function isProdTs(f) {
  return (
    f.startsWith('src/') &&
    f.endsWith('.ts') &&
    !f.startsWith('src/test/') &&
    !f.endsWith('.d.ts') &&
    !NOT_INSTRUMENTED.has(f)
  );
}

function resolveBase() {
  if (!EXPLICIT_BASE_REF) return 'HEAD';
  const base = git(['merge-base', EXPLICIT_BASE_REF, 'HEAD']).trim();
  if (!base) {
    console.error(`[coverage:changed] Не удалось найти общую точку HEAD и COVERAGE_BASE_REF=${EXPLICIT_BASE_REF}.`);
    process.exit(2);
  }
  return base;
}

const BASE = resolveBase();

const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .map((s) => s.trim())
  .filter((f) => f && isProdTs(f) && existsSync(path.join(ROOT, f)));

// Diff базы с рабочим деревом: закоммиченные в ветке и незакоммиченные правки вместе.
const modified = git(['diff', '--name-only', BASE])
  .split('\n')
  .map((s) => s.trim())
  .filter((f) => f && isProdTs(f) && !untracked.includes(f) && existsSync(path.join(ROOT, f)));

const changed = [...untracked, ...modified];
if (changed.length === 0) {
  if (EXPLICIT_BASE_REF) {
    // Явная база без изменений почти всегда означает ошибку вызова (не та ветка/ref),
    // а не «нечего проверять» — молчаливый зелёный здесь маскировал бы непроверенный патч.
    console.error(`[coverage:changed] Относительно COVERAGE_BASE_REF=${EXPLICIT_BASE_REF} изменённых production-файлов нет — проверьте ref.`);
    process.exit(2);
  }
  console.log('[coverage:changed] Незакоммиченных изменений production-файлов нет — проверять нечего.');
  console.log('[coverage:changed] Если изменения задачи уже закоммичены, укажите базу: COVERAGE_BASE_REF=main npm run coverage:changed');
  process.exit(0);
}

// Добавленные/изменённые строки модифицированного файла из unified=0 diff.
function addedLines(rel) {
  const diff = git(['diff', '--unified=0', BASE, '--', rel]);
  const lines = new Set();
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of diff.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i += 1) lines.add(start + i);
  }
  return lines;
}

// Эвристика «чисто-типового» файла (нет исполняемого кода → нет покрытия — это норма).
function isTypeOnly(rel) {
  const stripped = readFileSync(path.join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return stripped.every(
    (l) =>
      l.startsWith('import ') ||
      l.startsWith('export type') ||
      l.startsWith('export interface') ||
      l.startsWith('export {') ||
      l.startsWith('type ') ||
      l.startsWith('interface ') ||
      l === '}' ||
      /^[|&?]/.test(l) ||
      /[;,{]$/.test(l)
  );
}

console.log(`[coverage:changed] База сравнения: ${EXPLICIT_BASE_REF ? `${EXPLICIT_BASE_REF} (${BASE.slice(0, 10)})` : 'HEAD'}`);
console.log('[coverage:changed] Проверяю patch-покрытие по файлам:');
for (const f of untracked) console.log('  • (новый)', f);
for (const f of modified) console.log('  • (изменён)', f);

const runStartedAt = Date.now();
const run = spawnSync('npx', ['c8', '--reporter=lcov', '--reporter=text', 'npm', 'test'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
// Прерывание (сигнал) или сбой запуска — не «упавшие тесты»: lcov неполного прогона
// дал бы заниженные цифры, поэтому флаг --ignore-test-failures здесь не действует.
if (run.signal || run.error) {
  console.error(`[coverage:changed] Прогон не завершился: ${run.signal ?? run.error?.message}.`);
  process.exit(1);
}
if (run.status !== 0) {
  if (!IGNORE_TEST_FAILURES) {
    console.error('[coverage:changed] npm test упал — сначала почини тесты.');
    console.error('[coverage:changed] Если падения унаследованные и вне патча: npm run coverage:changed -- --ignore-test-failures');
    process.exit(run.status ?? 1);
  }
  console.warn(`[coverage:changed] npm test завершился с кодом ${run.status ?? 'null'} — продолжаю по --ignore-test-failures; регресс проверяется отдельным прогоном npm test.`);
}

const lcovPath = path.join(ROOT, 'coverage', 'lcov.info');
if (!existsSync(lcovPath)) {
  console.error(`[coverage:changed] Не найден ${lcovPath} — c8 не сформировал lcov.`);
  process.exit(1);
}
// lcov от прошлого запуска дал бы цифры чужого прогона — особенно опасно, когда
// падение тестов разрешено и код процесса больше не сигналит о сбое c8.
if (statSync(lcovPath).mtimeMs < runStartedAt) {
  console.error(`[coverage:changed] ${lcovPath} не обновлён этим прогоном — c8 не сформировал свежий lcov.`);
  process.exit(1);
}

// Разбор lcov в карту: absPath → { da: Map<line,hits>, brda: Map<line,taken[]> }.
function parseLcov(text) {
  const files = new Map();
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const p = line.slice(3);
      cur = { da: new Map(), brda: new Map() };
      files.set(path.resolve(ROOT, p), cur);
    } else if (cur && line.startsWith('DA:')) {
      const [ln, hits] = line.slice(3).split(',');
      cur.da.set(Number(ln), Number(hits));
    } else if (cur && line.startsWith('BRDA:')) {
      const [ln, , , taken] = line.slice(5).split(',');
      const arr = cur.brda.get(Number(ln)) ?? [];
      arr.push(taken);
      cur.brda.set(Number(ln), arr);
    } else if (line === 'end_of_record') {
      cur = null;
    }
  }
  return files;
}

const lcov = parseLcov(readFileSync(lcovPath, 'utf-8'));
const offenders = [];

for (const rel of changed) {
  const abs = path.resolve(ROOT, rel);
  const entry = lcov.get(abs);
  const isNew = untracked.includes(rel);

  if (!entry) {
    if (isTypeOnly(rel)) {
      console.log(`[coverage:changed] ${rel}: чисто-типовой файл — покрытие не применимо, ок.`);
    } else {
      offenders.push(`${rel}: НЕТ данных покрытия (не загружен тестами) — нужен тест`);
    }
    continue;
  }

  // Целевые строки: для нового файла — все исполняемые (DA), для изменённого — только добавленные.
  const target = isNew ? new Set(entry.da.keys()) : addedLines(rel);
  const uncoveredLines = [];
  const uncoveredBranches = [];
  for (const ln of target) {
    if (entry.da.has(ln) && entry.da.get(ln) === 0) uncoveredLines.push(ln);
    const branches = entry.brda.get(ln);
    if (branches && branches.some((t) => t === '-' || t === '0')) uncoveredBranches.push(ln);
  }
  if (uncoveredLines.length || uncoveredBranches.length) {
    const parts = [];
    if (uncoveredLines.length) parts.push(`строки ${uncoveredLines.sort((a, b) => a - b).join(',')}`);
    if (uncoveredBranches.length) parts.push(`ветки на строках ${[...new Set(uncoveredBranches)].sort((a, b) => a - b).join(',')}`);
    offenders.push(`${rel}: не покрыто — ${parts.join('; ')}`);
  }
}

if (offenders.length > 0) {
  console.error('\n[coverage:changed] RED — patch-покрытие ниже 100%:');
  for (const o of offenders) console.error('  ✗', o);
  console.error('\nПокрой эти строки/ветки тестом либо (для осознанно недостижимой защиты) пометь /* c8 ignore */ с обоснованием.');
  process.exit(1);
}

console.log('\n[coverage:changed] GREEN — весь патч (новые файлы + изменённые строки) покрыт на 100%.');
