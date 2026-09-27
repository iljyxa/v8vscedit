// Фикстура захватов хранилища конфигурации (issue #6) — воспроизводимо, без GUI Конфигуратора.
//
// Зачем: статусы захватов расширение читает из файла хранилища (1CD) и из сервера хранилища
// (crserver по tcp:// и http(s):// через веб-публикацию wsap). Тестам нужны настоящие артефакты
// платформы: файл 1CD с захватами двух пользователей, вывод /Out отказа захвата и снятые
// байты обменов с crserver. Синтетика не годится — формат 1CD и протокол crs платформа не
// документирует, и тест на выдуманных байтах подтверждал бы только сам себя.
//
// Сценарий — example/repository/2.21-locks/scenario.json (шаги захвата, ожидаемые захваты по имени
// записи ConfigDumpInfo.xml, ожидаемые отказы). Результат — каталог версии платформы
// (`8.5.1`, `8.3.27`) рядом со сценарием:
//   1cv8ddb.1CD; lock-refused.out.txt — вывод /Out отказа захвата (не .log: их исключает .gitignore);
//   run.json — платформа, окно времени захватов, адрес, alias, размер страницы, инвентаризация
//   fatlevel/Recordlock таблиц;
//   --network: tcp/<обмен>.{client,server}.bin (полные потоки сокета),
//              designer-devObjectsStatistic.request.bin (тело вызова самого Конфигуратора);
//   --http:    http/<обмен>.{request,response}.bin + .meta.json.
//
// Конвейер:
//   1. база A ← XML конфигурации (8.5 — example/2.21/src/cf, 8.3 — example/2.20/src/cf: XML 2.21 она
//      не читает; uuid объектов в обеих выгрузках совпадают, поэтому ConfigDumpInfo.xml example/2.21
//      согласован с OBJID хранилища обеих версий);
//   2. хранилище: каталог <work>/repo или (--network) crserver этой платформы на свободном порту;
//      Admin без пароля создаёт хранилище, добавляет Petrov/123 (LockObjects); база B привязывается
//      под Petrov;
//   3. шаги захвата из сценария; последний шаг Admin — ожидаемый отказ (код 1), /Out сохраняется;
//   4. (--network) обмены собственным минимальным клиентом этого скрипта (он написан независимо от
//      продуктового TypeScript — байты продукта обязаны совпасть с ним); запрос Конфигуратора
//      снимается записывающим tcp-прокси при /ConfigurationRepositoryReport;
//   5. остановка crserver, копия 1CD, сверка захватов в 1CD (собственный читатель скрипта) со
//      сценарием, сверка отказов в /Out и (--network) statMap ответа со сценарием.
//
// Использование:
//   node example/tools/build-repository-locks.mjs [--platform-dir /opt/1cv8/x86_64/8.5.1.1529] \
//     [--network [--http]] [--out example/repository/2.21-locks] [--work <каталог>]
//   node example/tools/build-repository-locks.mjs --tls
// --tls — только перевыпустить самоподписанный сертификат localhost (example/repository/tls, 100 лет)
// для тестов https-транспорта; это TLS-артефакт, а не платформенный.
// --work — рабочий каталог (по умолчанию временный, удаляется). Его путь попадает в фикстуру:
// Конфигуратор пишет абсолютный путь базы в строку привязки (1CD, bindInfos ответа сервера).
// Без дисплея Конфигуратор запускается через xvfb-run. Apache — собственный экземпляр от
// пользователя (/usr/sbin/apache2, Listen только на 127.0.0.1), системные службы не нужны.
//
// При перегенерации example/2.21 с новыми uuid эту фикстуру нужно пересобрать.

/* global console, process, setTimeout, clearTimeout, Buffer */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VALUE_OPTIONS = ['platform-dir', 'out', 'work'];
const FLAG_OPTIONS = ['network', 'http', 'tls'];
const TCP_CLIENT_HELLO = Buffer.from('224855b56884066f73799f4696555454ffabf840', 'hex');
const TCP_TRAILER = Buffer.from('6653b2a6', 'hex');
const STATISTIC_PARAMS = '<crs:params><crs:objRefs/><crs:removed value="false"/></crs:params>';
const APACHE_MODULES = '/usr/lib/apache2/modules';

const args = parseArgs(process.argv.slice(2));
const platformDir = path.resolve(args['platform-dir'] ?? '/opt/1cv8/x86_64/8.5.1.1529');
const platformVersion = path.basename(platformDir);
const versionDirName = platformVersion.split('.').slice(0, 3).join('.');
const outRoot = path.resolve(args.out ?? path.join(REPO_ROOT, 'example', 'repository', '2.21-locks'));
const scenario = JSON.parse(readFileSync(path.join(outRoot, 'scenario.json'), 'utf-8'));
const children = new Set();

main().catch((error) => {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  if (args.tls) {
    await issueTlsCertificate(path.join(REPO_ROOT, 'example', 'repository', 'tls'));
    console.log('Сертификат: example/repository/tls/localhost.{crt,key}');
    return;
  }
  if (args.http && !args.network) {
    fail('--http требует --network: веб-публикация проксирует вызовы к crserver');
  }
  // Путь рабочего каталога попадает в фикстуру: Конфигуратор пишет путь базы (/F — только
  // абсолютный) в строку привязки, а она есть в 1CD и в bindInfos ответа сервера. Поэтому по
  // умолчанию — нейтральный временный каталог, удаляемый после сборки.
  const work = path.resolve(args.work ?? mkdtempSync(path.join(os.tmpdir(), 'repo-locks-')));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const outDir = path.join(outRoot, versionDirName);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const [admin, petrov] = scenario.users;
  const source = path.join(REPO_ROOT, 'example', platformVersion.startsWith('8.3.') ? '2.20' : '2.21', 'src', 'cf');
  step(`1. База A ← ${path.relative(REPO_ROOT, source)} (${platformVersion})`);
  const baseA = await createBase(work, 'A');
  await ibcmd(baseA, 'infobase', 'config', 'import', source);
  await ibcmd(baseA, 'infobase', 'config', 'apply', '--force');

  let crserver;
  let repoAddress;
  const run = { platform: platformVersion, alias: scenario.alias };
  if (args.network) {
    step('2. crserver');
    crserver = await startCrserver(work);
    repoAddress = `tcp://127.0.0.1:${String(crserver.port)}/${scenario.alias}`;
  } else {
    repoAddress = 'repo';
  }
  run.connectString = args.network ? `tcp://127.0.0.1:<port>/${scenario.alias}` : '<каталог хранилища>';
  if (args.http) {
    run.httpConnectString = `http://127.0.0.1:<port>/repo/repo.1ccr/${scenario.alias}`;
  }

  step('2. Хранилище: создание, пользователь, привязка базы B');
  const bases = { [admin.name]: baseA };
  await designer(baseA, work, repoAddress, admin, ['/ConfigurationRepositoryCreate', '-AllowConfigurationChanges',
    '-ChangesAllowedRule', 'ObjectIsEditableSupportEnabled', '-ChangesNotRecommendedRule', 'ObjectIsEditableSupportEnabled']);
  await designer(baseA, work, repoAddress, admin, ['/ConfigurationRepositoryAddUser', '-User', petrov.name,
    '-Pwd', petrov.password, '-Rights', petrov.rights]);
  const baseB = await createBase(work, 'B');
  bases[petrov.name] = baseB;
  await designer(baseB, work, repoAddress, petrov, ['/ConfigurationRepositoryBindCfg', '-forceBindAlreadyBindedUser',
    '-forceReplaceCfg']);

  step('3. Захваты');
  run.lockedFrom = localTimestamp(new Date(Date.now() - 1000));
  for (const [index, item] of scenario.steps.entries()) {
    const user = scenario.users.find((candidate) => candidate.name === item.user);
    const objectsFile = path.join(work, `objects-${String(index)}.xml`);
    writeFileSync(objectsFile, buildObjectsXml(item.lock), 'utf-8');
    const log = await designer(bases[user.name], work, repoAddress, user,
      ['/ConfigurationRepositoryLock', '-Objects', objectsFile], { expectFailure: item.expectRefusal === true });
    if (item.log) {
      copyFileSync(log, path.join(outDir, item.log));
    }
  }
  // REVISEDATE хранится с точностью до секунды: запас в секунду с обеих сторон окна.
  await delay(1100);
  run.lockedTo = localTimestamp(new Date());
  verifyRefusals(readFileSync(path.join(outDir, 'lock-refused.out.txt')));

  let designerRequest;
  if (crserver) {
    step('4. Обмены с crserver');
    await recordTcpExchanges(crserver.port, outDir, run);
    if (args.http) {
      const apache = await startApache(work, crserver.port);
      try {
        await recordHttpExchanges(apache, outDir);
      } finally {
        await stopApache(apache);
      }
    }
    designerRequest = await recordDesignerRequest(baseA, work, crserver.port, admin, outDir);
    step('5. Остановка crserver');
    await stopProcess(crserver.child);
  }

  step('5. Файл 1CD и сверка');
  const repoFile = args.network
    ? path.join(work, 'crsdata', scenario.alias, '1cv8ddb.1CD')
    : path.join(work, repoAddress, '1cv8ddb.1CD');
  if (!existsSync(repoFile)) {
    fail(`нет файла хранилища ${repoFile}`);
  }
  copyFileSync(repoFile, path.join(outDir, '1cv8ddb.1CD'));
  const database = readOneCd(readFileSync(repoFile));
  run.pageSize = database.pageSize;
  run.tables = database.inventory;
  verifyDatabaseLocks(database, run);
  if (designerRequest) {
    verifyDesignerRequest(designerRequest, admin);
  }
  writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
  if (!args.work) {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Готово: ${outDir}`);
}

// ---------------------------------------------------------------------------------------------
// Сценарий

function buildObjectsXml(items) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<Objects xmlns="http://v8.1c.ru/8.3/config/objects" version="1.0">'];
  for (const item of items) {
    lines.push(typeof item === 'string'
      ? `  <Object fullName="${item}" includeChildObjects="false"/>`
      : '  <Configuration includeChildObjects="false"/>');
  }
  lines.push('</Objects>', '');
  return lines.join('\n');
}

/** uuid → имя записи ConfigDumpInfo.xml (только записи с configVersion — единицы хранилища). */
function readDumpInfoIds() {
  const xml = readFileSync(path.join(REPO_ROOT, 'example', '2.21', 'src', 'cf', 'ConfigDumpInfo.xml'), 'utf-8');
  const ids = new Map();
  for (const match of xml.matchAll(/<Metadata name="([^"]+)" id="([0-9a-f-]{36})" configVersion="/g)) {
    ids.set(match[2], match[1]);
  }
  return ids;
}

function expectedLocks() {
  return scenario.locks.map((lock) => `${lock.dumpName}=${lock.user}`).sort();
}

function verifyLockSet(actual, what) {
  const expected = expectedLocks();
  const got = [...actual].sort();
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    fail(`${what}: захваты не совпадают со сценарием\n  ожидалось: ${expected.join(', ')}\n  получено:  ${got.join(', ')}`);
  }
  console.log(`  ${what}: ${String(got.length)} захватов совпадают со сценарием`);
}

function verifyRefusals(raw) {
  const text = decodeDesignerLog(raw);
  const refusals = [...text.matchAll(/^Объект захвачен для редактирования другим пользователем: (.+) \((.+)\) ?$/gm)]
    .map((match) => `${match[1]}=${match[2]}`)
    .sort();
  const expected = scenario.refusals.map((item) => `${item.objectName}=${item.user}`).sort();
  if (JSON.stringify(refusals) !== JSON.stringify(expected)) {
    fail(`отказы захвата не совпадают со сценарием\n  ожидалось: ${expected.join(', ')}\n  получено:  ${refusals.join(', ')}\n${text}`);
  }
  console.log(`  отказы захвата: ${refusals.join(', ')}`);
}

function verifyDatabaseLocks(database, run) {
  const ids = readDumpInfoIds();
  const users = new Map(database.tables.USERS.map((row) => [row.USERID, row.NAME]));
  const locks = [];
  for (const row of database.tables.OBJECTS) {
    if (row.REVISED !== true) {
      continue;
    }
    const name = ids.get(row.OBJID);
    if (!name) {
      fail(`захват объекта ${row.OBJID}, которого нет в ConfigDumpInfo.xml`);
    }
    if (!(row.REVISEDATE >= run.lockedFrom && row.REVISEDATE <= run.lockedTo)) {
      fail(`дата захвата ${name} ${String(row.REVISEDATE)} вне окна ${run.lockedFrom}…${run.lockedTo}`);
    }
    locks.push(`${name}=${users.get(row.REVISORID)}`);
  }
  verifyLockSet(locks, '1CD');
}

function verifyStatistic(body, what) {
  const text = body.toString('utf-8').replace(/^\uFEFF/, '');
  const ids = readDumpInfoIds();
  const users = new Map();
  for (const match of text.matchAll(/<crs:first value="([^"]+)"\/><crs:second><crs:info><crs:id value="[^"]*"\/><crs:name value="([^"]*)"\/>/g)) {
    users.set(match[1], match[2]);
  }
  const locks = [];
  for (const match of text.matchAll(/<crs:first value="([^"]+)"\/><crs:second>(?:(?!<\/crs:second>).)*?<crs:revised value="true"\/><crs:revisorID value="([^"]+)"\/>/gs)) {
    locks.push(`${ids.get(match[1]) ?? match[1]}=${users.get(match[2]) ?? match[2]}`);
  }
  verifyLockSet(locks, what);
}

function verifyDesignerRequest(body, admin) {
  const text = body.toString('utf-8');
  const expected = buildCallBody(scenario.alias, 'DevDepot_devObjectsStatistic', platformVersion, admin, STATISTIC_PARAMS)
    .toString('utf-8');
  const normalized = text.replace(/<crs:bind [^>]*\/>/, '').replace('<crs:removed value="true"/>', '<crs:removed value="false"/>');
  if (normalized !== expected) {
    fail(`запрос Конфигуратора не совпадает с конвертом скрипта\n  Конфигуратор: ${normalized}\n  скрипт:       ${expected}`);
  }
  console.log('  конверт devObjectsStatistic совпадает с запросом Конфигуратора (без crs:bind, removed=false)');
}

// ---------------------------------------------------------------------------------------------
// Протокол crs: минимальный клиент скрипта

function passwordHash(password) {
  return createHash('md5').update(Buffer.from(password, 'utf16le')).digest('hex');
}

function buildCallBody(alias, method, version, user, params) {
  return Buffer.from(`\uFEFF<?xml version="1.0" encoding="UTF-8"?><crs:call xmlns:crs="http://v8.1c.ru/8.2/crs" `
    + `alias="${alias}" name="${method}" version="${version}"><crs:auth user="${user.name}" `
    + `password="${passwordHash(user.password)}"/>${params}</crs:call>`, 'utf-8');
}

function exchangePlan() {
  const [admin, petrov] = scenario.users;
  const call = (user, version, alias = scenario.alias) =>
    ({ alias, body: buildCallBody(alias, 'DevDepot_devObjectsStatistic', version, user, STATISTIC_PARAMS) });
  return {
    'statistic-admin': call(admin, platformVersion),
    'statistic-petrov': call(petrov, platformVersion),
    'version-mismatch': call(admin, '8.3.0.0'),
    'auth-failed': call({ name: petrov.name, password: 'wrong' }, platformVersion),
    'alias-not-found': call(admin, platformVersion, 'missing'),
  };
}

const EXPECTED_EXCHANGE = {
  'statistic-admin': 'call_return',
  'statistic-petrov': 'call_return',
  'version-mismatch': 'call_exception',
  'auth-failed': 'call_exception',
  'alias-not-found': 'call_exception',
};

function checkExchange(transport, name, body) {
  const text = body.toString('utf-8');
  if (!text.includes(`<crs:${EXPECTED_EXCHANGE[name]}`)) {
    fail(`обмен ${transport}/${name}: ожидался ${EXPECTED_EXCHANGE[name]}\n${text.slice(0, 600)}`);
  }
  if (EXPECTED_EXCHANGE[name] === 'call_exception') {
    const payload = /<crs:call_exception[^>]*>([^<]*)</.exec(text)?.[1] ?? '';
    const message = Buffer.from(payload, 'base64').toString('utf-8').replace(/^\uFEFF/, '');
    console.log(`  ${transport}/${name}: ${message.slice(0, 160).replace(/\s+/g, ' ')}`);
  } else {
    verifyStatistic(body, `${transport}/${name}`);
  }
}

async function recordTcpExchanges(port, outDir, run) {
  const dir = path.join(outDir, 'tcp');
  mkdirSync(dir, { recursive: true });
  for (const [name, request] of Object.entries(exchangePlan())) {
    const { client, server, greeting, response } = await tcpCall(port, request.body);
    writeFileSync(path.join(dir, `${name}.client.bin`), client);
    writeFileSync(path.join(dir, `${name}.server.bin`), server);
    run.serverGreeting = greeting.toString('hex');
    checkExchange('tcp', name, response);
  }
}

/** Один вызов по tcp с записью обоих потоков сокета целиком. */
function tcpCall(port, body) {
  const frame = Buffer.concat([
    Buffer.from(`POST  HTTP/1.1\r\nContent-Length: ${String(body.length)}\r\nAccept: application/xml\r\n`
      + 'Content-Type: application/xml\r\n\r\n', 'latin1'),
    body,
    TCP_TRAILER,
  ]);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const sent = [];
    let received = Buffer.alloc(0);
    let finished = false;
    let tail;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(tail);
      socket.destroy();
      const headerEnd = received.indexOf('\r\n\r\n', 5);
      const head = received.subarray(5, headerEnd).toString('latin1');
      const length = Number(/Content-Length: (\d+)/i.exec(head)?.[1]);
      resolve({
        client: Buffer.concat(sent),
        server: received,
        greeting: received.subarray(0, 5),
        response: received.subarray(headerEnd + 4, headerEnd + 4 + length),
      });
    };
    const write = (chunk) => {
      sent.push(chunk);
      socket.write(chunk);
    };
    socket.on('data', (chunk) => {
      const greetingDone = received.length >= 5;
      received = Buffer.concat([received, chunk]);
      if (!greetingDone && received.length >= 5) {
        write(TCP_CLIENT_HELLO);
        write(frame);
      }
      const headerEnd = received.indexOf('\r\n\r\n', 5);
      if (headerEnd < 0) {
        return;
      }
      const length = Number(/Content-Length: (\d+)/i.exec(received.subarray(5, headerEnd).toString('latin1'))?.[1]);
      const total = headerEnd + 4 + length;
      if (received.length >= total + TCP_TRAILER.length) {
        finish();
      } else if (received.length >= total && !tail) {
        // Терминатор ответа может прийти отдельным пакетом — ждём его недолго, чтобы записать поток целиком.
        tail = setTimeout(finish, 1000);
      }
    });
    socket.on('error', reject);
    socket.on('close', finish);
  });
}

async function recordHttpExchanges(apache, outDir) {
  const dir = path.join(outDir, 'http');
  mkdirSync(dir, { recursive: true });
  for (const [name, request] of Object.entries(exchangePlan())) {
    // POST — на адрес до .1ccr включительно, как у платформы; alias (сегмент строки подключения
    // после .1ccr) передаётся только атрибутом конверта.
    const requestPath = '/repo/repo.1ccr';
    const response = await httpPost(apache.port, requestPath, request.body);
    writeFileSync(path.join(dir, `${name}.request.bin`), request.body);
    writeFileSync(path.join(dir, `${name}.response.bin`), response.body);
    writeFileSync(path.join(dir, `${name}.meta.json`), `${JSON.stringify({
      method: 'POST',
      path: requestPath,
      requestHeaders: { 'content-type': 'application/xml', accept: 'application/xml' },
      status: response.status,
      headers: response.headers,
    }, null, 2)}\n`, 'utf-8');
    checkExchange('http', name, response.body);
  }
}

function httpPost(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: requestPath,
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml', 'Content-Length': body.length },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const headers = Object.fromEntries(Object.entries(response.headers)
          .filter(([key]) => key === 'content-type' || key === 'content-length' || key === 'transfer-encoding'));
        resolve({ status: response.statusCode, headers, body: Buffer.concat(chunks) });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

/**
 * Запрос devObjectsStatistic самого Конфигуратора — через записывающий tcp-прокси при
 * /ConfigurationRepositoryReport. Им подтверждается конверт (префикс, namespace, порядок
 * атрибутов) и alias, который платформа выводит из строки подключения tcp://.
 */
async function recordDesignerRequest(base, work, crserverPort, admin, outDir) {
  const upstream = [];
  const proxy = net.createServer((client) => {
    const server = net.connect(crserverPort, '127.0.0.1');
    client.on('data', (chunk) => { upstream.push(chunk); server.write(chunk); });
    server.on('data', (chunk) => client.write(chunk));
    client.on('close', () => server.destroy());
    server.on('close', () => client.destroy());
    client.on('error', () => server.destroy());
    server.on('error', () => client.destroy());
  });
  const proxyPort = await listen(proxy);
  try {
    const address = `tcp://127.0.0.1:${String(proxyPort)}/${scenario.alias}`;
    await designer(base, work, address, admin, ['/ConfigurationRepositoryReport', path.join(work, 'report.mxl')]);
  } finally {
    proxy.close();
  }
  const stream = Buffer.concat(upstream);
  const marker = stream.indexOf('name="DevDepot_devObjectsStatistic"');
  if (marker < 0) {
    fail('Конфигуратор не вызвал DevDepot_devObjectsStatistic при отчёте по хранилищу');
  }
  const start = stream.lastIndexOf(Buffer.from('\uFEFF<?xml', 'utf-8'), marker);
  const end = stream.indexOf('</crs:call>', marker) + '</crs:call>'.length;
  const body = stream.subarray(start, end);
  const alias = /alias="([^"]*)"/.exec(body.toString('utf-8'))?.[1];
  if (alias !== scenario.alias) {
    fail(`Конфигуратор для tcp://…/${scenario.alias} прислал alias "${String(alias)}"`);
  }
  console.log(`  alias Конфигуратора совпадает с сегментом строки подключения: ${alias}`);
  writeFileSync(path.join(outDir, 'designer-devObjectsStatistic.request.bin'), body);
  return body;
}

// ---------------------------------------------------------------------------------------------
// Собственный читатель 1CD (формат 8.3.8): только то, что нужно для сверки и инвентаризации

function readOneCd(data) {
  if (data.subarray(0, 8).toString('latin1') !== '1CDBMSV8') {
    fail('файл хранилища не 1CD');
  }
  const pageSize = data.readUInt32LE(20);
  const page = (index) => data.subarray(index * pageSize, (index + 1) * pageSize);
  const object = (index) => {
    const header = page(index);
    const fatLevel = header.readUInt16LE(2);
    const length = Number(header.readBigUInt64LE(16));
    let pages = [];
    for (let offset = 24; offset + 4 <= pageSize && header.readUInt32LE(offset) !== 0; offset += 4) {
      pages.push(header.readUInt32LE(offset));
    }
    if (fatLevel === 1) {
      pages = pages.flatMap((indexPage) => {
        const list = [];
        const content = page(indexPage);
        for (let offset = 0; offset + 4 <= pageSize && content.readUInt32LE(offset) !== 0; offset += 4) {
          list.push(content.readUInt32LE(offset));
        }
        return list;
      });
    }
    return { fatLevel, data: Buffer.concat(pages.map(page)).subarray(0, length) };
  };
  const blob = (content, first) => {
    const parts = [];
    for (let block = first; block !== 0;) {
      const chunk = content.subarray(block * 256, (block + 1) * 256);
      parts.push(chunk.subarray(6, 6 + chunk.readUInt16LE(4)));
      block = chunk.readUInt32LE(0);
    }
    return Buffer.concat(parts);
  };
  const root = object(2).data;
  const header = blob(root, 1);
  const count = header.readUInt32LE(32);
  const tables = {};
  const inventory = {};
  for (let index = 0; index < count; index += 1) {
    const text = blob(root, header.readUInt32LE(36 + index * 4)).toString('utf-8');
    const name = /^\{"(\w+)"/.exec(text)[1];
    const files = /\{"Files",(\d+),(\d+),(\d+)\}/.exec(text).slice(1).map(Number);
    const recordLock = /\{"Recordlock","(\d)"\}/.exec(text)[1];
    const fields = [...text.matchAll(/\{"(\w+)","(\w+)",(\d),(\d+),(\d+),"\w+"\}/g)]
      .map((match) => ({ name: match[1], type: match[2], nullable: match[3] === '1', length: Number(match[4]) }));
    const dataObject = files[0] ? object(files[0]) : undefined;
    // Записи декодируются только у USERS/OBJECTS — у прочих таблиц число строк не считается.
    inventory[name] = { recordLock, dataFatLevel: dataObject?.fatLevel ?? null, rows: null };
    if (name === 'USERS' || name === 'OBJECTS') {
      tables[name] = decodeRows(fields, dataObject.data);
      inventory[name].rows = tables[name].length;
    }
  }
  return { pageSize, tables, inventory };
}

function decodeRows(fields, data) {
  const sizes = { B: (f) => f.length, L: () => 1, N: (f) => Math.floor((f.length + 2) / 2), NC: (f) => 2 * f.length,
    NVC: (f) => 2 + 2 * f.length, RV: () => 16, NT: () => 8, I: () => 8, DT: () => 7 };
  const recordSize = Math.max(5, 1 + fields.reduce((sum, field) => sum + sizes[field.type](field) + (field.nullable ? 1 : 0), 0));
  const rows = [];
  for (let offset = recordSize; offset + recordSize <= data.length; offset += recordSize) {
    const record = data.subarray(offset, offset + recordSize);
    if (record[0] !== 0) {
      continue;
    }
    const row = {};
    let position = 1;
    for (const field of fields) {
      const isNull = field.nullable && record[position] === 0;
      position += field.nullable ? 1 : 0;
      const value = record.subarray(position, position + sizes[field.type](field));
      position += value.length;
      if (isNull) {
        row[field.name] = null;
      } else if (field.type === 'B' && field.length === 16) {
        const hex = value.toString('hex');
        // GUID хранится в порядке bytes_le: первые три группы — little-endian.
        const swap = (part) => part.match(/../g).reverse().join('');
        row[field.name] = `${swap(hex.slice(0, 8))}-${swap(hex.slice(8, 12))}-${swap(hex.slice(12, 16))}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      } else if (field.type === 'L') {
        row[field.name] = value[0] !== 0;
      } else if (field.type === 'NVC') {
        row[field.name] = value.subarray(2, 2 + 2 * value.readUInt16LE(0)).toString('utf16le');
      } else if (field.type === 'DT') {
        const digits = value.toString('hex');
        row[field.name] = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
      }
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Процессы платформы и Apache

async function createBase(work, name) {
  const base = { db: path.join(work, `ib${name}`), data: path.join(work, `data${name}`) };
  mkdirSync(base.data, { recursive: true });
  await ibcmd(base, 'infobase', 'create', '--create-database');
  return base;
}

async function ibcmd(base, ...command) {
  const modeLength = command[1] === 'config' ? 3 : 2;
  await run(path.join(platformDir, 'ibcmd'), [
    ...command.slice(0, modeLength), `--data=${base.data}`, `--db-path=${base.db}`, ...command.slice(modeLength),
  ]);
}

/** Команда Конфигуратора с параметрами хранилища; возвращает путь к логу /Out. */
async function designer(base, work, repoAddress, user, command, options = {}) {
  const log = path.join(work, 'designer.log');
  rmSync(log, { force: true });
  const argv = ['DESIGNER', '/F', base.db, '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', log,
    '/ConfigurationRepositoryF', repoAddress, '/ConfigurationRepositoryN', user.name];
  if (user.password) {
    argv.push('/ConfigurationRepositoryP', user.password);
  }
  argv.push(...command);
  const exe = path.join(platformDir, '1cv8');
  const result = process.env.DISPLAY
    ? await run(exe, argv, { allowFailure: true, cwd: work })
    : await run('xvfb-run', ['-a', exe, ...argv], { allowFailure: true, cwd: work });
  const text = existsSync(log) ? decodeDesignerLog(readFileSync(log)).trim() : '';
  const succeeded = result.status === 0 && /успешно/i.test(text);
  if (options.expectFailure ? succeeded : !succeeded) {
    fail(`1cv8 ${command[0]} (${user.name}): код ${String(result.status)}, `
      + `${options.expectFailure ? 'ожидался отказ' : 'ошибка'}\n${text || result.output}`);
  }
  console.log(`  ${command[0]} (${user.name}): ${text.split('\n').pop()}`);
  return log;
}

function decodeDesignerLog(raw) {
  return raw.toString('utf-8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

async function startCrserver(work) {
  const dataDir = path.join(work, 'crsdata');
  mkdirSync(dataDir, { recursive: true });
  const port = await findFreePort();
  const rangeStart = await findFreePort();
  const exe = path.join(platformDir, 'crserver');
  if (!existsSync(exe)) {
    fail(`у платформы ${platformVersion} нет crserver — сетевую фикстуру снять нельзя`);
  }
  // Порт и диапазон задаются явно: соседний стенд или другой прогон не должны пересечься с этим.
  // Каталог данных — относительный: сервер вставляет его в тексты исключений, а снятые ответы
  // попадают в репозиторий — абсолютный путь рабочего каталога утёк бы в фикстуру.
  const child = spawn(exe, ['-port', String(port), '-range', `${String(rangeStart)}:${String(rangeStart + 9)}`,
    '-d', 'crsdata'], { stdio: 'ignore', cwd: work });
  children.add(child);
  await waitForPort(port);
  console.log(`  crserver ${platformVersion} на 127.0.0.1:${String(port)}`);
  return { child, port };
}

async function startApache(work, crserverPort) {
  const root = path.join(work, 'apache');
  const www = path.join(root, 'www');
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  mkdirSync(www, { recursive: true });
  writeFileSync(path.join(www, 'repo.1ccr'), '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<repository connectString="tcp://127.0.0.1:${String(crserverPort)}/${scenario.alias}"/>\n`, 'utf-8');
  const port = await findFreePort();
  const conf = path.join(root, 'httpd.conf');
  // mime_module и log_config_module не загружаются: первому нужен mime.types, второй встроен.
  writeFileSync(conf, [
    `ServerRoot "${root}"`,
    `PidFile "${path.join(root, 'httpd.pid')}"`,
    `Listen 127.0.0.1:${String(port)}`,
    'ServerName localhost',
    `LoadModule mpm_prefork_module ${APACHE_MODULES}/mod_mpm_prefork.so`,
    `LoadModule authz_core_module ${APACHE_MODULES}/mod_authz_core.so`,
    `LoadModule alias_module ${APACHE_MODULES}/mod_alias.so`,
    `LoadModule _1cws_module "${path.join(platformDir, 'wsap24.so')}"`,
    `ErrorLog "${path.join(root, 'logs', 'error.log')}"`,
    'LogLevel warn',
    `Alias "/repo" "${www}"`,
    `<Directory "${www}">`,
    '    AllowOverride None',
    '    Options None',
    '    Require all granted',
    '    SetHandler 1c-application',
    '</Directory>',
    '',
  ].join('\n'), 'utf-8');
  await run('/usr/sbin/apache2', ['-f', conf, '-k', 'start']);
  await waitForPort(port);
  console.log(`  Apache (wsap24 ${platformVersion}) на 127.0.0.1:${String(port)}`);
  return { conf, port, pidFile: path.join(root, 'httpd.pid') };
}

async function stopApache(apache) {
  await run('/usr/sbin/apache2', ['-f', apache.conf, '-k', 'stop']);
  for (let attempt = 0; attempt < 50 && existsSync(apache.pidFile); attempt += 1) {
    await delay(100);
  }
}

function stopProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => { children.delete(child); resolve(); });
    child.kill('SIGTERM');
  });
}

function run(exe, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd });
    children.add(child);
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      children.delete(child);
      const text = Buffer.concat(output).toString('utf-8').trim();
      if (!options.allowFailure && (status !== 0 || /\[ERROR\]/.test(text))) {
        reject(new Error(`${path.basename(exe)} ${argv.join(' ')}\n${text}`));
        return;
      }
      resolve({ status, output: text });
    });
  });
}

function issueTlsCertificate(dir) {
  mkdirSync(dir, { recursive: true });
  return run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '36500', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', path.join(dir, 'localhost.key'), '-out', path.join(dir, 'localhost.crt')]);
}

// ---------------------------------------------------------------------------------------------
// Утилиты

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function findFreePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (connected) {
      return;
    }
    await delay(100);
  }
  fail(`порт ${String(port)} не открылся`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (FLAG_OPTIONS.includes(key)) {
      result[key] = true;
    } else if (VALUE_OPTIONS.includes(key)) {
      result[key] = argv[i + 1];
      i += 1;
    } else {
      fail(`неизвестный параметр ${argv[i]}`);
    }
  }
  return result;
}

function step(title) {
  console.log(`\n== ${title}`);
}

function fail(message) {
  throw new Error(message);
}
