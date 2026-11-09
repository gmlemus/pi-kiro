import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, EventStreamDecoder, EventStreamError, encodeMessage } from "../src/eventstream.ts";
import { concat } from "./helpers.ts";

const frameA = encodeMessage({ ":event-type": "a", ":message-type": "event" }, '{"content":"héllo"}');
const frameB = encodeMessage({ ":event-type": "b" }, "");

test("crc32 matches the IEEE check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("decodes frames delivered one byte at a time", () => {
  const d = new EventStreamDecoder();
  const all = concat([frameA, frameB]);
  const out = [];
  for (const byte of all) out.push(...d.push(Uint8Array.of(byte)));
  d.finish();
  assert.equal(out.length, 2);
  assert.equal(out[0]?.headers[":event-type"], "a");
  assert.equal(new TextDecoder().decode(out[0]?.payload), '{"content":"héllo"}');
  assert.equal(out[1]?.payload.length, 0);
});

test("decodes several frames from one chunk", () => {
  const d = new EventStreamDecoder();
  assert.equal(d.push(concat([frameA, frameB, frameA])).length, 3);
});

test("rejects a corrupted prelude CRC", () => {
  const bad = frameA.slice();
  bad[9] = (bad[9] as number) ^ 0xff;
  assert.throws(() => new EventStreamDecoder().push(bad), EventStreamError);
});

test("rejects a corrupted payload via the message CRC", () => {
  const bad = frameA.slice();
  bad[bad.length - 6] = (bad[bad.length - 6] as number) ^ 0x01;
  assert.throws(() => new EventStreamDecoder().push(bad), /message CRC mismatch/);
});

function rawPrelude(total: number, headers: number): Uint8Array {
  const p = new Uint8Array(12);
  const v = new DataView(p.buffer);
  v.setUint32(0, total);
  v.setUint32(4, headers);
  v.setUint32(8, crc32(p, 0, 8));
  return p;
}

test("rejects oversized and undersized lengths before buffering them", () => {
  assert.throws(() => new EventStreamDecoder(1024).push(rawPrelude(2048, 0)), /exceeds 1024/);
  assert.throws(() => new EventStreamDecoder().push(rawPrelude(8, 0)), /too small/);
  assert.throws(() => new EventStreamDecoder().push(rawPrelude(32, 20)), /headers overflow/);
});

test("finish rejects a trailing partial frame", () => {
  const d = new EventStreamDecoder();
  d.push(frameA.slice(0, 20));
  assert.throws(() => d.finish(), /ended inside a frame/);
});

function frameWithRawHeaders(headerBytes: number[]): Uint8Array {
  const total = 12 + headerBytes.length + 4;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, total);
  v.setUint32(4, headerBytes.length);
  v.setUint32(8, crc32(out, 0, 8));
  out.set(headerBytes, 12);
  v.setUint32(total - 4, crc32(out, 0, total - 4));
  return out;
}

test("parses every header value type", () => {
  const name = (s: string) => [s.length, ...new TextEncoder().encode(s)];
  const bytes = [
    ...name("t"), 0,
    ...name("f"), 1,
    ...name("b"), 2, 0xff,
    ...name("s"), 3, 0x01, 0x02,
    ...name("i"), 4, 0, 0, 1, 0,
    ...name("l"), 5, 0, 0, 0, 0, 0, 0, 0, 7,
    ...name("y"), 6, 0, 2, 9, 8,
    ...name("st"), 7, 0, 2, 0x68, 0x69,
    ...name("ts"), 8, 0, 0, 0, 0, 0, 0, 0x03, 0xe8,
    ...name("u"), 9, ...Array(16).fill(0xab),
  ];
  const [msg] = new EventStreamDecoder().push(frameWithRawHeaders(bytes));
  const h = msg?.headers ?? {};
  assert.equal(h.t, true);
  assert.equal(h.f, false);
  assert.equal(h.b, -1);
  assert.equal(h.s, 0x0102);
  assert.equal(h.i, 256);
  assert.equal(h.l, 7n);
  assert.deepEqual(h.y, Uint8Array.of(9, 8));
  assert.equal(h.st, "hi");
  assert.equal((h.ts as Date).getTime(), 1000);
  assert.equal(h.u, "ab".repeat(16));
});

test("rejects unknown header types, truncation, duplicates and bad UTF-8", () => {
  const name = (s: string) => [s.length, ...new TextEncoder().encode(s)];
  const decode = (b: number[]) => () => new EventStreamDecoder().push(frameWithRawHeaders(b));
  assert.throws(decode([...name("x"), 42]), /unknown header value type/);
  assert.throws(decode([...name("x"), 7, 0, 9, 0x61]), /truncated/);
  assert.throws(decode([...name("x"), 0, ...name("x"), 1]), /duplicate header/);
  assert.throws(decode([...name("x"), 7, 0, 1, 0xff]), /not valid UTF-8/);
});

test("header names cannot pollute the prototype", () => {
  const msg = new EventStreamDecoder().push(encodeMessage({ __proto__: "x", constructor: "y" } as never, ""))[0];
  // encodeMessage drops __proto__ as an own key; constructor arrives as a plain header.
  assert.equal(Object.getPrototypeOf(msg?.headers), null);
  assert.equal(msg?.headers.constructor, "y");
});
