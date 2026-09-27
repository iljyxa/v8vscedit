import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import { parseCrsAddress, type CrsAddress } from '../../infra/repository/crs/CrsAddress';
import { buildCrsTcpRequestFrame, sendCrsRequest, type CrsTransportOptions } from '../../infra/repository/crs/CrsTransport';
import { RepositoryLockStatusError } from '../../infra/repository/RepositoryLockStatusSource';
import {
  findClosedPort,
  listenLoopback,
  NETWORK_FIXTURE_VERSIONS,
  readHttpExchange,
  readRun,
  readTcpExchange,
  REPOSITORY_TLS_DIR,
  startHttpReplayServer,
  startTcpReplayServer,
  tcpRequestBody,
  tcpResponseBody,
  type LoopbackServer,
} from './support/repositoryLockFixtures';

/**
 * Транспорты crs на loopback. crserver в тестовом окружении недоступен (внешняя система),
 * поэтому его заменяет тестовый сервер, отдающий байты, снятые с настоящего crserver, и
 * сверяющий байты запроса с принятыми им. Сбои сети (молчание, обрыв, неверный заголовок,
 * превышение размера) создаёт тестовый сервер — это эмуляция отказов внешней системы.
 */

const OPTIONS: CrsTransportOptions = { timeoutMs: 10_000, maxResponseBytes: 128 * 1024 * 1024 };

async function expectStatusError(promise: Promise<unknown>, code: RepositoryLockStatusError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RepositoryLockStatusError, String(error));
    assert.strictEqual(error.code, code, error.message);
    return true;
  });
}

function tcpAddress(port: number, alias = 'locks'): CrsAddress {
  return parseCrsAddress(`tcp://127.0.0.1:${String(port)}/${alias}`);
}

/** Сервер с произвольным поведением сокета; `closed` — промис закрытия серверной стороны. */
async function startRawTcpServer(onConnection: (socket: net.Socket) => void): Promise<LoopbackServer & { closed: Promise<void> }> {
  const sockets = new Set<net.Socket>();
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => { sockets.delete(socket); markClosed(); });
    onConnection(socket);
  });
  return { ...(await listenLoopback(server, [], sockets)), closed };
}

for (const version of NETWORK_FIXTURE_VERSIONS) {
  suite(`CrsTransport — воспроизведение обмена с crserver ${version}`, () => {
    const servers: LoopbackServer[] = [];
    teardown(async () => {
      await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    test('tcp: клиентский поток байт-в-байт равен снятому, тело ответа — из потока сервера', async () => {
      const exchange = readTcpExchange(version, 'statistic-admin');
      const server = await startTcpReplayServer(exchange.server, () => exchange.server);
      servers.push(server);
      const body = await sendCrsRequest(tcpAddress(server.port), tcpRequestBody(exchange.client), OPTIONS);
      assert.deepStrictEqual(body, tcpResponseBody(exchange.server));
      assert.deepStrictEqual(server.requests, [exchange.client]);
    });

    test('tcp: кадр запроса (заголовок, тело, терминатор) равен снятому', () => {
      const { client } = readTcpExchange(version, 'statistic-admin');
      assert.deepStrictEqual(buildCrsTcpRequestFrame(tcpRequestBody(client)), client.subarray(20));
    });

    test('http: метод, путь, заголовки и тело как у снятого запроса; ответ — снятый', async () => {
      const exchange = readHttpExchange(version, 'statistic-admin');
      const server = await startHttpReplayServer(() => ({ status: exchange.meta.status, body: exchange.response }));
      servers.push(server);
      const run = readRun(version);
      const address = parseCrsAddress(`http://127.0.0.1:${String(server.port)}${exchange.meta.path}/${run.alias}`);
      assert.deepStrictEqual(await sendCrsRequest(address, exchange.request, OPTIONS), exchange.response);
      const [received] = server.received;
      assert.deepStrictEqual([received.method, received.url], [exchange.meta.method, exchange.meta.path]);
      assert.deepStrictEqual([received.headers['content-type'], received.headers.accept], ['application/xml', 'application/xml']);
      assert.deepStrictEqual(received.body, exchange.request);
    });

    test('tcp: ответ больше лимита по Content-Length → too-large', async () => {
      const exchange = readTcpExchange(version, 'statistic-admin');
      const server = await startTcpReplayServer(exchange.server, () => exchange.server);
      servers.push(server);
      await expectStatusError(sendCrsRequest(tcpAddress(server.port), tcpRequestBody(exchange.client), { ...OPTIONS, maxResponseBytes: 100 }), 'too-large');
    });

    test('http: ответ больше лимита по Content-Length → too-large', async () => {
      const exchange = readHttpExchange(version, 'statistic-admin');
      const server = await startHttpReplayServer(() => ({ status: 200, body: exchange.response }));
      servers.push(server);
      const address = parseCrsAddress(`http://127.0.0.1:${String(server.port)}/repo/repo.1ccr`);
      await expectStatusError(sendCrsRequest(address, exchange.request, { ...OPTIONS, maxResponseBytes: 100 }), 'too-large');
    });
  });
}

suite('CrsTransport — отказы', () => {
  const servers: LoopbackServer[] = [];
  const body = tcpRequestBody(readTcpExchange('8.5.1', 'statistic-admin').client);
  const greeting = readTcpExchange('8.5.1', 'statistic-admin').server.subarray(0, 5);

  teardown(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  for (const scheme of ['tcp', 'http'] as const) {
    test(`${scheme}: порт закрыт → unavailable`, async () => {
      const port = await findClosedPort();
      const address = scheme === 'tcp' ? tcpAddress(port) : parseCrsAddress(`http://127.0.0.1:${String(port)}/r.1ccr`);
      await expectStatusError(sendCrsRequest(address, body, OPTIONS), 'unavailable');
    });
  }

  test('tcp: сервер молчит → timeout по общему дедлайну, сокет закрыт', async () => {
    const server = await startRawTcpServer(() => undefined);
    servers.push(server);
    await expectStatusError(sendCrsRequest(tcpAddress(server.port), body, { ...OPTIONS, timeoutMs: 100 }), 'timeout');
    await server.closed;
  });

  test('tcp: обрыв после приветствия → protocol', async () => {
    const server = await startRawTcpServer((socket) => socket.end(greeting));
    servers.push(server);
    await expectStatusError(sendCrsRequest(tcpAddress(server.port), body, OPTIONS), 'protocol');
  });

  const badHeaders: [string, string][] = [
    ['статус ≠ 200', 'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\n\r\nok'],
    ['нет Content-Length', 'HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\n\r\nok'],
    ['нет конца заголовка', `HTTP/1.1 200 OK\r\n${'X'.repeat(20_000)}`],
  ];
  for (const [title, response] of badHeaders) {
    test(`tcp: ${title} → protocol`, async () => {
      const server = await startRawTcpServer((socket) => {
        socket.write(greeting);
        socket.once('data', () => socket.write(response));
      });
      servers.push(server);
      await expectStatusError(sendCrsRequest(tcpAddress(server.port), body, OPTIONS), 'protocol');
    });
  }

  test('http: статус 500 с телом не crs → server-error', async () => {
    const server = await startHttpReplayServer(() => ({ status: 500, headers: { 'Content-Type': 'text/html' }, body: Buffer.from('<html>oops</html>') }));
    servers.push(server);
    await expectStatusError(sendCrsRequest(parseCrsAddress(`http://127.0.0.1:${String(server.port)}/r.1ccr`), body, OPTIONS), 'server-error');
  });

  test('http: ответ без Content-Length (chunked) больше лимита по фактическим байтам → too-large', async () => {
    const sockets = new Set<net.Socket>();
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.write(Buffer.alloc(80, 0x61));
      response.end(Buffer.alloc(80, 0x61));
    });
    server.on('connection', (socket) => { sockets.add(socket); });
    const loopback = await listenLoopback(server, [], sockets);
    servers.push(loopback);
    const address = parseCrsAddress(`http://127.0.0.1:${String(loopback.port)}/r.1ccr`);
    await expectStatusError(sendCrsRequest(address, body, { ...OPTIONS, maxResponseBytes: 100 }), 'too-large');
  });

  suite('https с самоподписанным сертификатом localhost (example/repository/tls)', () => {
    const exchange = readHttpExchange('8.5.1', 'statistic-admin');
    const cert = fs.readFileSync(path.join(REPOSITORY_TLS_DIR, 'localhost.crt'));
    const key = fs.readFileSync(path.join(REPOSITORY_TLS_DIR, 'localhost.key'));

    async function startHttps(): Promise<LoopbackServer> {
      const sockets = new Set<net.Socket>();
      const server = https.createServer({ cert, key }, (request, response) => {
        request.resume();
        request.on('end', () => {
          response.writeHead(200, { 'Content-Type': 'application/xml' });
          response.end(exchange.response);
        });
      });
      server.on('connection', (socket) => { sockets.add(socket as net.Socket); });
      const loopback = await listenLoopback(server, [], sockets);
      servers.push(loopback);
      return loopback;
    }

    test('без доверенного CA — отказ tls: проверка сертификата не отключена', async () => {
      const server = await startHttps();
      await expectStatusError(sendCrsRequest(parseCrsAddress(`https://127.0.0.1:${String(server.port)}/repo/repo.1ccr`), exchange.request, OPTIONS), 'tls');
    });

    test('с CA тестового сертификата — ответ получен', async () => {
      const server = await startHttps();
      const address = parseCrsAddress(`https://127.0.0.1:${String(server.port)}/repo/repo.1ccr`);
      assert.deepStrictEqual(await sendCrsRequest(address, exchange.request, { ...OPTIONS, tlsCa: cert }), exchange.response);
    });
  });
});
