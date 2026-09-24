import { bodyOf, decodeText, type Ebook, EbookError, htmlToMarkdown } from './html.js';

// Layout: https://wiki.mobileread.com/wiki/MOBI and https://wiki.mobileread.com/wiki/PDB
const PDB_HEADER_SIZE = 78;
const COMPRESSION_NONE = 1;
const COMPRESSION_PALMDOC = 2;
const COMPRESSION_HUFF_CDIC = 17480;
const EXTH_AUTHOR = 100;
const EXTH_UPDATED_TITLE = 503;
const NO_RECORD = 0xffffffff;

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** MOBI, AZW (MOBI 7) and AZW3 (KF8) without DRM; also plain PalmDoc. */
export function parseMobi(data: Uint8Array): Ebook {
  try {
    return readMobi(data);
  } catch (error) {
    if (error instanceof RangeError) throw new EbookError('the file is truncated or corrupted');
    throw error;
  }
}

function readMobi(data: Uint8Array): Ebook {
  if (data.byteLength < PDB_HEADER_SIZE) throw new EbookError('not a MOBI file');
  const kind = ascii(data, 60, 8);
  if (kind !== 'BOOKMOBI' && kind !== 'TEXtREAd') throw new EbookError('not a MOBI file');

  const pdb = viewOf(data);
  const recordCount = pdb.getUint16(76);
  const offsets: number[] = [];
  for (let i = 0; i < recordCount; i++) offsets.push(pdb.getUint32(PDB_HEADER_SIZE + i * 8));
  offsets.push(data.byteLength);
  const record = (index: number): Uint8Array => {
    const start = offsets[index];
    const end = offsets[index + 1];
    if (start === undefined || end === undefined || start > end || end > data.byteLength) {
      throw new RangeError(`Record ${index} is out of bounds`);
    }
    return data.subarray(start, end);
  };

  const header = record(0);
  const view = viewOf(header);
  const compression = view.getUint16(0);
  const textLength = view.getUint32(4);
  const textRecordCount = view.getUint16(8);
  if (view.getUint16(12) !== 0) throw new EbookError('the book is DRM-protected');
  if (compression === COMPRESSION_HUFF_CDIC) {
    throw new EbookError('HUFF/CDIC compression is not supported; convert the book to EPUB');
  }
  if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_PALMDOC) {
    throw new EbookError(`unknown compression ${compression}`);
  }

  const isMobi = header.byteLength >= 20 && ascii(header, 16, 4) === 'MOBI';
  let encoding = 'windows-1252';
  let trailingFlags = 0;
  let title: string | undefined;
  const authors: string[] = [];
  let flows: Array<[number, number]> | undefined;
  if (isMobi) {
    const headerLength = view.getUint32(20);
    if (view.getUint32(28) === 65001) encoding = 'utf-8';
    const version = view.getUint32(36);
    if (headerLength >= 0xe4) trailingFlags = view.getUint16(0xf2);
    const nameOffset = view.getUint32(84);
    const nameLength = view.getUint32(88);
    if (nameLength > 0 && nameOffset + nameLength <= header.byteLength) {
      title = decodeText(header.subarray(nameOffset, nameOffset + nameLength), encoding).trim();
    }
    if (view.getUint32(128) & 0x40) {
      for (const [type, value] of exthRecords(header, 16 + headerLength)) {
        const text = decodeText(value, encoding).trim();
        if (type === EXTH_AUTHOR && text) authors.push(text);
        if (type === EXTH_UPDATED_TITLE && text) title = text;
      }
    }
    if (version >= 8 && headerLength >= 0xb8) {
      const fdstIndex = view.getUint32(0xc0);
      if (fdstIndex !== NO_RECORD && fdstIndex < recordCount) flows = fdstFlows(record(fdstIndex));
    }
  }

  const chunks: Uint8Array[] = [];
  for (let i = 1; i <= textRecordCount && i < recordCount; i++) {
    const raw = record(i);
    const body = raw.subarray(0, raw.byteLength - trailingSize(raw, trailingFlags));
    chunks.push(compression === COMPRESSION_PALMDOC ? palmDocDecompress(body) : body);
  }
  let text = Buffer.concat(chunks).subarray(0, textLength);
  // KF8 stores CSS and SVG as extra flows after the HTML text (flow 0).
  const mainFlow = flows?.[0];
  if (mainFlow) text = text.subarray(mainFlow[0], mainFlow[1]);
  const decoded = decodeText(text, encoding);

  const markdown = isMobi
    ? htmlToMarkdown(bodyOf(decoded))
    : decoded.replace(/\r\n?/g, '\n').trim();
  return { title: title || undefined, authors, parts: markdown ? [markdown] : [] };
}

function* exthRecords(header: Uint8Array, start: number): Generator<[number, Uint8Array]> {
  if (start + 12 > header.byteLength || ascii(header, start, 4) !== 'EXTH') return;
  const view = viewOf(header);
  const count = view.getUint32(start + 8);
  let offset = start + 12;
  for (let i = 0; i < count && offset + 8 <= header.byteLength; i++) {
    const type = view.getUint32(offset);
    const length = view.getUint32(offset + 4);
    if (length < 8) return;
    yield [type, header.subarray(offset + 8, offset + length)];
    offset += length;
  }
}

function fdstFlows(fdst: Uint8Array): Array<[number, number]> | undefined {
  if (fdst.byteLength < 12 || ascii(fdst, 0, 4) !== 'FDST') return undefined;
  const view = viewOf(fdst);
  const count = view.getUint32(8);
  const flows: Array<[number, number]> = [];
  for (let i = 0; i < count && 12 + i * 8 + 8 <= fdst.byteLength; i++) {
    flows.push([view.getUint32(12 + i * 8), view.getUint32(16 + i * 8)]);
  }
  return flows;
}

/** Bytes appended to a text record (indexing data), described by the header's extra flags. */
export function trailingSize(record: Uint8Array, flags: number): number {
  let size = 0;
  for (let bits = flags >> 1; bits; bits >>= 1) {
    if (bits & 1) size += backwardVarint(record, record.byteLength - size);
  }
  if (flags & 1) {
    const last = record[record.byteLength - size - 1];
    if (last !== undefined) size += (last & 0x3) + 1;
  }
  return Math.min(size, record.byteLength);
}

/** Variable-width integer read backwards from `end`; the high bit marks its first byte. */
function backwardVarint(record: Uint8Array, end: number): number {
  let result = 0;
  let shift = 0;
  for (let i = end - 1; i >= 0; i--) {
    const byte = record[i] ?? 0;
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if (byte & 0x80 || shift >= 28) break;
  }
  return result;
}

/** PalmDoc LZ77 variant. */
export function palmDocDecompress(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let i = 0; i < input.byteLength; ) {
    const byte = input[i++] ?? 0;
    if (byte >= 1 && byte <= 8) {
      for (let n = 0; n < byte && i < input.byteLength; n++) output.push(input[i++] ?? 0);
    } else if (byte < 0x80) {
      output.push(byte);
    } else if (byte >= 0xc0) {
      output.push(0x20, byte ^ 0x80);
    } else {
      const pair = (byte << 8) | (input[i++] ?? 0);
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 0x7) + 3;
      if (distance === 0 || distance > output.length) throw new RangeError('Bad back-reference');
      for (let n = 0; n < length; n++) output.push(output[output.length - distance] ?? 0);
    }
  }
  return Uint8Array.from(output);
}
