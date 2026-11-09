import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildCatalog, type Catalog } from "../src/catalog.ts";
import { encodeMessage } from "../src/eventstream.ts";

export const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST";
export const API_KEY = "ksk_test_secret_value_123";

export function event(type: string, body: unknown): Uint8Array {
  return encodeMessage(
    { ":message-type": "event", ":event-type": type, ":content-type": "application/json" },
    JSON.stringify(body),
  );
}

export function exception(type: string, body: unknown): Uint8Array {
  return encodeMessage(
    { ":message-type": "exception", ":exception-type": type, ":content-type": "application/json" },
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A streaming body that yields `bytes` in chunks of `chunkSize`, optionally pausing. */
export function bodyStream(bytes: Uint8Array, chunkSize = 7, opts: { hangAfter?: number } = {}): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (opts.hangAfter !== undefined && offset >= opts.hangAfter) return new Promise(() => {});
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

export function streamResponse(frames: Uint8Array[], opts: { chunkSize?: number; hangAfter?: number } = {}): Response {
  return new Response(bodyStream(concat(frames), opts.chunkSize, opts), {
    status: 200,
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

export interface Call {
  url: string;
  init: RequestInit;
}

/** fetch double that answers each call with the next queued responder. */
export function fakeFetch(responders: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const next = responders.shift();
    if (!next) throw new Error(`unexpected fetch ${call.url}`);
    if (init.signal?.aborted) throw init.signal.reason;
    return next(call);
  }) as typeof fetch;
  return { impl, calls };
}

export function testCatalog(schema?: unknown): Catalog {
  return buildCatalog(PROFILE_ARN, [
    {
      modelId: "claude-sonnet-4.6",
      modelName: "Claude Sonnet 4.6",
      supportedInputTypes: ["TEXT", "IMAGE"],
      tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
      ...(schema ? { additionalModelRequestFieldsSchema: schema } : {}),
    },
  ]);
}

export async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

export function headerOf(call: Call, name: string): string | undefined {
  const h = call.init.headers as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}
