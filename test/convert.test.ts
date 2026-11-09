import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { buildConversation, relocateToolResults, toKiroToolUseId } from "../src/convert.ts";
import { EMPTY_CONTENT_PLACEHOLDER, INTERRUPTED_TOOL_RESULT, repair, validate } from "../src/invariants.ts";
import type { KiroEntry } from "../src/wire.ts";

const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 0 });
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant",
  content,
  api: "x",
  provider: "x",
  model: "x",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason,
  timestamp: 0,
});
const call = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, arguments: { path: id } });
const result = (id: string, text = `out-${id}`, isError = false): ToolResultMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError, timestamp: 0 }) as ToolResultMessage;

const build = (messages: Message[], extra: Partial<Parameters<typeof buildConversation>[0]> = {}) =>
  buildConversation({ messages, modelId: "m-1.0", systemPrompt: "", tools: [], contextWindow: 200000, ...extra });

test("simple turn: system prompt prefixes the only user message", () => {
  const c = build([user("hi")], { systemPrompt: "SYS" });
  assert.equal(c.history.length, 0);
  assert.equal(c.current.content, "SYS\n\nhi");
  assert.equal(c.current.origin, "KIRO_CLI");
  assert.equal(c.current.modelId, "m-1.0");
});

test("system prompt goes to the first user message in history, not the current one", () => {
  const c = build([user("first"), assistant([{ type: "text", text: "ok" }]), user("second")], { systemPrompt: "SYS" });
  assert.equal((c.history[0] as { userInputMessage: { content: string } }).userInputMessage.content, "SYS\n\nfirst");
  assert.equal(c.current.content, "second");
});

test("tool round-trip: results become the current message with empty content", () => {
  const c = build([user("go"), assistant([{ type: "text", text: "calling" }, call("a"), call("b")]), result("a"), result("b", "bad", true)]);
  assert.equal(c.current.content, "");
  assert.deepEqual(c.current.userInputMessageContext?.toolResults, [
    { toolUseId: "a", status: "success", content: [{ text: "out-a" }] },
    { toolUseId: "b", status: "error", content: [{ text: "bad" }] },
  ]);
  assert.deepEqual(validate([...c.history, { userInputMessage: c.current }]), []);
});

test("thinking is not replayed; a thinking-only turn keeps empty content", () => {
  const c = build([user("a"), assistant([{ type: "thinking", thinking: "secret plan" }]), user("b")]);
  assert.deepEqual(c.history[1], { assistantResponseMessage: { content: "" } });
  assert.ok(!JSON.stringify(c).includes("secret plan"));
});

test("errored and aborted assistant turns are dropped and the user turns merge", () => {
  const c = build([user("a"), assistant([{ type: "text", text: "partial" }], "error"), user("b")]);
  assert.equal(c.history.length, 0);
  assert.equal(c.current.content, "a\n\nb");
});

test("tools are attached to the current message, with placeholders for history-only tools (I8)", () => {
  const c = build([user("go"), assistant([call("a", "gone_tool")]), result("a")], {
    tools: [{ name: "read", description: "Read", parameters: { type: "object" } as never }],
  });
  const names = c.current.userInputMessageContext?.tools?.map((t) => t.toolSpecification.name);
  assert.deepEqual(names, ["read", "gone_tool"]);
});

test("foreign tool IDs are remapped deterministically and pair up (I9)", () => {
  const foreign = `call_${"x".repeat(70)}|fc_123`;
  const mapped = toKiroToolUseId(foreign);
  assert.match(mapped, /^pi_[A-Za-z0-9_-]{32}$/);
  assert.equal(toKiroToolUseId(foreign), mapped);
  assert.equal(toKiroToolUseId("tooluse_ok-1.2:3"), "tooluse_ok-1.2:3");
  const c = build([user("go"), assistant([call(foreign)]), result(foreign)]);
  assert.equal(c.current.userInputMessageContext?.toolResults?.[0]?.toolUseId, mapped);
});

test("displaced results are relocated next to their call", () => {
  const msgs: Message[] = [user("go"), assistant([call("A")]), user("interject"), assistant([call("B")]), result("A"), result("B")];
  const order = relocateToolResults(msgs).map((m) => (m.role === "toolResult" ? `r:${m.toolCallId}` : m.role));
  assert.deepEqual(order, ["user", "assistant", "r:A", "user", "assistant", "r:B"]);
  const c = build(msgs);
  assert.deepEqual(validate([...c.history, { userInputMessage: c.current }]), []);
  assert.ok(JSON.stringify(c).includes("out-A"));
});

test("an unanswered final tool call gets a synthetic error result", () => {
  const c = build([user("go"), assistant([call("a")])]);
  assert.deepEqual(c.current.userInputMessageContext?.toolResults, [
    { toolUseId: "a", status: "error", content: [{ text: INTERRUPTED_TOOL_RESULT }] },
  ]);
});

test("conversation ending on a plain assistant turn gets a placeholder user turn", () => {
  const c = build([user("hi"), assistant([{ type: "text", text: "hello" }])]);
  assert.equal(c.current.content, EMPTY_CONTENT_PLACEHOLDER);
});

test("image-only user message gets the placeholder and keeps its image", () => {
  const c = build([user([{ type: "image", data: "AAAA", mimeType: "image/PNG" }])]);
  assert.equal(c.current.content, EMPTY_CONTENT_PLACEHOLDER);
  assert.deepEqual(c.current.images, [{ format: "png", source: { bytes: "AAAA" } }]);
});

test("only the newest bounded image survives in history (I13)", () => {
  const img = (d: string) => user([{ type: "image", data: d, mimeType: "image/png" }, { type: "text", text: d }]);
  const c = build([img("old"), assistant([{ type: "text", text: "1" }]), img("new"), assistant([{ type: "text", text: "2" }]), user("now")]);
  const withImages = c.history.filter((e) => "userInputMessage" in e && e.userInputMessage.images);
  assert.equal(withImages.length, 1);
  assert.ok(JSON.stringify(withImages[0]).includes("new"));
});

test("history over the size budget fails locally as a context overflow", () => {
  const big = "x".repeat(10_000);
  const msgs: Message[] = [];
  for (let i = 0; i < 5; i++) msgs.push(user(big), assistant([{ type: "text", text: big }]));
  msgs.push(user("now"));
  assert.throws(() => build(msgs, { contextWindow: 5000 }), /context_length_exceeded/);
});

test("unpaired surrogates are replaced (I11)", () => {
  const c = build([user("bad \uD800 char")]);
  assert.equal(c.current.content, "bad � char");
});

test("long tool results are truncated in the middle", () => {
  const c = build([user("go"), assistant([call("a")]), result("a", `${"a".repeat(200_000)}${"z".repeat(200_000)}`)]);
  const text = c.current.userInputMessageContext?.toolResults?.[0]?.content[0]?.text ?? "";
  assert.ok(text.length < 251_000);
  assert.ok(text.startsWith("aaa") && text.endsWith("zzz") && text.includes("[truncated"));
});

test("repair handles orphans, duplicates and leading carriers deterministically", () => {
  const u = (content: string, results?: string[]): KiroEntry => ({
    userInputMessage: {
      content,
      modelId: "m",
      origin: "KIRO_CLI",
      ...(results ? { userInputMessageContext: { toolResults: results.map((id) => ({ toolUseId: id, status: "success" as const, content: [{ text: id }] })) } } : {}),
    },
  });
  const a = (uses: string[]): KiroEntry => ({
    assistantResponseMessage: { content: "", toolUses: uses.map((id) => ({ toolUseId: id, name: "t", input: {} })) },
  });
  const input = [u("", ["stray"]), u("hello"), a(["x", "y"]), u("", ["x", "x", "zzz"])];
  const r1 = repair(input, "m");
  const r2 = repair(input, "m");
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1.remaining, []);
  assert.ok(r1.found.length > 0);
  const last = r1.entries[r1.entries.length - 1] as { userInputMessage: { userInputMessageContext: { toolResults: { toolUseId: string; status: string }[] } } };
  assert.deepEqual(
    last.userInputMessage.userInputMessageContext.toolResults.map((r) => `${r.toolUseId}:${r.status}`),
    ["x:success", "y:error"],
  );
});
