// Profile resolution and model discovery (PROTOCOL.md §2.1). Discovery is
// fail-closed: models are scoped to the key's entitlements, so a fallback
// list would advertise models this key cannot use.

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { deriveEffortConfig, type EffortConfig } from "./effort.ts";
import { KiroError } from "./errors.ts";
import {
  authHeaders,
  baseHeaders,
  fetchWithHeaderTimeout,
  isRegion,
  KEY_REGIONS,
  managementBase,
  readJson,
  regionFromArn,
  runtimeBase,
} from "./http.ts";
import { ORIGIN } from "./wire.ts";

export const API = "kiro-runtime";

export type ChatModelConfig = Exclude<ProviderModelConfig, { type: "image" } | { type: "classifier" }>;
const DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;

interface CatalogModel {
  modelId?: unknown;
  modelName?: unknown;
  supportedInputTypes?: unknown;
  tokenLimits?: { maxInputTokens?: unknown; maxOutputTokens?: unknown } | null;
  additionalModelRequestFieldsSchema?: unknown;
}

/** Kiro details carried on each pi model, so a cached catalog is self-contained. */
export interface KiroMeta {
  /** Kiro's own model ID (dot form), sent on the wire. */
  id: string;
  /** Region of the profile ARN; the runtime host lives there (§2.1, I10). */
  region: string;
  effort?: EffortConfig;
}

export type KiroModelConfig = ChatModelConfig & { kiro: KiroMeta };

/** Kiro's dot-form version (`4.6`) becomes pi's dash form (`4-6`). */
export function toPiId(kiroId: string): string {
  return kiroId.replace(/(\d)\.(?=\d)/g, "$1-");
}

const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

async function getProfileArnIn(
  region: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchWithHeaderTimeout(
    fetchImpl,
    managementBase(region),
    {
      method: "POST",
      headers: {
        ...baseHeaders(),
        ...authHeaders(apiKey),
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.GetProfile",
      },
      body: "{}",
    },
    DISCOVERY_TIMEOUT_MS,
    signal,
    "GetProfile",
  );
  const data = await readJson<{ profile?: { arn?: unknown } }>(response, "GetProfile");
  const arn = data.profile?.arn;
  if (typeof arn !== "string" || !regionFromArn(arn)) {
    throw new KiroError("protocol", "Kiro GetProfile returned no usable profile ARN for this API key");
  }
  return arn;
}

/**
 * API keys are region-scoped: the wrong region answers 400 AccessDeniedException
 * "Invalid token" (observed live, PROTOCOL.md §2.1). Try each region in turn and
 * move on only for that rejection; any other failure is reported as-is.
 */
export async function getProfileArn(
  apiKey: string,
  fetchImpl: typeof fetch,
  regions: readonly string[] = KEY_REGIONS,
  signal?: AbortSignal,
): Promise<string> {
  let rejection: KiroError | undefined;
  for (const region of regions) {
    try {
      return await getProfileArnIn(region, apiKey, fetchImpl, signal);
    } catch (error) {
      if (!(error instanceof KiroError) || error.kind !== "auth") throw error;
      rejection = error;
    }
  }
  throw new KiroError(
    "auth",
    `Kiro rejected the API key in every region tried (${regions.join(", ")}). ` +
      "Check that the Kiro API key is valid and not revoked.",
    { status: rejection?.status, reason: rejection?.reason },
  );
}

/** Regions to try for GetProfile: an explicit KIRO_REGION first, then the known Kiro regions. */
export function keyRegions(preferred?: string): string[] {
  const p = preferred?.trim().toLowerCase();
  if (p && !isRegion(p)) throw new KiroError("other", `KIRO_REGION "${preferred}" is not a valid AWS region code`);
  return [...new Set([...(p ? [p] : []), ...KEY_REGIONS])];
}

export async function listModels(
  apiKey: string,
  profileArn: string,
  region: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<CatalogModel[]> {
  const url = new URL("List-Available-Models", managementBase(region));
  url.searchParams.set("origin", ORIGIN);
  url.searchParams.set("profileArn", profileArn);
  const response = await fetchWithHeaderTimeout(
    fetchImpl,
    url.toString(),
    { method: "GET", headers: { ...baseHeaders(), ...authHeaders(apiKey), Accept: "application/json" } },
    DISCOVERY_TIMEOUT_MS,
    signal,
    "ListAvailableModels",
  );
  const data = await readJson<{ models?: unknown }>(response, "ListAvailableModels");
  if (!Array.isArray(data.models) || data.models.length === 0) {
    throw new KiroError(
      "protocol",
      "Kiro ListAvailableModels returned no models for this API key; the key may lack model entitlements",
    );
  }
  return data.models as CatalogModel[];
}

export function buildModels(region: string, raw: CatalogModel[]): KiroModelConfig[] {
  const models: KiroModelConfig[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    if (typeof m.modelId !== "string" || !MODEL_ID.test(m.modelId)) continue;
    const id = toPiId(m.modelId);
    if (seen.has(id)) continue;
    seen.add(id);
    const effort = deriveEffortConfig(m.additionalModelRequestFieldsSchema);
    const types = Array.isArray(m.supportedInputTypes) ? m.supportedInputTypes : [];
    const vision = types.some((t) => typeof t === "string" && t.toUpperCase() === "IMAGE");
    models.push(
      toModelConfig({
        id,
        name: typeof m.modelName === "string" && m.modelName ? m.modelName : m.modelId,
        vision,
        contextWindow: posInt(m.tokenLimits?.maxInputTokens) ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: posInt(m.tokenLimits?.maxOutputTokens) ?? DEFAULT_MAX_TOKENS,
        kiro: effort ? { id: m.modelId, region, effort } : { id: m.modelId, region },
      }),
    );
  }
  if (models.length === 0) throw new KiroError("protocol", "Kiro ListAvailableModels returned no valid model IDs");
  return models;
}

const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface ModelFacts {
  id: string;
  name: string;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  kiro: KiroMeta;
}

/** Every derived field (host, API, cost, thinking map) is computed here, never taken from storage. */
function toModelConfig(f: ModelFacts): KiroModelConfig {
  const thinkingLevelMap: Record<string, string> = {};
  if (f.kiro.effort?.values.includes("xhigh")) thinkingLevelMap.xhigh = "xhigh";
  if (f.kiro.effort?.values.includes("max")) thinkingLevelMap.max = "max";
  return {
    id: f.id,
    name: f.name,
    api: API,
    baseUrl: runtimeBase(f.kiro.region),
    // No capability flag is published; the thinking directive is harmless where unsupported.
    reasoning: true,
    ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
    input: f.vision ? ["text", "image"] : ["text"],
    // Kiro bills credits, not per-token USD.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: f.contextWindow,
    maxTokens: f.maxTokens,
    kiro: f.kiro,
  };
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Validate the Kiro details on a model, whether built here or read back from pi's model store. */
export function kiroMeta(model: unknown): KiroMeta | undefined {
  const k = rec(rec(model)?.kiro);
  if (!k || typeof k.id !== "string" || !MODEL_ID.test(k.id)) return undefined;
  if (typeof k.region !== "string" || !isRegion(k.region)) return undefined;
  const e = rec(k.effort);
  const values = Array.isArray(e?.values) ? e.values.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  if (e && (e.field === "reasoning" || e.field === "output_config") && values.length > 0) {
    return { id: k.id, region: k.region, effort: { field: e.field, values, summarizedThinking: e.summarizedThinking === true } };
  }
  return { id: k.id, region: k.region };
}

/**
 * Rebuild models from a stored snapshot. Only plain facts are read back; the
 * runtime host, API and pricing are recomputed, so an edited store cannot point
 * requests (and the API key) at another host.
 */
export function restoreModels(stored: readonly unknown[] | undefined): KiroModelConfig[] {
  const out: KiroModelConfig[] = [];
  const seen = new Set<string>();
  for (const s of stored ?? []) {
    const m = rec(s);
    const kiro = kiroMeta(m);
    if (!m || !kiro || m.api !== API) continue;
    const id = toPiId(kiro.id);
    if (m.id !== id || seen.has(id)) continue;
    seen.add(id);
    const input = Array.isArray(m.input) ? m.input : [];
    out.push(
      toModelConfig({
        id,
        name: typeof m.name === "string" && m.name ? m.name : kiro.id,
        vision: input.includes("image"),
        contextWindow: posInt(m.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: posInt(m.maxTokens) ?? DEFAULT_MAX_TOKENS,
        kiro,
      }),
    );
  }
  return out;
}

export interface Discovery {
  profileArn: string;
  models: KiroModelConfig[];
}

export async function discoverModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  regions: readonly string[] = KEY_REGIONS,
  signal?: AbortSignal,
): Promise<Discovery> {
  const profileArn = await getProfileArn(apiKey, fetchImpl, regions, signal);
  // Catalog and runtime both live in the profile's own region (§2.1, I10).
  const region = regionFromArn(profileArn) as string;
  return { profileArn, models: buildModels(region, await listModels(apiKey, profileArn, region, fetchImpl, signal)) };
}

export type ResolveProfile = (apiKey: string, regionHint?: string, signal?: AbortSignal) => Promise<string>;

export interface ProfileResolver {
  get: ResolveProfile;
  /** Remember an ARN found by discovery so the first chat skips a GetProfile round trip. */
  seed(apiKey: string, profileArn: string): void;
}

/**
 * The profile ARN contains the AWS account ID, so it is never written to pi's
 * model store; it is looked up once per process and key, and kept in memory.
 */
export function createProfileResolver(fetchImpl: typeof fetch = fetch, preferredRegion?: () => string | undefined): ProfileResolver {
  const cache = new Map<string, Promise<string>>();
  return {
    get(apiKey, regionHint, signal) {
      let pending = cache.get(apiKey);
      if (!pending) {
        pending = (async () => {
          const regions = keyRegions(preferredRegion?.());
          const ordered = regionHint && isRegion(regionHint) ? [...new Set([regionHint, ...regions])] : regions;
          return getProfileArn(apiKey, fetchImpl, ordered, signal);
        })();
        cache.set(apiKey, pending);
        // A failed lookup (offline, aborted, revoked) must not stick for the process lifetime.
        pending.catch(() => cache.delete(apiKey));
      }
      return pending;
    },
    seed(apiKey, profileArn) {
      cache.set(apiKey, Promise.resolve(profileArn));
    },
  };
}
