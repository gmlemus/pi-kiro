// pi extension entry: register the Kiro provider and its model catalog.
//
// The key is resolved by pi, so it can live anywhere pi can read it: an
// `auth.json` entry (a literal from /login, or a `!command` that prints it from
// any OS secret store) or the KIRO_API_KEY environment variable. The model list
// is kept in pi's model store, so every pi process (subagents, scripts, other
// apps) lists the models at startup without a network call.
//
// This extension must never stop pi from starting. Without a key pi simply
// shows no Kiro models; with a key that cannot be used, it warns once.

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  API,
  createProfileResolver,
  type Discovery,
  discoverModels,
  keyRegions,
  type ProfileResolver,
  restoreModels,
} from "./catalog.ts";
import { redact } from "./errors.ts";
import { KEY_REGIONS, regionFromArn, runtimeBase } from "./http.ts";
import { createStreamKiro } from "./stream.ts";
import { fetchUsage, formatUsage } from "./usage.ts";

export const PROVIDER_ID = "kiro-secure";

export type Discover = (apiKey: string, regions: string[], signal?: AbortSignal) => Promise<Discovery>;
export type Usage = (apiKey: string, profile: { profileArn: string; region: string }) => ReturnType<typeof fetchUsage>;

export interface Deps {
  discover?: Discover;
  usage?: Usage;
  profiles?: ProfileResolver;
  /** Environment to read KIRO_API_KEY, KIRO_REGION and PI_OFFLINE from. */
  env?: NodeJS.ProcessEnv;
}

/** Key from pi's credential (auth.json, including `!command` keys), else the environment. */
function keyFrom(context: Pick<RefreshModelsContext, "credential">, env: NodeJS.ProcessEnv): string | undefined {
  const c = context.credential;
  const fromPi = c?.type === "api_key" ? c.key?.trim() : undefined;
  return fromPi || env.KIRO_API_KEY?.trim() || undefined;
}

export function createExtension(deps: Deps = {}) {
  const env = deps.env ?? process.env;
  const discover: Discover = deps.discover ?? ((key, regions, signal) => discoverModels(key, fetch, regions, signal));
  const usage: Usage = deps.usage ?? ((key, profile) => fetchUsage(key, profile));
  const profiles = deps.profiles ?? createProfileResolver(fetch, () => env.KIRO_REGION);

  return function registerKiro(pi: ExtensionAPI): void {
    let problem: string | undefined;
    // Concurrent refreshes in one process share a single discovery.
    let inFlight: { key: string; promise: Promise<Discovery> } | undefined;

    async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
      const stored = restoreModels(context.stored?.models);
      const apiKey = keyFrom(context, env);
      if (!apiKey) return stored;
      if (!apiKey.startsWith("ksk_")) {
        problem = "The Kiro API key does not look like a Kiro API key (expected a ksk_ prefix).";
        return stored;
      }
      // pi starts cache-only; fetch then only to fill an empty store, unless offline.
      const network = context.allowNetwork || context.force === true || (stored.length === 0 && env.PI_OFFLINE === undefined);
      if (!network) return stored;
      try {
        if (inFlight?.key !== apiKey) {
          const promise = discover(apiKey, keyRegions(env.KIRO_REGION), context.signal);
          inFlight = { key: apiKey, promise };
          promise.finally(() => {
            if (inFlight?.promise === promise) inFlight = undefined;
          }).catch(() => {});
        }
        const found = await inFlight.promise;
        profiles.seed(apiKey, found.profileArn);
        // Only model facts are stored: never the key, never the profile ARN (it holds the account ID).
        const models = found.models as unknown as ModelsStoreEntry["models"];
        await context.publish({ persist: { models, checkedAt: Date.now() } });
        problem = undefined;
        return found.models;
      } catch (error) {
        // Fail closed on new models, not on pi: keep what was stored, or list nothing.
        problem = `Model discovery failed: ${error instanceof Error ? error.message : String(error)}`;
        return stored;
      }
    }

    pi.registerProvider(PROVIDER_ID, {
      name: "Kiro (API key)",
      // Each model carries the runtime host of its own region.
      baseUrl: runtimeBase(KEY_REGIONS[0]),
      apiKey: "$KIRO_API_KEY",
      api: API,
      models: [],
      refreshModels,
      streamSimple: createStreamKiro(profiles.get),
    });

    pi.on("session_start", (event, ctx) => {
      if (problem && (event.reason === "startup" || event.reason === "reload")) {
        ctx.ui.notify(`pi-kiro-secure: Kiro models may be unavailable. ${redact(problem)}`, "warning");
      }
    });

    pi.registerCommand("kiro-usage", {
      description: "Show Kiro credits used this billing period",
      handler: async (_args, ctx) => {
        try {
          const apiKey = (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID))?.trim() || env.KIRO_API_KEY?.trim();
          if (!apiKey) {
            ctx.ui.notify("Kiro usage: no Kiro API key is configured (see the pi-kiro-secure README).", "warning");
            return;
          }
          const profileArn = await profiles.get(apiKey);
          const region = regionFromArn(profileArn) as string;
          ctx.ui.notify(`Kiro ${formatUsage(await usage(apiKey, { profileArn, region }))}`, "info");
        } catch (error) {
          ctx.ui.notify(`Kiro usage lookup failed: ${redact(error instanceof Error ? error.message : String(error))}`, "error");
        }
      },
    });
  };
}

export default createExtension();
