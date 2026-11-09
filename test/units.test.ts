import assert from "node:assert/strict";
import { test } from "node:test";
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { deriveEffortConfig, pickEffort, planReasoning } from "../src/effort.ts";
import { classifyHttpError, redact, retryAfterMs } from "../src/errors.ts";
import { regionFromArn } from "../src/http.ts";
import { InlineThinkingSplitter } from "../src/thinking.ts";
import { toPiId } from "../src/catalog.ts";

const asMessage = (errorMessage: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "x",
  provider: "x",
  model: "x",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "error",
  errorMessage,
  timestamp: 0,
});

const classify = (status: number, body: string, headers: Record<string, string> = {}) =>
  classifyHttpError(status, body, new Headers(headers), "GenerateAssistantResponse");

test("HTTP errors classify and read correctly to pi's retry and overflow detectors", () => {
  const cases: Array<[number, string, string, boolean, boolean]> = [
    // status, body, kind, pi retries?, pi treats as overflow?
    [429, '{"message":"limit","reason":"MONTHLY_REQUEST_COUNT"}', "quota", false, false],
    [429, '{"reason":"INSUFFICIENT_MODEL_CAPACITY"}', "capacity", false, false],
    [429, '{"reason":"USER_REQUEST_RATE_EXCEEDED"}', "rate", true, false],
    [400, '{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}', "invalidRequest", false, false],
    [400, '{"reason":"TOOL_USE_RESULT_MISMATCH"}', "invalidRequest", false, false],
    [400, '{"reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}', "tooLarge", false, true],
    [400, "Input is too long for requested model", "tooLarge", false, true],
    [413, "", "tooLarge", false, true],
    [403, '{"__type":"com.amazon#AccessDeniedException","message":"bearer token is invalid"}', "auth", false, false],
    [400, '{"__type":"com.amazon.aws.codewhisperer#AccessDeniedException","message":"Invalid token"}', "auth", false, false],
    [503, "busy", "server", true, false],
  ];
  for (const [status, body, kind, retry, overflow] of cases) {
    const err = classify(status, body);
    assert.equal(err.kind, kind, body);
    assert.equal(isRetryableAssistantError(asMessage(err.message)), retry, `retry: ${err.message}`);
    assert.equal(isContextOverflow(asMessage(err.message)), overflow, `overflow: ${err.message}`);
  }
});

test("errors never echo credentials", () => {
  const err = classify(403, '{"message":"token ksk_abcdef123 rejected; Authorization: Bearer ksk_abcdef123"}');
  assert.ok(!err.message.includes("abcdef123"), err.message);
  assert.equal(redact("x eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl y"), "x [REDACTED_JWT] y");
});

test("retry-after parsing", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after-ms": "250" })), 250);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" })), 2000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 4_000), 6_000);
  assert.equal(retryAfterMs(new Headers({ "x-ratelimit-reset-after": "1.5" })), 1500);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "-3" })), undefined);
});

test("region comes only from a well-formed ARN", () => {
  assert.equal(regionFromArn("arn:aws:codewhisperer:eu-central-1:1:profile/X"), "eu-central-1");
  assert.equal(regionFromArn("arn:aws:codewhisperer:evil.com/x:1:profile/X"), undefined);
  assert.equal(regionFromArn("garbage"), undefined);
});

test("model ids convert between Kiro dot form and pi dash form", () => {
  assert.equal(toPiId("claude-sonnet-4.6"), "claude-sonnet-4-6");
  assert.equal(toPiId("claude-fable-5.1-1m"), "claude-fable-5-1-1m");
});

test("effort config and planning", () => {
  const claude = deriveEffortConfig({
    properties: {
      output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"] } } },
      thinking: { properties: { display: { enum: ["summarized", "omitted"] } } },
    },
  });
  assert.deepEqual(claude, { field: "output_config", values: ["low", "medium", "high", "max"], summarizedThinking: true });
  assert.equal(pickEffort("xhigh", claude?.values ?? []), "max");
  assert.equal(pickEffort("minimal", claude?.values ?? []), "low");

  const plan = planReasoning("high", claude);
  assert.deepEqual(plan.additionalModelRequestFields, {
    output_config: { effort: "high" },
    thinking: { type: "adaptive", display: "summarized" },
  });
  assert.match(plan.directive, /<max_thinking_length>30000</);

  const gpt = deriveEffortConfig({ properties: { reasoning: { properties: { effort: { enum: ["low", "high"] } } } } });
  const gptPlan = planReasoning("medium", gpt);
  assert.deepEqual(gptPlan.additionalModelRequestFields, { reasoning: { effort: "high" } });
  assert.equal(gptPlan.directive, "");

  assert.deepEqual(planReasoning(undefined, claude), { directive: "" });
  assert.equal(deriveEffortConfig({ properties: { reasoning: { properties: { effort: { enum: [] } } } } }), undefined);
});

test("inline thinking splitter handles tags split across chunks", () => {
  const s = new InlineThinkingSplitter();
  const text = "<thinking>step one</thinking>\n\nAnswer <thought>again</thought> done";
  const segs = [];
  for (const ch of text) segs.push(...s.feed(ch));
  segs.push(...s.flush());
  const thinking = segs.filter((x) => x.thinking).map((x) => x.text).join("");
  const visible = segs.filter((x) => !x.thinking).map((x) => x.text).join("");
  assert.equal(thinking, "step oneagain");
  assert.equal(visible, "Answer done");
});

test("inline thinking splitter passes through look-alike text", () => {
  const s = new InlineThinkingSplitter();
  const segs = [...s.feed("a < b and <think"), ...s.feed("er>"), ...s.flush()];
  assert.equal(segs.map((x) => x.text).join(""), "a < b and <thinker>");
  assert.ok(segs.every((x) => !x.thinking));
});
