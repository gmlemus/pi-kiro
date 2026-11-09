// Typed Kiro stream events (PROTOCOL.md §5). Frames are routed on their
// `:message-type` / `:event-type` / `:exception-type` headers, never by
// guessing from which JSON fields happen to be present.

import { EventStreamError, type EventStreamMessage } from "./eventstream.ts";

export type StreamErrorKind = "internalServer" | "throttling" | "validation" | "serviceUnavailable" | "unknown";

export interface StreamErrorInfo {
  kind: StreamErrorKind;
  name: string;
  message?: string;
  reason?: string;
  retryAfterMs?: number;
}

export interface MetadataInfo {
  uncachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  contextUsagePercentage?: number;
  stopReason?: string;
  stopDetails?: Record<string, unknown>;
}

export type KiroEvent =
  | { kind: "text"; text: string }
  | { kind: "toolUse"; toolUseId?: string; name?: string; input: string; stop: boolean }
  | { kind: "reasoning"; text?: string; signature?: string; redacted: boolean }
  | { kind: "contextUsage"; percent: number }
  | { kind: "metadata"; data: MetadataInfo }
  | { kind: "metering"; credits?: number }
  | { kind: "error"; error: StreamErrorInfo }
  | { kind: "ignored"; eventType: string };

// Both the union member name and the exception class name occur on the wire.
const ERROR_TOKENS = new Map<string, StreamErrorKind>([
  ["error", "internalServer"],
  ["InternalServerException", "internalServer"],
  ["throttlingError", "throttling"],
  ["ThrottlingException", "throttling"],
  ["validationError", "validation"],
  ["ValidationException", "validation"],
  ["serviceUnavailableError", "serviceUnavailable"],
  ["ServiceUnavailableException", "serviceUnavailable"],
]);

const IGNORED_EVENTS = new Set(["codeReferenceEvent", "documentCitationEvent", "toolResultEvent", "followupPrompt"]);

const utf8 = new TextDecoder("utf-8", { fatal: true });

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function header(msg: EventStreamMessage, name: string): string | undefined {
  const v = msg.headers[name];
  return typeof v === "string" ? v : undefined;
}

function parseJsonObject(payload: Uint8Array, strict: boolean): Record<string, unknown> {
  if (payload.length === 0) return {};
  try {
    const value = JSON.parse(utf8.decode(payload)) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // handled below
  }
  if (strict) throw new EventStreamError("event payload is not a JSON object");
  return {};
}

function errorInfo(token: string, body: Record<string, unknown>, fallbackMessage?: string): StreamErrorInfo {
  const info: StreamErrorInfo = { kind: ERROR_TOKENS.get(token) ?? "unknown", name: token };
  const message = str(body.message) ?? str(body.Message) ?? fallbackMessage;
  if (message !== undefined) info.message = message;
  const reason = str(body.reason);
  if (reason !== undefined) info.reason = reason;
  const retry = num(body.retryAfterMilliseconds);
  if (retry !== undefined) info.retryAfterMs = retry;
  return info;
}

function toolInput(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && Object.keys(raw).length > 0) return JSON.stringify(raw);
  return "";
}

function metadata(body: Record<string, unknown>): MetadataInfo {
  const tu = (body.tokenUsage && typeof body.tokenUsage === "object" ? body.tokenUsage : {}) as Record<string, unknown>;
  const data: MetadataInfo = {};
  const set = <K extends keyof MetadataInfo>(k: K, v: MetadataInfo[K] | undefined) => {
    if (v !== undefined) data[k] = v;
  };
  set("uncachedInputTokens", num(tu.uncachedInputTokens));
  set("outputTokens", num(tu.outputTokens));
  set("totalTokens", num(tu.totalTokens));
  set("cacheReadInputTokens", num(tu.cacheReadInputTokens));
  set("cacheWriteInputTokens", num(tu.cacheWriteInputTokens));
  set("contextUsagePercentage", num(tu.contextUsagePercentage));
  set("stopReason", str(body.stopReason));
  if (body.stopDetails && typeof body.stopDetails === "object") {
    data.stopDetails = body.stopDetails as Record<string, unknown>;
  }
  return data;
}

/** Map one decoded frame to a typed event. Throws EventStreamError on a frame we cannot interpret safely. */
export function decodeEvent(msg: EventStreamMessage): KiroEvent {
  const messageType = header(msg, ":message-type") ?? "event";

  if (messageType === "exception") {
    const token = header(msg, ":exception-type") ?? "unknown";
    // The class lives in the header, so classify even when the body is unreadable.
    return { kind: "error", error: errorInfo(token, parseJsonObject(msg.payload, false)) };
  }
  if (messageType === "error") {
    const code = header(msg, ":error-code") ?? "unknown";
    return { kind: "error", error: errorInfo(code, {}, header(msg, ":error-message")) };
  }
  if (messageType !== "event") throw new EventStreamError(`unknown :message-type ${messageType}`);

  const eventType = header(msg, ":event-type");
  if (!eventType) throw new EventStreamError("event frame without :event-type");
  if (ERROR_TOKENS.has(eventType)) {
    return { kind: "error", error: errorInfo(eventType, parseJsonObject(msg.payload, false)) };
  }

  switch (eventType) {
    case "assistantResponseEvent": {
      const body = parseJsonObject(msg.payload, true);
      return { kind: "text", text: str(body.content) ?? "" };
    }
    case "toolUseEvent": {
      const body = parseJsonObject(msg.payload, true);
      const ev: KiroEvent = { kind: "toolUse", input: toolInput(body.input), stop: body.stop === true };
      const id = str(body.toolUseId);
      const name = str(body.name);
      if (id !== undefined) ev.toolUseId = id;
      if (name !== undefined) ev.name = name;
      return ev;
    }
    case "reasoningContentEvent": {
      const body = parseJsonObject(msg.payload, true);
      const ev: KiroEvent = { kind: "reasoning", redacted: body.redactedContent !== undefined };
      const text = str(body.text);
      const signature = str(body.signature);
      if (text !== undefined) ev.text = text;
      if (signature !== undefined) ev.signature = signature;
      return ev;
    }
    case "contextUsageEvent": {
      const pct = num(parseJsonObject(msg.payload, true).contextUsagePercentage);
      return pct === undefined ? { kind: "ignored", eventType } : { kind: "contextUsage", percent: pct };
    }
    case "metadataEvent":
      return { kind: "metadata", data: metadata(parseJsonObject(msg.payload, true)) };
    case "meteringEvent": {
      // `usage` here is a count of CREDITS, never tokens.
      const credits = num(parseJsonObject(msg.payload, true).usage);
      return credits === undefined ? { kind: "metering" } : { kind: "metering", credits };
    }
    default:
      // Known-but-unused members and anything added server-side later.
      return { kind: "ignored", eventType: IGNORED_EVENTS.has(eventType) ? eventType : `unknown:${eventType}` };
  }
}
