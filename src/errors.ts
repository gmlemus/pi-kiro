// Error classification for Kiro responses (PROTOCOL.md §7).
//
// Messages are worded for pi's own classifiers, which read only the text:
//  - context overflow must contain `context_length_exceeded` so pi compacts;
//  - hard quota must contain `quota exceeded` so pi does not retry;
//  - errors pi should NOT retry must not contain a bare 429/5xx status or
//    words like "rate limit" / "unavailable", and errors pi SHOULD retry must.
// The status and reason code are kept as typed fields alongside the text.

export type KiroErrorKind =
  | "auth"
  | "quota"
  | "capacity"
  | "rate"
  | "tooLarge"
  | "invalidRequest"
  | "server"
  | "timeout"
  | "protocol"
  | "contentFiltered"
  | "other";

export interface KiroErrorInit {
  status?: number;
  reason?: string;
  retryAfterMs?: number;
}

export class KiroError extends Error {
  readonly kind: KiroErrorKind;
  readonly status: number | undefined;
  readonly reason: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: KiroErrorKind, message: string, init: KiroErrorInit = {}) {
    super(message);
    this.name = "KiroError";
    this.kind = kind;
    this.status = init.status;
    this.reason = init.reason;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export const REASON = {
  REQUEST_BODY_INVALID: "REQUEST_BODY_INVALID",
  TOOL_USE_RESULT_MISMATCH: "TOOL_USE_RESULT_MISMATCH",
  CONTENT_LENGTH_EXCEEDS_THRESHOLD: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
  MONTHLY_REQUEST_COUNT: "MONTHLY_REQUEST_COUNT",
  INSUFFICIENT_MODEL_CAPACITY: "INSUFFICIENT_MODEL_CAPACITY",
  USER_REQUEST_RATE_EXCEEDED: "USER_REQUEST_RATE_EXCEEDED",
} as const;

const KNOWN_REASONS: readonly string[] = Object.values(REASON);
const INPUT_TOO_LONG = "Input is too long";
const MAX_DETAIL_CHARS = 300;

/** Remove anything that looks like a credential before text leaves this module. */
export function redact(text: string): string {
  return text
    .replace(/ksk_[A-Za-z0-9_\-.]+/g, "ksk_[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9_\-.~+/=]+/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]");
}

function detail(text: string | undefined): string {
  if (!text) return "";
  const oneLine = redact(text).replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL_CHARS ? `${oneLine.slice(0, MAX_DETAIL_CHARS)}…` : oneLine;
}

interface ParsedBody {
  reason?: string;
  message?: string;
  type?: string;
}

/** Parse `{"message","reason"}` (and AWS `__type`) out of an error body; fall back to a marker scan. */
export function parseErrorBody(body: string): ParsedBody {
  const out: ParsedBody = {};
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const reason = json.reason ?? json.reasonCode;
      if (typeof reason === "string" && reason) out.reason = reason;
      const message = json.message ?? json.Message;
      if (typeof message === "string") out.message = message;
      if (typeof json.__type === "string") out.type = json.__type.split("#").pop();
    } catch {
      // fall through to the marker scan
    }
  }
  if (!out.reason) out.reason = KNOWN_REASONS.find((r) => body.includes(r));
  return out;
}

/**
 * Read a server-advertised wait. `retry-after-ms` is milliseconds; numeric
 * `retry-after` and `x-ratelimit-reset-after` are seconds; a date-form
 * `retry-after` is relative to now.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const num = (v: string | null) => {
    if (v === null || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const ms = num(headers.get("retry-after-ms"));
  if (ms !== undefined) return Math.round(ms);
  const ra = headers.get("retry-after");
  if (ra !== null && ra.trim() !== "") {
    if (Number.isFinite(Number(ra))) {
      // Numeric means delay-seconds; never let Date.parse read "-3" as a year.
      const secs = num(ra);
      if (secs !== undefined) return Math.round(secs * 1000);
    } else {
      const date = Date.parse(ra);
      if (!Number.isNaN(date)) return Math.max(0, date - now);
    }
  }
  const reset = num(headers.get("x-ratelimit-reset-after"));
  return reset === undefined ? undefined : Math.round(reset * 1000);
}

/** Classify a non-2xx HTTP response (PROTOCOL.md §7.1). */
export function classifyHttpError(status: number, body: string, headers: Headers, operation: string): KiroError {
  const parsed = parseErrorBody(body);
  const reason = parsed.reason;
  const info = detail(parsed.message ?? body);
  const init: KiroErrorInit = { status, reason, retryAfterMs: retryAfterMs(headers) };
  const tag = reason ? ` (${reason})` : "";

  if (reason === REASON.MONTHLY_REQUEST_COUNT) {
    return new KiroError("quota", `Kiro monthly request quota exceeded${tag}. ${info}`.trim(), init);
  }
  if (reason === REASON.INSUFFICIENT_MODEL_CAPACITY) {
    return new KiroError("capacity", `Kiro has no capacity for this model right now${tag}.`, init);
  }
  if (reason === REASON.USER_REQUEST_RATE_EXCEEDED || (status === 429 && !reason)) {
    return new KiroError("rate", `Kiro rate limit hit (HTTP ${status})${tag}. ${info}`.trim(), init);
  }
  if (status === 413 || reason === REASON.CONTENT_LENGTH_EXCEEDS_THRESHOLD || body.includes(INPUT_TOO_LONG)) {
    return new KiroError(
      "tooLarge",
      `context_length_exceeded: Kiro rejected the request as too large${tag}. ${info}`.trim(),
      init,
    );
  }
  // Observed live: a bad key on GetProfile is HTTP 400 AccessDeniedException "Invalid token".
  const authType = parsed.type === "AccessDeniedException" || parsed.type === "UnrecognizedClientException";
  if (status === 401 || status === 403 || authType || /invalid token/i.test(parsed.message ?? "")) {
    return new KiroError(
      "auth",
      `Kiro rejected the API key during ${operation} (HTTP ${status}${parsed.type ? ` ${parsed.type}` : ""}). ` +
        "Check that KIRO_API_KEY is valid, not expired, and issued for this region. " +
        info,
      init,
    );
  }
  if (status >= 500) {
    return new KiroError("server", `Kiro server error during ${operation} (HTTP ${status})${tag}. ${info}`.trim(), init);
  }
  if (status === 400) {
    // REQUEST_BODY_INVALID ("Improperly formed request."), TOOL_USE_RESULT_MISMATCH,
    // ValidationException: a bug in the request we built. Deliberately NOT a
    // context overflow (PROTOCOL.md conflict C3) and not retryable.
    return new KiroError(
      "invalidRequest",
      `Kiro rejected the ${operation} request as malformed (HTTP 400${reason ? ` ${reason}` : ""}${parsed.type ? ` ${parsed.type}` : ""}). ${info}`.trim(),
      init,
    );
  }
  return new KiroError("other", `Kiro ${operation} failed (HTTP ${status})${tag}. ${info}`.trim(), init);
}
