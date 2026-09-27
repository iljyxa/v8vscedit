import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { RepositoryLockStatusError } from '../RepositoryLockStatusSource';
import type { CrsAddress } from './CrsAddress';

/**
 * Транспорты протокола crs. HTTP(S) — обычный POST на публикацию `.1ccr` (проверка
 * сертификата не отключается). TCP — собственное кадрирование crserver (установлено по
 * трафику 8.5.1): сервер шлёт 5 байт приветствия, клиент — 20 постоянных байт, затем кадр
 * `POST  HTTP/1.1` с Content-Length, телом и терминатором; ответ — такой же кадр со
 * статусом 200. Байты приветствия сервера не проверяются: для 8.3.27 они не сняты.
 * Общие для обоих правила: один дедлайн на подключение и ответ, лимит размера ответа,
 * закрытие сокета при любом исходе.
 */

export interface CrsTransportOptions {
  /** Общий дедлайн вызова: подключение + ответ. */
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** Только для тестов на loopback с самоподписанным сертификатом; прод не передаёт. */
  readonly tlsCa?: string | Buffer;
}

export const CRS_DEFAULT_TRANSPORT_OPTIONS: CrsTransportOptions = { timeoutMs: 60_000, maxResponseBytes: 128 * 1024 * 1024 };
export const CRS_TCP_CLIENT_HELLO = Buffer.from('224855b56884066f73799f4696555454ffabf840', 'hex');
export const CRS_TCP_FRAME_TRAILER = Buffer.from('6653b2a6', 'hex');
export const CRS_TCP_SERVER_GREETING_LENGTH = 5;

/** Предел заголовка кадра ответа: без `\r\n\r\n` в нём — это не crserver. */
const TCP_HEADER_LIMIT = 16 * 1024;
const HEADER_END = '\r\n\r\n';
const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function buildCrsTcpRequestFrame(body: Buffer): Buffer {
  const header = `POST  HTTP/1.1\r\nContent-Length: ${String(body.length)}\r\nAccept: application/xml\r\nContent-Type: application/xml${HEADER_END}`;
  return Buffer.concat([Buffer.from(header, 'latin1'), body, CRS_TCP_FRAME_TRAILER]);
}

export function sendCrsRequest(address: CrsAddress, body: Buffer, options: CrsTransportOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let dispose: () => void = () => undefined;
    // Первый исход побеждает: закрытие сокета после ответа или таймаута уже ничего не меняет.
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      dispose();
      action();
    };
    const outcome: Outcome = {
      fail: (error) => settle(() => reject(error)),
      succeed: (value) => settle(() => resolve(value)),
    };
    const timer = setTimeout(() => {
      outcome.fail(new RepositoryLockStatusError('timeout', `Сервер хранилища ${describe(address)} не ответил за ${String(options.timeoutMs / 1000)} с.`));
    }, options.timeoutMs);
    const call = address.transport === 'tcp' ? sendTcp : sendHttp;
    dispose = call(address, body, options, outcome);
  });
}

interface Outcome {
  fail(error: RepositoryLockStatusError): void;
  succeed(value: Buffer): void;
}

function sendTcp(address: CrsAddress, body: Buffer, options: CrsTransportOptions, outcome: Outcome): () => void {
  const socket = net.connect({ host: address.host, port: address.port });
  // До конца заголовка байты копятся в одном буфере: он ограничен TCP_HEADER_LIMIT, поэтому
  // повторная склейка дешёвая. Тело (до 128 МиБ) копится кусками и склеивается один раз —
  // склейка на каждом событии data была бы квадратичной.
  let head = Buffer.alloc(0);
  let requestSent = false;
  let bodyState: { length: number; chunks: Buffer[]; received: number } | undefined;
  const acceptBody = (part: Buffer, state: { length: number; chunks: Buffer[]; received: number }): void => {
    state.chunks.push(part);
    state.received += part.length;
    // Терминатор после тела допускается, но не требуется: тело определяется Content-Length.
    if (state.received >= state.length) {
      outcome.succeed(Buffer.concat(state.chunks).subarray(0, state.length));
    }
  };
  socket.on('data', (chunk: Buffer) => {
    if (bodyState) {
      acceptBody(chunk, bodyState);
      return;
    }
    head = Buffer.concat([head, chunk]);
    if (!requestSent && head.length >= CRS_TCP_SERVER_GREETING_LENGTH) {
      requestSent = true;
      socket.write(Buffer.concat([CRS_TCP_CLIENT_HELLO, buildCrsTcpRequestFrame(body)]));
    }
    const response = head.subarray(CRS_TCP_SERVER_GREETING_LENGTH);
    const headerEnd = response.indexOf(HEADER_END);
    if (headerEnd < 0) {
      if (response.length > TCP_HEADER_LIMIT) {
        outcome.fail(protocolError(address, 'не найден заголовок кадра ответа'));
      }
      return;
    }
    const header = response.subarray(0, headerEnd).toString('latin1');
    if (!/^HTTP\/1\.[01] 200 /.test(header)) {
      outcome.fail(protocolError(address, `статус кадра «${header.split('\r\n')[0]}»`));
      return;
    }
    const length = /\r\nContent-Length:\s*(\d+)/i.exec(header)?.[1];
    if (length === undefined) {
      outcome.fail(protocolError(address, 'в кадре ответа нет Content-Length'));
      return;
    }
    if (Number(length) > options.maxResponseBytes) {
      outcome.fail(tooLarge(address, options));
      return;
    }
    bodyState = { length: Number(length), chunks: [], received: 0 };
    acceptBody(response.subarray(headerEnd + HEADER_END.length), bodyState);
  });
  socket.on('error', (error) => outcome.fail(classifyNetworkError(error, address)));
  socket.on('close', () => outcome.fail(protocolError(address, 'соединение закрыто сервером до конца ответа')));
  return () => socket.destroy();
}

function sendHttp(address: CrsAddress, body: Buffer, options: CrsTransportOptions, outcome: Outcome): () => void {
  const client = address.transport === 'https' ? https : http;
  const request = client.request({
    host: address.host,
    port: address.port,
    method: 'POST',
    path: address.requestPath,
    ca: options.tlsCa,
    headers: { 'Content-Type': 'application/xml', Accept: 'application/xml', 'Content-Length': body.length },
  }, (response) => {
    if (response.statusCode !== 200) {
      outcome.fail(new RepositoryLockStatusError('server-error', `Веб-сервер хранилища ${describe(address)} ответил HTTP ${String(response.statusCode)}.`));
      return;
    }
    if (Number(response.headers['content-length']) > options.maxResponseBytes) {
      outcome.fail(tooLarge(address, options));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      chunks.push(chunk);
      if (total > options.maxResponseBytes) {
        outcome.fail(tooLarge(address, options));
      }
    });
    response.on('end', () => outcome.succeed(Buffer.concat(chunks)));
    response.on('error', onError);
  });
  const onError = (error: Error): void => outcome.fail(classifyNetworkError(error, address));
  request.on('error', onError);
  request.end(body);
  return () => request.destroy();
}

function classifyNetworkError(error: Error, address: CrsAddress): RepositoryLockStatusError {
  const code = String((error as NodeJS.ErrnoException).code);
  if (TLS_ERROR_CODES.has(code) || /^ERR_(SSL|TLS)_/.test(code)) {
    return new RepositoryLockStatusError('tls', `Ошибка TLS при подключении к ${describe(address)}: ${error.message}`, { cause: error });
  }
  return new RepositoryLockStatusError('unavailable', `Сервер хранилища ${describe(address)} недоступен: ${error.message}`, { cause: error });
}

function protocolError(address: CrsAddress, detail: string): RepositoryLockStatusError {
  return new RepositoryLockStatusError('protocol', `Нарушен протокол сервера хранилища ${describe(address)}: ${detail}.`);
}

function tooLarge(address: CrsAddress, options: CrsTransportOptions): RepositoryLockStatusError {
  return new RepositoryLockStatusError('too-large', `Ответ сервера хранилища ${describe(address)} больше лимита ${String(options.maxResponseBytes)} байт.`);
}

function describe(address: CrsAddress): string {
  return `${address.transport}://${address.host}:${String(address.port)}`;
}
