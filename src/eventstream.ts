// Decoder for the AWS event-stream binary framing (PROTOCOL.md §4.2).
//
// Every frame is length-prefixed and covered by two CRC-32 checksums. The
// decoder buffers across network chunks, verifies both checksums before
// trusting a single header byte, and treats any malformed frame as fatal:
// there is no attempt to resynchronise on a corrupted stream.

const PRELUDE_BYTES = 12;
const MIN_MESSAGE_BYTES = 16; // prelude + trailing message CRC, no headers or payload
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type HeaderValue = boolean | number | bigint | string | Uint8Array | Date;

export interface EventStreamMessage {
  headers: Record<string, HeaderValue>;
  payload: Uint8Array;
}

export class EventStreamError extends Error {
  constructor(message: string) {
    super(`Kiro event-stream protocol error: ${message}`);
    this.name = "EventStreamError";
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3 / zlib) over `bytes[start, end)`. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new EventStreamError(`${what} is not valid UTF-8`);
  }
}

function parseHeaders(bytes: Uint8Array): Record<string, HeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Null prototype: header names come off the wire and must not be able to
  // shadow Object.prototype members such as `constructor` or `__proto__`.
  const headers: Record<string, HeaderValue> = Object.create(null);
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new EventStreamError("header block is truncated");
  };
  while (pos < bytes.length) {
    need(1);
    const nameLen = view.getUint8(pos);
    pos += 1;
    if (nameLen === 0) throw new EventStreamError("empty header name");
    need(nameLen);
    const name = decodeUtf8(bytes.subarray(pos, pos + nameLen), "header name");
    pos += nameLen;
    need(1);
    const type = view.getUint8(pos);
    pos += 1;
    let value: HeaderValue;
    switch (type) {
      case 0:
        value = true;
        break;
      case 1:
        value = false;
        break;
      case 2:
        need(1);
        value = view.getInt8(pos);
        pos += 1;
        break;
      case 3:
        need(2);
        value = view.getInt16(pos);
        pos += 2;
        break;
      case 4:
        need(4);
        value = view.getInt32(pos);
        pos += 4;
        break;
      case 5:
        need(8);
        value = view.getBigInt64(pos);
        pos += 8;
        break;
      case 6:
      case 7: {
        need(2);
        const len = view.getUint16(pos);
        pos += 2;
        need(len);
        const raw = bytes.slice(pos, pos + len);
        value = type === 6 ? raw : decodeUtf8(raw, `header ${name}`);
        pos += len;
        break;
      }
      case 8:
        need(8);
        value = new Date(Number(view.getBigInt64(pos)));
        pos += 8;
        break;
      case 9: {
        need(16);
        value = Array.from(bytes.subarray(pos, pos + 16), (b) => b.toString(16).padStart(2, "0")).join("");
        pos += 16;
        break;
      }
      default:
        throw new EventStreamError(`unknown header value type ${type}`);
    }
    if (Object.hasOwn(headers, name)) throw new EventStreamError(`duplicate header ${name}`);
    headers[name] = value;
  }
  return headers;
}

/**
 * Incremental decoder. Feed it raw body chunks with `push`; it returns every
 * message completed so far. Call `finish` when the body ends to reject a
 * trailing partial frame.
 */
export class EventStreamDecoder {
  #chunks: Uint8Array[] = [];
  #size = 0;
  readonly #maxMessageBytes: number;

  constructor(maxMessageBytes = MAX_MESSAGE_BYTES) {
    this.#maxMessageBytes = maxMessageBytes;
  }

  push(chunk: Uint8Array): EventStreamMessage[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
    }
    const out: EventStreamMessage[] = [];
    while (this.#size >= PRELUDE_BYTES) {
      const prelude = this.#contiguous(PRELUDE_BYTES);
      const view = new DataView(prelude.buffer, prelude.byteOffset, PRELUDE_BYTES);
      const totalLength = view.getUint32(0);
      const headersLength = view.getUint32(4);
      if (crc32(prelude, 0, 8) !== view.getUint32(8)) throw new EventStreamError("prelude CRC mismatch");
      if (totalLength < MIN_MESSAGE_BYTES) throw new EventStreamError(`message length ${totalLength} is too small`);
      if (totalLength > this.#maxMessageBytes) {
        throw new EventStreamError(`message length ${totalLength} exceeds ${this.#maxMessageBytes}`);
      }
      if (headersLength > totalLength - MIN_MESSAGE_BYTES) throw new EventStreamError("headers overflow the message");
      // Only flatten once the whole frame has arrived, so a large frame
      // delivered in many small chunks is copied once rather than per chunk.
      if (this.#size < totalLength) break;
      const frame = this.#contiguous(totalLength);
      const frameView = new DataView(frame.buffer, frame.byteOffset, totalLength);
      if (crc32(frame, 0, totalLength - 4) !== frameView.getUint32(totalLength - 4)) {
        throw new EventStreamError("message CRC mismatch");
      }
      const headers = parseHeaders(frame.subarray(PRELUDE_BYTES, PRELUDE_BYTES + headersLength));
      const payload = frame.slice(PRELUDE_BYTES + headersLength, totalLength - 4);
      this.#consume(totalLength);
      out.push({ headers, payload });
    }
    return out;
  }

  finish(): void {
    if (this.#size > 0) throw new EventStreamError(`stream ended inside a frame (${this.#size} bytes pending)`);
  }

  /** Make the first `n` buffered bytes contiguous and return a view of them. */
  #contiguous(n: number): Uint8Array {
    const head = this.#chunks[0] as Uint8Array;
    if (head.length >= n) return head;
    const merged = new Uint8Array(this.#size);
    let offset = 0;
    for (const c of this.#chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.#chunks = [merged];
    return merged;
  }

  #consume(n: number): void {
    const head = this.#chunks[0] as Uint8Array;
    if (head.length === n) this.#chunks.shift();
    else this.#chunks[0] = head.subarray(n);
    this.#size -= n;
  }
}

/** Encoder used by tests and the local fake server; supports string headers only. */
export function encodeMessage(headers: Record<string, string>, payload: Uint8Array | string): Uint8Array {
  const enc = new TextEncoder();
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const headerParts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    const part = new Uint8Array(1 + n.length + 1 + 2 + v.length);
    part[0] = n.length;
    part.set(n, 1);
    part[1 + n.length] = 7;
    new DataView(part.buffer).setUint16(2 + n.length, v.length);
    part.set(v, 4 + n.length);
    headerParts.push(part);
  }
  const headersLength = headerParts.reduce((s, p) => s + p.length, 0);
  const total = PRELUDE_BYTES + headersLength + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headersLength);
  view.setUint32(8, crc32(out, 0, 8));
  let offset = PRELUDE_BYTES;
  for (const p of headerParts) {
    out.set(p, offset);
    offset += p.length;
  }
  out.set(body, offset);
  view.setUint32(total - 4, crc32(out, 0, total - 4));
  return out;
}
