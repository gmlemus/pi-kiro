import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEvent } from "../src/events.ts";
import { EventStreamDecoder, encodeMessage } from "../src/eventstream.ts";
import { event, exception } from "./helpers.ts";

const decode = (bytes: Uint8Array) => {
  const [msg] = new EventStreamDecoder().push(bytes);
  assert.ok(msg);
  return decodeEvent(msg);
};

test("routes content, tool, reasoning and usage events by :event-type", () => {
  assert.deepEqual(decode(event("assistantResponseEvent", { content: "hi" })), { kind: "text", text: "hi" });
  assert.deepEqual(decode(event("toolUseEvent", { toolUseId: "t1", name: "read", input: '{"a"' })), {
    kind: "toolUse",
    toolUseId: "t1",
    name: "read",
    input: '{"a"',
    stop: false,
  });
  assert.deepEqual(decode(event("toolUseEvent", { stop: true })), { kind: "toolUse", input: "", stop: true });
  assert.deepEqual(decode(event("reasoningContentEvent", { text: "hmm" })), { kind: "reasoning", text: "hmm", redacted: false });
  assert.deepEqual(decode(event("contextUsageEvent", { contextUsagePercentage: 12.5 })), { kind: "contextUsage", percent: 12.5 });
  assert.deepEqual(
    decode(event("metadataEvent", { tokenUsage: { uncachedInputTokens: 10, outputTokens: 5 }, stopReason: "END_TURN" })),
    { kind: "metadata", data: { uncachedInputTokens: 10, outputTokens: 5, stopReason: "END_TURN" } },
  );
});

test("metering usage is credits, never tokens", () => {
  assert.deepEqual(decode(event("meteringEvent", { usage: 0.4, unit: "credit" })), { kind: "metering", credits: 0.4 });
});

test("routing ignores misleading fields: a content field on a toolUseEvent is not text", () => {
  const ev = decode(event("toolUseEvent", { content: "not text", toolUseId: "t", name: "n" }));
  assert.equal(ev.kind, "toolUse");
});

test("unknown and known-unused event types are ignored, not fatal", () => {
  assert.deepEqual(decode(event("brandNewEvent", { x: 1 })), { kind: "ignored", eventType: "unknown:brandNewEvent" });
  assert.deepEqual(decode(event("codeReferenceEvent", {})), { kind: "ignored", eventType: "codeReferenceEvent" });
});

test("exception frames classify from the header even with a non-JSON body", () => {
  assert.deepEqual(decode(exception("ThrottlingException", { message: "slow down", retryAfterMilliseconds: 1500 })), {
    kind: "error",
    error: { kind: "throttling", name: "ThrottlingException", message: "slow down", retryAfterMs: 1500 },
  });
  assert.deepEqual(decode(exception("validationError", "<html>oops")), {
    kind: "error",
    error: { kind: "validation", name: "validationError" },
  });
  assert.equal((decode(exception("SomethingNew", {})) as { error: { kind: string } }).error.kind, "unknown");
});

test("error message frames use :error-code / :error-message", () => {
  const bytes = encodeMessage({ ":message-type": "error", ":error-code": "InternalFailure", ":error-message": "boom" }, "");
  assert.deepEqual(decode(bytes), { kind: "error", error: { kind: "unknown", name: "InternalFailure", message: "boom" } });
});

test("malformed event payloads and missing types are protocol errors", () => {
  assert.throws(() => decode(encodeMessage({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, "{nope")), /not a JSON object/);
  assert.throws(() => decode(encodeMessage({ ":message-type": "event" }, "{}")), /without :event-type/);
  assert.throws(() => decode(encodeMessage({ ":message-type": "weird" }, "{}")), /unknown :message-type/);
});
