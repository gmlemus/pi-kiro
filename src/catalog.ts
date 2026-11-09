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

export interface ModelInfo {
  kiroId: string;
  effort?: EffortConfig;
}

export interface Catalog {
  profileArn: string;
  region: string;
  runtimeBaseUrl: string;
  models: ChatModelConfig[];
  /** pi model id -> Kiro details. */
  byPiId: Map<string, ModelInfo>;
}

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
      "Check that KIRO_API_KEY is valid and not revoked.",
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

export function buildCatalog(profileArn: string, raw: CatalogModel[]): Catalog {
  const region = regionFromArn(profileArn) as string;
  const runtimeBaseUrl = runtimeBase(region);
  const models: ChatModelConfig[] = [];
  const byPiId = new Map<string, ModelInfo>();
  for (const m of raw) {
    if (typeof m.modelId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(m.modelId)) continue;
    const id = toPiId(m.modelId);
    if (byPiId.has(id)) continue;
    const effort = deriveEffortConfig(m.additionalModelRequestFieldsSchema);
    const types = Array.isArray(m.supportedInputTypes) ? m.supportedInputTypes : [];
    const vision = types.some((t) => typeof t === "string" && t.toUpperCase() === "IMAGE");
    const thinkingLevelMap: Record<string, string> = {};
    if (effort?.values.includes("xhigh")) thinkingLevelMap.xhigh = "xhigh";
    if (effort?.values.includes("max")) thinkingLevelMap.max = "max";
    models.push({
      id,
      name: typeof m.modelName === "string" && m.modelName ? m.modelName : m.modelId,
      api: API,
      baseUrl: runtimeBaseUrl,
      // No capability flag is published; the thinking directive is harmless where unsupported.
      reasoning: true,
      ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
      input: vision ? ["text", "image"] : ["text"],
      // Kiro bills credits, not per-token USD.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: posInt(m.tokenLimits?.maxInputTokens) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: posInt(m.tokenLimits?.maxOutputTokens) ?? DEFAULT_MAX_TOKENS,
    });
    byPiId.set(id, effort ? { kiroId: m.modelId, effort } : { kiroId: m.modelId });
  }
  if (models.length === 0) throw new KiroError("protocol", "Kiro ListAvailableModels returned no valid model IDs");
  return { profileArn, region, runtimeBaseUrl, models, byPiId };
}

export async function discoverCatalog(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  regions: readonly string[] = KEY_REGIONS,
): Promise<Catalog> {
  const profileArn = await getProfileArn(apiKey, fetchImpl, regions);
  // Catalog and runtime both live in the profile's own region (§2.1, I10).
  const region = regionFromArn(profileArn) as string;
  return buildCatalog(profileArn, await listModels(apiKey, profileArn, region, fetchImpl));
}
