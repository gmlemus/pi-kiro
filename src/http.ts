// Shared HTTP plumbing: endpoints, headers, and bounded waits.

import { classifyHttpError, KiroError } from "./errors.ts";

/** Kiro regions an API key can belong to, in the order they are tried. */
export const KEY_REGIONS = ["us-east-1", "eu-central-1"] as const;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

export function isRegion(value: string): boolean {
  return REGION.test(value);
}

export const VERSION = "0.1.0";
/** Honest User-Agent. PROTOCOL.md §1: whether Kiro checks it is unverified. */
export const USER_AGENT = `pi-kiro-secure/${VERSION}`;

export function managementBase(region: string): string {
  return `https://management.${region}.kiro.dev/`;
}

export function runtimeBase(region: string): string {
  return `https://runtime.${region}.kiro.dev/`;
}

/** The region field of an ARN, validated so it can safely become a hostname label. */
export function regionFromArn(arn: string): string | undefined {
  const region = arn.split(":")[3]?.trim().toLowerCase();
  return region && isRegion(region) ? region : undefined;
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, tokentype: "API_KEY" };
}

export function baseHeaders(): Record<string, string> {
  return {
    "user-agent": USER_AGENT,
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": "attempt=1; max=1",
  };
}

/** Promise that rejects when `signal` aborts, for racing against waits. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * fetch with a deadline on the response headers only. The caller's signal
 * still aborts everything; the deadline is cleared once headers arrive, so it
 * never cuts off a long streaming body.
 */
export async function fetchWithHeaderTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("header timeout"));
  }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      throw new KiroError("timeout", `Kiro ${operation} timed out after ${timeoutMs} ms waiting for response headers`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    // Leave the caller-abort link in place: it must still cancel the body.
  }
}

/** Read a JSON management response, classifying non-2xx answers. */
export async function readJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw classifyHttpError(response.status, body, response.headers, operation);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new KiroError("protocol", `Kiro ${operation} returned invalid JSON`);
  }
}
