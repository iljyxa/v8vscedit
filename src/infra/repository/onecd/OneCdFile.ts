import * as fs from 'fs';

/**
 * Постраничное чтение файла базы 1CD (формат 8.3.8) — только на чтение и только то, что
 * нужно для статусов захвата хранилища: заголовок, объекты-страницы, blob-цепочки
 * корневого объекта с описаниями таблиц. Формат установлен экспериментом (issue #6):
 *  - страница 0: `1CDBMSV8`, байты версии `8,3,8,0`, число страниц (uint32 @12), размер
 *    страницы (uint32 @20);
 *  - заголовок объекта: сигнатура 0xFD1C, fatlevel (uint16 @2), длина (uint64 @16), номера
 *    страниц данных (uint32 с @24 до нуля);
 *  - blob — блоки по 256 байт: `next uint32, len uint16, 250 байт данных`.
 * Файл может писаться платформой во время чтения: любые нарушения сигнатур и границ
 * сводятся к `corrupted` («повторите обновление»), а не к исключению Node.
 */

export type OneCdFormatErrorCode = 'not-1cd' | 'unsupported-version' | 'corrupted';

export class OneCdFormatError extends Error {
  constructor(readonly code: OneCdFormatErrorCode, message: string) {
    super(message);
    this.name = 'OneCdFormatError';
  }
}

export interface OneCdObjectInfo {
  readonly page: number;
  readonly fatLevel: 0 | 1;
  readonly length: number;
}

const SIGNATURE = '1CDBMSV8';
const SUPPORTED_VERSION = '8.3.8.0';
const HEADER_LENGTH = 24;
const OBJECT_SIGNATURE = 0xfd1c;
const OBJECT_PAGES_OFFSET = 24;
const ROOT_OBJECT_PAGE = 2;
const BLOB_BLOCK_SIZE = 256;
const BLOB_BLOCK_DATA = 250;
/** Блок 1 blob корня: 32 байта языка, число таблиц и номера блоков их описаний. */
const ROOT_TABLE_COUNT_OFFSET = 32;

export class OneCdFile {
  private constructor(
    private readonly handle: fs.promises.FileHandle,
    readonly version: string,
    readonly pageSize: number,
    readonly pageCount: number
  ) {}

  static async open(filePath: string): Promise<OneCdFile> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const header = Buffer.alloc(HEADER_LENGTH);
      const { bytesRead } = await handle.read(header, 0, HEADER_LENGTH, 0);
      if (bytesRead < HEADER_LENGTH || header.toString('latin1', 0, SIGNATURE.length) !== SIGNATURE) {
        throw new OneCdFormatError('not-1cd', `Файл не является базой 1CD: ${filePath}`);
      }
      const version = [...header.subarray(8, 12)].join('.');
      /* c8 ignore start -- формат 8.2.14 (страница 4096, другой заголовок объекта) остался у
         хранилищ старых платформ; реальных файлов нет, читать его не поддерживаем, но и не
         разбираем как 8.3.8 */
      if (version !== SUPPORTED_VERSION) {
        throw new OneCdFormatError('unsupported-version', `Формат файла хранилища ${version} не поддерживается (нужен ${SUPPORTED_VERSION}): ${filePath}`);
      }
      /* c8 ignore stop */
      const pageCount = header.readUInt32LE(12);
      const pageSize = header.readUInt32LE(20);
      if (!isValidPageSize(pageSize)) {
        throw corrupted(`размер страницы ${String(pageSize)}`);
      }
      const { size } = await handle.stat();
      if (size < pageCount * pageSize) {
        throw corrupted(`файл короче заявленных ${String(pageCount)} страниц`);
      }
      return new OneCdFile(handle, version, pageSize, pageCount);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async describeObject(page: number): Promise<OneCdObjectInfo> {
    return (await this.readObjectHeader(page)).info;
  }

  async readObject(page: number): Promise<Buffer> {
    const { info, header } = await this.readObjectHeader(page);
    const pages = readPageList(header);
    /* c8 ignore start -- fatlevel=1 (страницы-индексы) наступает у OBJECTS примерно с 250 тыс.
       объектов; реальной фикстуры такого размера нет, ветка повторяет разбор прототипа */
    if (info.fatLevel === 1) {
      const dataPages: number[] = [];
      for (const indexPage of pages) {
        dataPages.push(...readPageList(await this.readPage(indexPage)));
      }
      pages.splice(0, pages.length, ...dataPages);
    }
    /* c8 ignore stop */
    const needed = Math.ceil(info.length / this.pageSize);
    if (pages.length < needed) {
      throw corrupted(`объекту на странице ${String(page)} не хватает страниц данных`);
    }
    const chunks: Buffer[] = [];
    for (const dataPage of pages.slice(0, needed)) {
      chunks.push(await this.readPage(dataPage));
    }
    return Buffer.concat(chunks).subarray(0, info.length);
  }

  /** Тексты описаний таблиц (скобочный формат, UTF-8) из blob корневого объекта. */
  async readTableDescriptions(): Promise<string[]> {
    const root = await this.readObject(ROOT_OBJECT_PAGE);
    return guardRange(() => {
      const head = readBlobChain(root, 1);
      const count = head.readUInt32LE(ROOT_TABLE_COUNT_OFFSET);
      const texts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const block = head.readUInt32LE(ROOT_TABLE_COUNT_OFFSET + 4 + index * 4);
        texts.push(readBlobChain(root, block).toString('utf-8'));
      }
      return texts;
    });
  }

  close(): Promise<void> {
    return this.handle.close();
  }

  private async readObjectHeader(page: number): Promise<{ info: OneCdObjectInfo; header: Buffer }> {
    const header = await this.readPage(page);
    if (header.readUInt16LE(0) !== OBJECT_SIGNATURE) {
      throw corrupted(`на странице ${String(page)} нет заголовка объекта`);
    }
    const fatLevel = header.readUInt16LE(2);
    if (fatLevel !== 0 && fatLevel !== 1) {
      throw corrupted(`неизвестный fatlevel ${String(fatLevel)} объекта на странице ${String(page)}`);
    }
    const length = Number(header.readBigUInt64LE(16));
    if (!Number.isSafeInteger(length)) {
      throw corrupted(`длина объекта на странице ${String(page)}`);
    }
    return { info: { page, fatLevel, length }, header: header.subarray(OBJECT_PAGES_OFFSET) };
  }

  private async readPage(page: number): Promise<Buffer> {
    if (page >= this.pageCount) {
      throw corrupted(`страница ${String(page)} за пределами файла`);
    }
    const buffer = Buffer.alloc(this.pageSize);
    const { bytesRead } = await this.handle.read(buffer, 0, this.pageSize, page * this.pageSize);
    if (bytesRead < this.pageSize) {
      throw corrupted(`страница ${String(page)} прочитана не полностью`);
    }
    return buffer;
  }
}

/** Данные blob-цепочки, начиная с блока `firstBlock` (блок 0 — служебный). */
export function readBlobChain(data: Buffer, firstBlock: number): Buffer {
  return guardRange(() => {
    const parts: Buffer[] = [];
    const visited = new Set<number>();
    for (let block = firstBlock; block !== 0;) {
      if (visited.has(block)) {
        throw corrupted(`цикл в blob-цепочке на блоке ${String(block)}`);
      }
      visited.add(block);
      const offset = block * BLOB_BLOCK_SIZE;
      const next = data.readUInt32LE(offset);
      const length = data.readUInt16LE(offset + 4);
      if (length > BLOB_BLOCK_DATA) {
        throw corrupted(`длина фрагмента blob ${String(length)}`);
      }
      parts.push(data.subarray(offset + 6, offset + 6 + length));
      block = next;
    }
    return Buffer.concat(parts);
  });
}

/** Номера страниц из списка (uint32 до первого нуля). */
function readPageList(list: Buffer): number[] {
  const pages: number[] = [];
  for (let offset = 0; offset + 4 <= list.length; offset += 4) {
    const page = list.readUInt32LE(offset);
    if (page === 0) {
      break;
    }
    pages.push(page);
  }
  return pages;
}

function isValidPageSize(pageSize: number): boolean {
  return pageSize >= 4096 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
}

function corrupted(detail: string): OneCdFormatError {
  return new OneCdFormatError('corrupted', `Файл хранилища повреждён или изменяется платформой (${detail}) — повторите обновление.`);
}

/** Выход чтения Buffer за границы данных означает повреждённый (или дописываемый) файл. */
function guardRange<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof RangeError) {
      throw corrupted(error.message);
    }
    throw error;
  }
}
