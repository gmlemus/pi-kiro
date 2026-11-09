// streamSimple implementation: build the request, send it, decode the event
// stream, and translate it into pi's AssistantMessageEvent protocol
// (PROTOCOL.md §3–§7).

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Catalog } from "./catalog.ts";
import { buildConversation } from "./convert.ts";
import { planReasoning } from "./effort.ts";
import { classifyHttpError, KiroError, redact } from "./errors.ts";
import { decodeEvent, type KiroEvent, type MetadataInfo, type StreamErrorInfo } from "./events.ts";
import { EventStreamDecoder } from "./eventstream.ts";
import { authHeaders, baseHeaders, fetchWithHeaderTimeout, sleep } from "./http.ts";
import { InlineThinkingSplitter } from "./thinking.ts";
import type { KiroChatRequest } from "./wire.ts";

/** Client-side policy (PROTOCOL.md §7). Mutable so tests can shorten waits. */
export const policy = {
  headerTimeoutMs: 90_000,
  firstEventTimeoutMs: 90_000,
  idleTimeoutMs: 300_000,
  /** Attempts per turn for stream-level failures, before any output reached pi. */
  maxAttempts: 4,
  backoffBaseMs: 1_000,
  maxBackoffMs: 10_000,
  capacityRetries: 3,
  capacityBaseMs: 5_000,
  capacityMaxMs: 30_000,
  rateRetries: 3,
  rateFallbackMs: 10_000,
};

const PROTECTED_HEADERS = new Set(["authorization", "tokentype", "content-type", "accept"]);

type ResolveCatalog = () => Catalog | undefined;

function zeroUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function backoff(attempt: number): number {
  return Math.min(policy.backoffBaseMs * 2 ** attempt, policy.maxBackoffMs);
}

/** Emits balanced block events into one AssistantMessage. */
class BlockWriter {
  readonly #output: AssistantMessage;
  readonly #stream: AssistantMessageEventStream;
  #open: { type: "text" | "thinking"; index: number } | null = null;
  emitted = false;
  textChars = 0;
  toolCalls = 0;

  constructor(output: AssistantMessage, stream: AssistantMessageEventStream) {
    this.#output = output;
    this.#stream = stream;
  }

  get hasText(): boolean {
    return this.#output.content.some((b) => b.type === "text" && b.text.length > 0);
  }

  #begin(type: "text" | "thinking"): number {
    this.close();
    const index = this.#output.content.length;
    this.#output.content.push(type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
    this.#open = { type, index };
    this.emitted = true;
    this.#stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: this.#output });
    return index;
  }

  text(delta: string): void {
    if (!delta) return;
    const index = this.#open?.type === "text" ? this.#open.index : this.#begin("text");
    (this.#output.content[index] as TextContent).text += delta;
    this.textChars += delta.length;
    this.#stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.#output });
  }

  thinking(delta: string): void {
    if (!delta) return;
    const index = this.#open?.type === "thinking" ? this.#open.index : this.#begin("thinking");
    (this.#output.content[index] as ThinkingContent).thinking += delta;
    this.textChars += delta.length;
    this.#stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.#output });
  }

  /** A signature ends the current reasoning block. */
  thinkingSignature(signature: string): void {
    if (this.#open?.type !== "thinking") return;
    (this.#output.content[this.#open.index] as ThinkingContent).thinkingSignature = signature;
    this.close();
  }

  close(): void {
    const open = this.#open;
    if (!open) return;
    this.#open = null;
    const block = this.#output.content[open.index];
    if (open.type === "text") {
      this.#stream.push({ type: "text_end", contentIndex: open.index, content: (block as TextContent).text, partial: this.#output });
    } else {
      this.#stream.push({ type: "thinking_end", contentIndex: open.index, content: (block as ThinkingContent).thinking, partial: this.#output });
    }
  }

  toolCall(id: string, name: string, rawInput: string): void {
    this.close();
    const call: ToolCall = { type: "toolCall", id, name, arguments: {} };
    const text = rawInput.trim() === "" ? "{}" : rawInput;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      call.arguments = parsed as JsonObject;
    } catch {
      // Keep the call so the model sees why it failed, instead of silently dropping it.
      call.argumentsError = `Tool arguments were not a valid JSON object: ${redact(text.slice(0, 200))}`;
    }
    const index = this.#output.content.length;
    this.#output.content.push(call);
    this.emitted = true;
    this.toolCalls++;
    this.#stream.push({ type: "toolcall_start", contentIndex: index, partial: this.#output });
    this.#stream.push({ type: "toolcall_delta", contentIndex: index, delta: text, partial: this.#output });
    this.#stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: this.#output });
  }
}

interface AttemptResult {
  /** A failure that may be retried if nothing reached pi yet. */
  retryable?: KiroError;
  metadata: MetadataInfo;
  contextPercent?: number;
}

function streamErrorToKiroError(e: StreamErrorInfo): KiroError {
  const what = `${e.name}${e.reason ? ` ${e.reason}` : ""}`;
  const msg = e.message ? `: ${redact(e.message).slice(0, 300)}` : "";
  const init = { ...(e.reason ? { reason: e.reason } : {}), ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) };
  if (e.reason === "MONTHLY_REQUEST_COUNT") return new KiroError("quota", `Kiro monthly request quota exceeded (${what})${msg}`, init);
  if (e.reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD" || e.message?.includes("Input is too long")) {
    return new KiroError("tooLarge", `context_length_exceeded: Kiro rejected the request as too large (${what})${msg}`, init);
  }
  switch (e.kind) {
    case "throttling":
      return new KiroError("rate", `Kiro rate limit during the response stream (${what})${msg}`, init);
    case "serviceUnavailable":
      return new KiroError("server", `Kiro service unavailable during the response stream (${what})${msg}`, init);
    case "internalServer":
      return new KiroError("server", `Kiro internal error during the response stream (${what})${msg}`, init);
    case "validation":
      return new KiroError("invalidRequest", `Kiro rejected the request (${what})${msg}`, init);
    default:
      return new KiroError("server", `Kiro stream error (${what})${msg}`, init);
  }
}

const RETRYABLE_STREAM_KINDS = new Set(["rate", "server", "timeout"]);

export function createStreamKiro(resolveCatalog: ResolveCatalog, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  return function streamKiro(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error("Kiro API key is not set. Export KIRO_API_KEY (a ksk_ key) before starting pi.");
    const stream = createAssistantMessageEventStream();
    void run(model, context, options ?? {}, apiKey, stream, resolveCatalog, fetchImpl);
    return stream;
  };
}

async function run(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  apiKey: string,
  stream: AssistantMessageEventStream,
  resolveCatalog: ResolveCatalog,
  fetchImpl: typeof fetch,
): Promise<void> {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const signal = options.signal;
  let writer = new BlockWriter(output, stream);
  let started = false;

  try {
    const catalog = resolveCatalog();
    const info = catalog?.byPiId.get(model.id);
    if (!catalog || !info) {
      throw new KiroError("invalidRequest", `Model ${model.id} is not in this Kiro API key's model catalog`);
    }
    const level = model.reasoning ? options.reasoning : undefined;
    const plan = planReasoning(level, info.effort);
    if (plan.effort) output.providerThinkingLevel = plan.effort;
    const systemPrompt = [plan.directive, getCurrentSystemPrompt(context.messages)].filter(Boolean).join("\n");

    const conversation = buildConversation({
      messages: context.messages,
      modelId: info.kiroId,
      systemPrompt,
      tools: getCurrentTools(context.messages),
      contextWindow: model.contextWindow,
    });
    let payload: unknown = {
      conversationState: {
        chatTriggerType: "MANUAL",
        agentTaskType: "vibe",
        conversationId: options.sessionId || crypto.randomUUID(),
        currentMessage: { userInputMessage: conversation.current },
        ...(conversation.history.length > 0 ? { history: conversation.history } : {}),
      },
      agentMode: "vibe",
      profileArn: catalog.profileArn,
      ...(plan.additionalModelRequestFields ? { additionalModelRequestFields: plan.additionalModelRequestFields } : {}),
    } satisfies KiroChatRequest;
    const replaced = await options.onPayload?.(payload, model);
    if (replaced !== undefined) payload = replaced;
    const body = JSON.stringify(payload);
    const url = new URL("generateAssistantResponse", catalog.runtimeBaseUrl).toString();
    const splitThinking = level !== undefined;

    for (let attempt = 0; ; attempt++) {
      let result: AttemptResult;
      try {
        const response = await send(url, body, apiKey, model, options, fetchImpl);
        if (!started) {
          stream.push({ type: "start", partial: output });
          started = true;
        }
        result = await consume(response, model, options, writer, splitThinking);
      } catch (error) {
        if (error instanceof KiroError && error.kind === "timeout" && !writer.emitted && attempt + 1 < policy.maxAttempts) {
          await sleep(backoff(attempt), signal);
          continue;
        }
        throw error;
      }

      if (result.retryable) {
        const err = result.retryable;
        if (!writer.emitted && attempt + 1 < policy.maxAttempts && RETRYABLE_STREAM_KINDS.has(err.kind)) {
          const delay = err.retryAfterMs !== undefined ? Math.min(err.retryAfterMs, policy.maxBackoffMs) : backoff(attempt);
          await sleep(delay, signal);
          writer = new BlockWriter(output, stream);
          continue;
        }
        throw err;
      }

      const md = result.metadata;
      const explicit = md.stopReason;
      const empty = !writer.emitted && !explicit;
      if (empty && attempt + 1 < policy.maxAttempts) {
        await sleep(backoff(attempt), signal);
        continue;
      }

      if (explicit) output.rawStopReason = explicit;
      switch (explicit) {
        case "MODEL_CONTEXT_WINDOW_EXCEEDED":
          throw new KiroError("tooLarge", "context_length_exceeded: Kiro reported MODEL_CONTEXT_WINDOW_EXCEEDED");
        case "CONTENT_FILTERED":
          output.content = output.content.filter((b) => b.type !== "toolCall");
          throw new KiroError("contentFiltered", "Kiro filtered this response (CONTENT_FILTERED)");
        case "PAUSE_TURN":
          throw new KiroError("other", "Kiro paused the turn (PAUSE_TURN); continuing a paused turn is not supported");
        case "MAX_TOKENS":
          output.stopReason = "length";
          break;
        case "END_TURN":
          output.stopReason = "stop";
          output.endTurn = true;
          break;
        case "TOOL_USE":
          output.stopReason = writer.toolCalls > 0 ? "toolUse" : "stop";
          break;
        default:
          output.stopReason =
            writer.toolCalls > 0 ? "toolUse" : result.contextPercent !== undefined || md.contextUsagePercentage !== undefined ? "stop" : "length";
      }
      if (empty) throw new KiroError("other", `Kiro returned an empty response after ${attempt + 1} attempts`);

      applyUsage(output, model, md, result.contextPercent, writer.textChars);
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
      return;
    }
  } catch (error) {
    writer.close();
    const aborted = !!signal?.aborted;
    const reason: Extract<StopReason, "error" | "aborted"> = aborted ? "aborted" : "error";
    output.stopReason = reason;
    output.errorMessage = aborted
      ? "Request aborted"
      : redact(error instanceof Error ? error.message : String(error)) || "Unknown Kiro error";
    stream.push({ type: "error", reason, error: output });
    stream.end();
  }
}

/** POST the chat request, absorbing capacity and short-window rate rejections (§7.1). */
async function send(
  url: string,
  body: string,
  apiKey: string,
  model: Model<Api>,
  options: SimpleStreamOptions,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const extra: Record<string, string> = {};
  const removed = new Set<string>();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (PROTECTED_HEADERS.has(name.toLowerCase())) continue;
    if (value === null) removed.add(name.toLowerCase());
    else extra[name] = value;
  }
  let capacity = 0;
  let rate = 0;
  for (;;) {
    const headers: Record<string, string> = {
      ...baseHeaders(),
      "x-amzn-kiro-agent-mode": "vibe",
      ...extra,
      ...authHeaders(apiKey),
      "Content-Type": "application/json",
      Accept: "application/vnd.amazon.eventstream",
    };
    for (const name of Object.keys(headers)) if (removed.has(name.toLowerCase())) delete headers[name];
    const response = await fetchWithHeaderTimeout(
      fetchImpl,
      url,
      { method: "POST", headers, body },
      policy.headerTimeoutMs,
      options.signal,
      "GenerateAssistantResponse",
    );
    await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
    if (response.ok) return response;

    const text = await response.text().catch(() => "");
    const err = classifyHttpError(response.status, text, response.headers, "GenerateAssistantResponse");
    if (err.kind === "capacity" && capacity < policy.capacityRetries) {
      await sleep(Math.min(policy.capacityBaseMs * 2 ** capacity, policy.capacityMaxMs), options.signal);
      capacity++;
      continue;
    }
    if (err.kind === "rate" && rate < policy.rateRetries) {
      await sleep(Math.min(err.retryAfterMs ?? policy.rateFallbackMs, policy.maxBackoffMs), options.signal);
      rate++;
      continue;
    }
    if (err.kind === "capacity") {
      throw new KiroError("capacity", `${err.message} Gave up after ${capacity + 1} attempts.`, { status: err.status, reason: err.reason });
    }
    throw err;
  }
}

const TIMEOUT = Symbol("timeout");

async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Decode one response body into pi events. Never retries; reports what can be. */
async function consume(
  response: Response,
  model: Model<Api>,
  options: SimpleStreamOptions,
  writer: BlockWriter,
  splitThinking: boolean,
): Promise<AttemptResult> {
  if (!response.body) throw new KiroError("protocol", "Kiro returned a response without a body");
  const reader = response.body.getReader();
  const signal = options.signal;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  const decoder = new EventStreamDecoder();
  const splitter = splitThinking ? new InlineThinkingSplitter() : undefined;
  const result: AttemptResult = { metadata: {} };
  let tool: { id: string; name: string; input: string } | undefined;
  const flushTool = () => {
    if (tool) writer.toolCall(tool.id, tool.name, tool.input);
    tool = undefined;
  };
  const emitText = (text: string) => {
    if (!splitter) return writer.text(text);
    for (const seg of splitter.feed(text)) seg.thinking ? writer.thinking(seg.text) : writer.text(seg.text);
  };

  let first = true;
  try {
    for (;;) {
      const read = await readWithin(reader, first ? policy.firstEventTimeoutMs : policy.idleTimeoutMs);
      if (read === TIMEOUT) {
        void reader.cancel().catch(() => {});
        const ms = first ? policy.firstEventTimeoutMs : policy.idleTimeoutMs;
        result.retryable = new KiroError("timeout", `Kiro stream timed out after ${ms} ms without ${first ? "a first event" : "new events"}`);
        return result;
      }
      if (read.done) break;
      first = false;
      for (const frame of decoder.push(read.value)) {
        const event: KiroEvent = decodeEvent(frame);
        await options.onProviderStreamEvent?.(event, model);
        switch (event.kind) {
          case "text":
            emitText(event.text);
            break;
          case "reasoning":
            if (event.text) writer.thinking(event.text);
            if (event.signature !== undefined) writer.thinkingSignature(event.signature);
            break;
          case "toolUse": {
            if (event.toolUseId && event.toolUseId !== tool?.id) {
              flushTool();
              tool = { id: event.toolUseId, name: event.name ?? "", input: "" };
            }
            if (tool) tool.input += event.input;
            if (event.stop) flushTool();
            break;
          }
          case "contextUsage":
            result.contextPercent = event.percent;
            break;
          case "metadata":
            Object.assign(result.metadata, event.data);
            break;
          case "error":
            result.retryable = streamErrorToKiroError(event.error);
            void reader.cancel().catch(() => {});
            return result;
          case "metering":
          case "ignored":
            break;
        }
      }
    }
    if (signal?.aborted) throw signal.reason;
    decoder.finish();
    flushTool();
    if (splitter) for (const seg of splitter.flush()) seg.thinking ? writer.thinking(seg.text) : writer.text(seg.text);
    writer.close();
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function applyUsage(
  output: AssistantMessage,
  model: Model<Api>,
  md: MetadataInfo,
  contextPercent: number | undefined,
  outputChars: number,
): void {
  const pct = md.contextUsagePercentage ?? contextPercent;
  const usage = output.usage;
  usage.input = md.uncachedInputTokens ?? (pct !== undefined ? Math.round((pct / 100) * model.contextWindow) : 0);
  usage.cacheRead = md.cacheReadInputTokens ?? 0;
  usage.cacheWrite = md.cacheWriteInputTokens ?? 0;
  // Without a metadataEvent, ~4 characters per token is the only estimate available.
  usage.output = md.outputTokens ?? Math.ceil(outputChars / 4);
  usage.totalTokens = md.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  usage.cost = calculateCost(model, usage);
}

