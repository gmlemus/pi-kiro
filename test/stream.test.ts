import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { type Api, type Model, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createStreamKiro, policy } from "../src/stream.ts";
import { API_KEY, collect, event, exception, fakeFetch, headerOf, streamResponse, testCatalog } from "./helpers.ts";

const catalog = testCatalog({
  properties: { output_config: { properties: { effort: { enum: ["low", "medium", "high"] } } } },
});
const model = { ...(catalog.models[0] as object), provider: "kiro-secure" } as Model<Api>;
const ctx = normalizeContext({ systemPrompt: "Be brief.", messages: [{ role: "user", content: "hi", timestamp: 0 }] });

beforeEach(() => {
  Object.assign(policy, {
    headerTimeoutMs: 200,
    firstEventTimeoutMs: 200,
    idleTimeoutMs: 200,
    backoffBaseMs: 1,
    maxBackoffMs: 5,
    capacityBaseMs: 1,
    capacityMaxMs: 2,
    rateFallbackMs: 1,
  });
});

function run(responders: Parameters<typeof fakeFetch>[0], options: SimpleStreamOptions = {}) {
  const f = fakeFetch(responders);
  const streamKiro = createStreamKiro(() => catalog, f.impl);
  return { events: collect(streamKiro(model, ctx, { apiKey: API_KEY, ...options })), calls: f.calls };
}

test("text response: request shape, headers, events, usage", async () => {
  const { events, calls } = run([
    () =>
      streamResponse([
        event("assistantResponseEvent", { content: "Hel" }),
        event("assistantResponseEvent", { content: "lo" }),
        event("contextUsageEvent", { contextUsagePercentage: 1 }),
        event("metadataEvent", { tokenUsage: { uncachedInputTokens: 11, outputTokens: 2, cacheReadInputTokens: 3 }, stopReason: "END_TURN" }),
      ]),
  ]);
  const evs = await events;
  assert.deepEqual(evs.map((e) => e.type), ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
  const done = evs.at(-1) as Extract<(typeof evs)[number], { type: "done" }>;
  assert.equal(done.message.stopReason, "stop");
  assert.equal(done.message.rawStopReason, "END_TURN");
  assert.deepEqual(done.message.content, [{ type: "text", text: "Hello" }]);
  assert.deepEqual([done.message.usage.input, done.message.usage.output, done.message.usage.cacheRead, done.message.usage.totalTokens], [11, 2, 3, 16]);

  const [call] = calls;
  assert.ok(call);
  assert.equal(call.url, "https://runtime.us-east-1.kiro.dev/generateAssistantResponse");
  assert.equal(headerOf(call, "authorization"), `Bearer ${API_KEY}`);
  assert.equal(headerOf(call, "tokentype"), "API_KEY");
  assert.equal(headerOf(call, "accept"), "application/vnd.amazon.eventstream");
  assert.match(headerOf(call, "user-agent") ?? "", /^pi-kiro-secure\//);
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.profileArn, catalog.profileArn);
  assert.equal(body.agentMode, "vibe");
  assert.equal(body.conversationState.currentMessage.userInputMessage.content, "Be brief.\n\nhi");
  assert.equal(body.conversationState.currentMessage.userInputMessage.modelId, "claude-sonnet-4.6");
  assert.equal(body.additionalModelRequestFields, undefined, "no reasoning requested");
});

test("reasoning: structured effort, directive, native and inline thinking", async () => {
  const { events, calls } = run(
    [
      () =>
        streamResponse([
          event("reasoningContentEvent", { text: "native " }),
          event("reasoningContentEvent", { signature: "sig" }),
          event("assistantResponseEvent", { content: "<thinking>inline</thinking>\n\nAnswer" }),
          event("metadataEvent", { stopReason: "END_TURN" }),
        ]),
    ],
    { reasoning: "high" },
  );
  const evs = await events;
  const done = evs.at(-1) as Extract<(typeof evs)[number], { type: "done" }>;
  assert.deepEqual(done.message.content, [
    { type: "thinking", thinking: "native ", thinkingSignature: "sig" },
    { type: "thinking", thinking: "inline" },
    { type: "text", text: "Answer" },
  ]);
  assert.equal(done.message.providerThinkingLevel, "high");
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.deepEqual(body.additionalModelRequestFields, { output_config: { effort: "high" }, thinking: { type: "adaptive" } });
  assert.match(body.conversationState.currentMessage.userInputMessage.content, /^<thinking_mode>enabled<\/thinking_mode><max_thinking_length>30000</);
});

test("tool call split across frames, plus a malformed one kept with argumentsError", async () => {
  const { events } = run([
    () =>
      streamResponse([
        event("toolUseEvent", { toolUseId: "t1", name: "read", input: '{"pa' }),
        event("toolUseEvent", { toolUseId: "t1", name: "read", input: 'th":"a.txt"}' }),
        event("toolUseEvent", { toolUseId: "t1", name: "read", stop: true }),
        event("toolUseEvent", { toolUseId: "t2", name: "write", input: "{broken" }),
        event("metadataEvent", { stopReason: "TOOL_USE" }),
      ]),
  ]);
  const evs = await events;
  const done = evs.at(-1) as Extract<(typeof evs)[number], { type: "done" }>;
  assert.equal(done.message.stopReason, "toolUse");
  assert.deepEqual(done.message.content[0], { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } });
  const bad = done.message.content[1] as { arguments: object; argumentsError?: string };
  assert.deepEqual(bad.arguments, {});
  assert.match(bad.argumentsError ?? "", /not a valid JSON object/);
  assert.deepEqual(
    evs.filter((e) => e.type.startsWith("toolcall")).map((e) => e.type),
    ["toolcall_start", "toolcall_delta", "toolcall_end", "toolcall_start", "toolcall_delta", "toolcall_end"],
  );
});

test("stop reasons: MAX_TOKENS -> length, no metadata and no context usage -> length", async () => {
  const a = await run([() => streamResponse([event("assistantResponseEvent", { content: "x" }), event("metadataEvent", { stopReason: "MAX_TOKENS" })])]).events;
  assert.equal((a.at(-1) as { message: { stopReason: string } }).message.stopReason, "length");
  const b = await run([() => streamResponse([event("assistantResponseEvent", { content: "x" })])]).events;
  assert.equal((b.at(-1) as { message: { stopReason: string } }).message.stopReason, "length");
});

test("terminal stop reasons become errors pi can classify", async () => {
  const overflow = await run([() => streamResponse([event("metadataEvent", { stopReason: "MODEL_CONTEXT_WINDOW_EXCEEDED" })])]).events;
  const err = overflow.at(-1) as Extract<(typeof overflow)[number], { type: "error" }>;
  assert.equal(err.type, "error");
  assert.match(err.error.errorMessage ?? "", /context_length_exceeded/);

  const filtered = await run([
    () => streamResponse([event("toolUseEvent", { toolUseId: "t", name: "rm", input: "{}", stop: true }), event("metadataEvent", { stopReason: "CONTENT_FILTERED" })]),
  ]).events;
  const f = filtered.at(-1) as Extract<(typeof filtered)[number], { type: "error" }>;
  assert.match(f.error.errorMessage ?? "", /CONTENT_FILTERED/);
  assert.ok(!f.error.content.some((b) => b.type === "toolCall"), "filtered tool calls must not survive");
});

test("exception before any output is retried, honoring retryAfterMilliseconds", async () => {
  const { events, calls } = run([
    () => streamResponse([exception("ThrottlingException", { message: "slow", retryAfterMilliseconds: 1 })]),
    () => streamResponse([event("assistantResponseEvent", { content: "ok" }), event("metadataEvent", { stopReason: "END_TURN" })]),
  ]);
  const evs = await events;
  assert.equal(calls.length, 2);
  assert.equal(evs.filter((e) => e.type === "start").length, 1);
  assert.equal(evs.at(-1)?.type, "done");
});

test("exception after output reached pi is surfaced, not retried", async () => {
  const { events, calls } = run([
    () => streamResponse([event("assistantResponseEvent", { content: "partial" }), exception("internalServerException", { message: "boom" })]),
  ]);
  const evs = await events;
  assert.equal(calls.length, 1);
  const err = evs.at(-1) as Extract<(typeof evs)[number], { type: "error" }>;
  assert.equal(err.reason, "error");
  assert.ok(evs.some((e) => e.type === "text_end"), "open block is closed before the error");
});

test("validation exceptions are not retried", async () => {
  const { events, calls } = run([() => streamResponse([exception("ValidationException", { message: "bad", reason: "INVALID" })])]);
  const evs = await events;
  assert.equal(calls.length, 1);
  assert.equal(evs.at(-1)?.type, "error");
});

test("capacity and rate rejections are retried inside the provider", async () => {
  const { events, calls } = run([
    () => new Response('{"reason":"INSUFFICIENT_MODEL_CAPACITY"}', { status: 429 }),
    () => new Response('{"reason":"USER_REQUEST_RATE_EXCEEDED"}', { status: 429, headers: { "retry-after-ms": "1" } }),
    () => streamResponse([event("assistantResponseEvent", { content: "ok" }), event("metadataEvent", { stopReason: "END_TURN" })]),
  ]);
  assert.equal((await events).at(-1)?.type, "done");
  assert.equal(calls.length, 3);
});

test("quota exhaustion is final and worded as non-retryable", async () => {
  const { events, calls } = run([() => new Response('{"reason":"MONTHLY_REQUEST_COUNT"}', { status: 429 })]);
  const err = (await events).at(-1) as { type: string; error: { errorMessage: string } };
  assert.equal(calls.length, 1);
  assert.equal(err.type, "error");
  assert.match(err.error.errorMessage, /quota exceeded/);
  assert.doesNotMatch(err.error.errorMessage, /429/);
});

test("empty responses are retried, then reported", async () => {
  const empty = () => streamResponse([]);
  const { events, calls } = run([empty, empty, empty, empty]);
  const err = (await events).at(-1) as { type: string; error: { errorMessage: string } };
  assert.equal(calls.length, policy.maxAttempts);
  assert.match(err.error.errorMessage, /empty response/);
});

test("first-event timeout retries; idle timeout after output is surfaced", async () => {
  const ok = () => streamResponse([event("assistantResponseEvent", { content: "ok" }), event("metadataEvent", { stopReason: "END_TURN" })]);
  const a = run([() => streamResponse([], { hangAfter: 0 }), ok]);
  assert.equal((await a.events).at(-1)?.type, "done");
  assert.equal(a.calls.length, 2);

  const first = event("assistantResponseEvent", { content: "x" });
  const b = run([() => streamResponse([first], { chunkSize: first.length, hangAfter: first.length })]);
  const err = (await b.events).at(-1) as { type: string; error: { errorMessage: string } };
  assert.equal(err.type, "error");
  assert.match(err.error.errorMessage, /timed out/);
});

test("abort mid-stream ends with an aborted result", async () => {
  const controller = new AbortController();
  const first = event("assistantResponseEvent", { content: "x" });
  const { events } = run([() => streamResponse([first], { chunkSize: first.length, hangAfter: first.length })], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const evs = await events;
  const last = evs.at(-1) as Extract<(typeof evs)[number], { type: "error" }>;
  assert.equal(last.reason, "aborted");
  assert.equal(last.error.stopReason, "aborted");
});

test("pi hooks: onPayload can replace the body, onResponse and onProviderStreamEvent are called", async () => {
  const seen: unknown[] = [];
  const statuses: number[] = [];
  const { events, calls } = run(
    [() => streamResponse([event("assistantResponseEvent", { content: "ok" }), event("metadataEvent", { stopReason: "END_TURN" })])],
    {
      onPayload: (p) => ({ ...(p as object), marker: true }),
      onResponse: (r) => {
        statuses.push(r.status);
      },
      onProviderStreamEvent: (e) => {
        seen.push(e);
      },
    },
  );
  await events;
  assert.equal(JSON.parse(String(calls[0]?.init.body)).marker, true);
  assert.deepEqual(statuses, [200]);
  assert.deepEqual(seen[0], { kind: "text", text: "ok" });
});

test("caller headers cannot override authentication", async () => {
  const { events, calls } = run(
    [() => streamResponse([event("assistantResponseEvent", { content: "ok" }), event("metadataEvent", { stopReason: "END_TURN" })])],
    { headers: { Authorization: "Bearer other", "x-extra": "1", "user-agent": null } },
  );
  await events;
  const call = calls[0];
  assert.ok(call);
  assert.equal(headerOf(call, "authorization"), `Bearer ${API_KEY}`);
  assert.equal(headerOf(call, "x-extra"), "1");
  assert.equal(headerOf(call, "user-agent"), undefined);
});

test("a corrupted frame is a terminal protocol error", async () => {
  const bad = event("assistantResponseEvent", { content: "x" });
  bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 0xff;
  const evs = await run([() => streamResponse([bad])]).events;
  const err = evs.at(-1) as { type: string; error: { errorMessage: string } };
  assert.equal(err.type, "error");
  assert.match(err.error.errorMessage, /CRC mismatch/);
});

test("missing API key throws synchronously; unknown model errors on the stream", async () => {
  const streamKiro = createStreamKiro(() => catalog, fakeFetch([]).impl);
  assert.throws(() => streamKiro(model, ctx, {}), /KIRO_API_KEY/);
  const evs = await collect(streamKiro({ ...model, id: "nope" }, ctx, { apiKey: API_KEY }));
  assert.equal(evs.length, 1);
  assert.match((evs[0] as { error: { errorMessage: string } }).error.errorMessage, /not in this Kiro API key's model catalog/);
});
