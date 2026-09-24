// Сборка тестовой конфигурации «на поддержке» из обычного .cf — воспроизводимо, без GUI Конфигуратора.
//
// Зачем: фикстурам example/ нужна настоящая поддержка поставщика (Ext/ParentConfigurations.bin и
// копия конфигурации поставщика Ext/ParentConfigurations/<Имя>.cf) с разными правилами по объектам.
// Руками это делается в Конфигураторе («Создать файлы поставки» → загрузка в пустую базу →
// «Настройка поддержки»), а пакетного режима для правил по объектам у платформы нет.
//
// Конвейер:
//   1. база A ← исходный .cf; `1cv8 DESIGNER /CreateDistributionFiles` → vendor.cf (файл поставки);
//   2. база B ← vendor.cf: загрузка файла поставки в пустую базу ставит конфигурацию на поддержку
//      (изменения запрещены, копия поставщика совпадает с конфигурацией);
//   3. выгрузка B в XML, правка ParentConfigurations.bin по файлу правил + копия поставщика в
//      Ext/ParentConfigurations/<Имя>.cf;
//   4. база C ← правленый XML → итоговый .cf; повторная выгрузка C сверяется с желаемыми правилами
//      (платформа при импорте проверяет .bin, так что это и есть проверка корректности);
//   5. (--extension) расширение (каталог XML-выгрузки или .cfe) загружается в базу C поверх итоговой
//      конфигурации — платформа проверяет, что оно применимо, — и сохраняется в <Имя>.cfe;
//   6. (--export) выгрузка итогового .cf (и расширения) в XML: платформа 8.5 → формат 2.21,
//      8.3.27 → формат 2.20. Расширение в 8.3.27 переносится через .cfe: XML формата 2.21 она не читает.
//
// Формат ParentConfigurations.bin (установлен экспериментом: платформа соблюдает правила при
// импорте XML — редактирование объекта с правилом 0 отбивается «редактирование … запрещено»):
//   {6,<изменения запрещены 1|0>,<число поставщиков>,<uuid>,<копия поставщика совпадает 1|0>,<uuid>,
//    "<версия>","<поставщик>","<имя>",<число записей>, <a>,<b>,<uuid объекта>,<uuid объекта>, …, <хвост>}
//   a: 0 — объект поставщика не редактируется, 1 — редактируется с сохранением поддержки,
//      2 — снят с поддержки. Смысл b не установлен, скрипт его не трогает.
//
// Использование:
//   node example/tools/build-supported-cf.mjs --source <исходный.cf> --out <каталог> \
//     [--rules example/tools/support-rules.json] [--vendor <файл поставки.cf>] \
//     [--extension <каталог XML расширения | файл.cfe> [--extension-name <Имя>]] [--export]
// --vendor — готовый файл поставки вместо создания нового (для повторяемой пересборки: например
// Ext/ParentConfigurations/<Имя>.cf из текущей фикстуры). Задавать только если исходник не менялся.
// --extension-name нужен только для .cfe; у каталога XML имя берётся из его Configuration.xml.
// Платформы: V8_PLATFORM_DIR (по умолчанию /opt/1cv8/x86_64/8.5.1.1529) и V8_PLATFORM_DIR_220
// (по умолчанию /opt/1cv8/x86_64/8.3.27.2342, нужна только для --export формата 2.20).
// Без дисплея Конфигуратор запускается через xvfb-run.

/* global console, process */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULE_CODES = { locked: '0', editable: '1', removed: '2' };
const VALUE_OPTIONS = ['source', 'out', 'rules', 'vendor', 'extension', 'extension-name'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HEADER_RE = new RegExp(`^\\{6,(\\d+),(\\d+),(${UUID}),(\\d+),(${UUID}),"[^"]*","[^"]*","([^"]*)",`);
const RECORD_RE = new RegExp(`(^|,)(\\d+),(\\d+),(${UUID}),\\4(?=,)`, 'g');

const args = parseArgs(process.argv.slice(2));
const platformDir = process.env.V8_PLATFORM_DIR ?? '/opt/1cv8/x86_64/8.5.1.1529';
const platformDir220 = process.env.V8_PLATFORM_DIR_220 ?? '/opt/1cv8/x86_64/8.3.27.2342';

main();

function main() {
  const source = path.resolve(requireArg('source'));
  const outDir = path.resolve(requireArg('out'));
  const rulesPath = path.resolve(
    args.rules ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'support-rules.json')
  );
  const rules = loadRules(rulesPath);
  const work = path.join(outDir, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const vendorCf = path.join(outDir, 'vendor.cf');
  if (args.vendor) {
    // Каждый /CreateDistributionFiles выдаёт новый идентификатор поставки (он попадает в .bin,
    // копию поставщика и ConfigDumpInfo.xml) — переиспользование готового файла поставки
    // делает пересборку без изменения исходника байт-в-байт повторяемой.
    step('1. Файл поставки: переиспользуется --vendor');
    copyFileSync(path.resolve(args.vendor), vendorCf);
  } else {
    step('1. Файл поставки из исходной конфигурации');
    const baseA = createBase(work, 'A');
    ibcmd(baseA, 'infobase', 'config', 'load', source);
    ibcmd(baseA, 'infobase', 'config', 'apply', '--force');
    rmSync(vendorCf, { force: true });
    designer(baseA, work, '/CreateDistributionFiles', '-cffile', vendorCf);
  }

  step('2. Загрузка файла поставки в пустую базу (постановка на поддержку)');
  const baseB = createBase(work, 'B');
  ibcmd(baseB, 'infobase', 'config', 'load', vendorCf);
  const xmlDir = path.join(work, 'xml');
  ibcmd(baseB, 'infobase', 'config', 'export', xmlDir);

  step('3. Правила поддержки по объектам');
  const binPath = path.join(xmlDir, 'Ext', 'ParentConfigurations.bin');
  const names = readDumpInfoNames(path.join(xmlDir, 'ConfigDumpInfo.xml'));
  const { text, bom } = readBin(binPath);
  const header = HEADER_RE.exec(text);
  if (!header) {
    fail(`не распознан заголовок ${binPath}: конфигурация не встала на поддержку?`);
  }
  const vendorName = header[6];
  const desired = resolveRules(text, names, rules);
  writeFileSync(binPath, Buffer.concat([bom, Buffer.from(applyRules(text, desired, rules.allowChanges))]));
  if (rules.allowChanges) {
    // Конфигуратор при включении изменений сохраняет копию поставщика отдельно; импорт XML
    // принимает её только вместе с флагом «копия не совпадает» (0) в заголовке.
    mkdirSync(path.join(xmlDir, 'Ext', 'ParentConfigurations'), { recursive: true });
    copyFileSync(vendorCf, path.join(xmlDir, 'Ext', 'ParentConfigurations', `${vendorName}.cf`));
  }
  printRuleSummary(desired, names);

  step('4. Итоговая конфигурация и сверка');
  const baseC = createBase(work, 'C');
  ibcmd(baseC, 'infobase', 'config', 'import', xmlDir);
  ibcmd(baseC, 'infobase', 'config', 'apply', '--force');
  const resultCf = path.join(outDir, `${vendorName}.cf`);
  ibcmd(baseC, 'infobase', 'config', 'save', resultCf);
  const checkDir = path.join(work, 'check');
  ibcmd(baseC, 'infobase', 'config', 'export', checkDir);
  verify(path.join(checkDir, 'Ext', 'ParentConfigurations.bin'), desired, rules.allowChanges);
  console.log(`Готово: ${resultCf}`);

  const extension = args.extension ? loadExtension(baseC, outDir) : undefined;

  if (args.export) {
    step('6. Выгрузка в XML: 2.21 (8.5) и 2.20 (8.3.27)');
    exportXml(platformDir, work, 'X221', resultCf, path.join(outDir, 'xml-2.21'), extension);
    exportXml(platformDir220, work, 'X220', resultCf, path.join(outDir, 'xml-2.20'), extension);
  }
}

/** Загружает расширение поверх итоговой конфигурации и сохраняет его в <Имя>.cfe. */
function loadExtension(base, outDir) {
  step('5. Расширение поверх итоговой конфигурации');
  const source = path.resolve(args.extension);
  const isXmlDir = existsSync(path.join(source, 'Configuration.xml'));
  const name = isXmlDir ? readExtensionName(path.join(source, 'Configuration.xml')) : args['extension-name'];
  if (!name) {
    fail('для .cfe задайте --extension-name');
  }
  const option = `--extension=${name}`;
  ibcmd(base, 'infobase', 'config', isXmlDir ? 'import' : 'load', option, source);
  const cfe = path.join(outDir, `${name}.cfe`);
  ibcmd(base, 'infobase', 'config', 'save', option, cfe);
  console.log(`Расширение: ${cfe}`);
  return { name, cfe };
}

function readExtensionName(configurationXml) {
  const match = /<Configuration uuid="[^"]+">[\s\S]*?<Name>([^<]+)<\/Name>/.exec(readFileSync(configurationXml, 'utf-8'));
  if (!match) {
    fail(`не найдено имя расширения в ${configurationXml}`);
  }
  return match[1];
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    // Опечатка вида --vendr молча отключила бы повторяемую пересборку — неизвестный ключ — ошибка.
    if (key !== 'export' && !VALUE_OPTIONS.includes(key)) {
      fail(`неизвестный параметр ${argv[i]}`);
    }
    if (key === 'export') {
      result.export = true;
    } else {
      result[key] = argv[i + 1];
      i += 1;
    }
  }
  return result;
}

function requireArg(name) {
  if (!args[name]) {
    fail(`не задан --${name}`);
  }
  return args[name];
}

function loadRules(rulesPath) {
  const rules = JSON.parse(readFileSync(rulesPath, 'utf-8'));
  for (const [name, rule] of [['default', rules.default], ...Object.entries(rules.objects ?? {})]) {
    if (!(rule in RULE_CODES)) {
      fail(`${rulesPath}: правило "${rule}" для ${name} — допустимо ${Object.keys(RULE_CODES).join('/')}`);
    }
  }
  return { allowChanges: rules.allowChanges !== false, default: rules.default, objects: rules.objects ?? {} };
}

/** uuid → полное имя объекта (`Catalog.Банки.Attribute.ИНН`); корень конфигурации — `Configuration`. */
function readDumpInfoNames(dumpInfoPath) {
  const xml = readFileSync(dumpInfoPath, 'utf-8');
  const names = new Map();
  for (const match of xml.matchAll(new RegExp(`<Metadata name="([^"]+)" id="(${UUID})"`, 'g'))) {
    names.set(match[2], /^Configuration\.[^.]+$/.test(match[1]) ? 'Configuration' : match[1]);
  }
  return names;
}

function readBin(binPath) {
  const raw = readFileSync(binPath);
  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  return { text: raw.subarray(hasBom ? 3 : 0).toString('utf-8'), bom: raw.subarray(0, hasBom ? 3 : 0) };
}

/**
 * Правило для каждой записи .bin: точное имя, иначе ближайший предок (правило объекта действует и на
 * его реквизиты/ТЧ/формы — как «установить для подчинённых» в Конфигураторе), иначе default.
 */
function resolveRules(text, names, rules) {
  const used = new Set();
  const desired = new Map();
  for (const match of text.matchAll(RECORD_RE)) {
    const uuid = match[4];
    const name = names.get(uuid);
    if (!name) {
      fail(`запись ${uuid} из ParentConfigurations.bin не найдена в ConfigDumpInfo.xml`);
    }
    let rule = rules.default;
    for (let candidate = name; candidate; candidate = parentName(candidate)) {
      if (candidate in rules.objects) {
        rule = rules.objects[candidate];
        used.add(candidate);
        break;
      }
    }
    desired.set(uuid, RULE_CODES[rule]);
  }
  const unknown = Object.keys(rules.objects).filter((name) => !used.has(name));
  if (unknown.length > 0) {
    fail(`в конфигурации нет объектов из правил: ${unknown.join(', ')}`);
  }
  return desired;
}

function parentName(name) {
  // Полное имя подчинённого — `<Тип>.<Имя>.<Вид>.<Имя>`: предок отрезается парой сегментов.
  const parts = name.split('.');
  return parts.length > 2 ? parts.slice(0, -2).join('.') : '';
}

function applyRules(text, desired, allowChanges) {
  const withHeader = text.replace(HEADER_RE, (all, locked, count, uuid1, sameAsVendor, uuid2) =>
    all
      .replace(`{6,${locked},`, `{6,${allowChanges ? '0' : '1'},`)
      .replace(`${uuid1},${sameAsVendor},${uuid2}`, `${uuid1},${allowChanges ? '0' : '1'},${uuid2}`)
  );
  return withHeader.replace(RECORD_RE, (all, sep, _a, b, uuid) => `${sep}${desired.get(uuid)},${b},${uuid},${uuid}`);
}

function verify(binPath, desired, allowChanges) {
  const { text } = readBin(binPath);
  const header = HEADER_RE.exec(text);
  const expectedFlag = allowChanges ? '0' : '1';
  if (!header || header[1] !== expectedFlag || header[4] !== expectedFlag) {
    fail(`платформа не сохранила флаги заголовка ${binPath}`);
  }
  let checked = 0;
  for (const match of text.matchAll(RECORD_RE)) {
    if (desired.get(match[4]) !== match[2]) {
      fail(`платформа изменила правило записи ${match[4]}: ${String(desired.get(match[4]))} → ${match[2]}`);
    }
    checked += 1;
  }
  if (checked !== desired.size) {
    fail(`в итоговом .bin ${String(checked)} записей вместо ${String(desired.size)}`);
  }
  console.log(`Сверка правил поддержки: ${String(checked)} записей совпадают`);
}

function printRuleSummary(desired, names) {
  const byCode = { 0: [], 1: [], 2: [] };
  for (const [uuid, code] of desired) {
    byCode[code].push(names.get(uuid));
  }
  const label = { 0: 'не редактируется', 1: 'редактируется с сохранением поддержки', 2: 'снят с поддержки' };
  for (const code of ['0', '1', '2']) {
    const list = byCode[code];
    const shown = code === '0' && list.length > 5 ? `${list.slice(0, 5).join(', ')}, …` : list.join(', ');
    console.log(`  ${label[code]}: ${String(list.length)}${shown ? ` (${shown})` : ''}`);
  }
}

function exportXml(dir, work, name, cfPath, target, extension) {
  const base = createBase(work, name, dir);
  ibcmd(base, 'infobase', 'config', 'load', cfPath);
  rmSync(target, { recursive: true, force: true });
  ibcmd(base, 'infobase', 'config', 'export', target);
  console.log(`XML: ${target}`);
  if (extension) {
    const option = `--extension=${extension.name}`;
    const extensionTarget = path.join(`${target}-cfe`, extension.name);
    ibcmd(base, 'infobase', 'config', 'load', option, extension.cfe);
    rmSync(extensionTarget, { recursive: true, force: true });
    ibcmd(base, 'infobase', 'config', 'export', option, extensionTarget);
    console.log(`XML расширения: ${extensionTarget}`);
  }
}

function createBase(work, name, dir = platformDir) {
  const base = { dir, db: path.join(work, `ib${name}`), data: path.join(work, `data${name}`) };
  mkdirSync(base.data, { recursive: true });
  ibcmd(base, 'infobase', 'create', '--create-database');
  return base;
}

function ibcmd(base, ...command) {
  // Параметры базы — после имени режима и команды, как требует ibcmd.
  const modeLength = command[1] === 'config' ? 3 : 2;
  const argv = [
    ...command.slice(0, modeLength),
    `--data=${base.data}`,
    `--db-path=${base.db}`,
    ...command.slice(modeLength),
  ];
  run(path.join(base.dir, 'ibcmd'), argv);
}

function designer(base, work, ...command) {
  const log = path.join(work, 'designer.log');
  rmSync(log, { force: true });
  const argv = [
    'DESIGNER', '/F', base.db, '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', log, ...command,
  ];
  const exe = path.join(base.dir, '1cv8');
  if (process.env.DISPLAY) {
    run(exe, argv, log);
  } else {
    run('xvfb-run', ['-a', exe, ...argv], log);
  }
}

function run(exe, argv, logPath) {
  const result = spawnSync(exe, argv, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const log = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf-8').replace(/^﻿/, '').trim() : '';
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  // Конфигуратор в пакетном режиме завершается с кодом 0 и при отказе (например, «требуется обновить
  // конфигурацию базы данных») — успех видно только по тексту лога /Out. Проверка рассчитана на
  // русскую локализацию платформы: на другой локали скрипт остановится с ошибкой, а не пропустит сбой.
  const designerFailed = logPath !== undefined && !/успешно/i.test(log);
  if (result.error || result.status !== 0 || /\[ERROR\]/.test(output) || designerFailed) {
    fail(`${path.basename(exe)} ${argv.join(' ')}\n${log || output || String(result.error)}`);
  }
  if (log) {
    console.log(`  ${log}`);
  }
}

function step(title) {
  console.log(`\n== ${title}`);
}

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}
