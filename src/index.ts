// pi extension entry: discover this key's Kiro models, then register the provider.
//
// This extension must never stop pi from starting. Without KIRO_API_KEY it
// stays dormant: setting the key is an opt-in. With a key that cannot be
// used, it registers nothing (models stay fail-closed) and warns once.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API, type Catalog, discoverCatalog, keyRegions } from "./catalog.ts";
import { redact } from "./errors.ts";
import { createStreamKiro } from "./stream.ts";
import { fetchUsage, formatUsage } from "./usage.ts";

export const PROVIDER_ID = "kiro-secure";

export type Discover = (apiKey: string, regions: string[]) => Promise<Catalog>;
export type Usage = (apiKey: string, catalog: Catalog) => ReturnType<typeof fetchUsage>;

export function createExtension(
  discover: Discover = (key, regions) => discoverCatalog(key, fetch, regions),
  usage: Usage = (key, catalog) => fetchUsage(key, catalog),
) {
  return async function registerKiro(pi: ExtensionAPI): Promise<void> {
    const apiKey = process.env.KIRO_API_KEY?.trim();
    if (!apiKey) return;

    const warn = (reason: string) => {
      pi.on("session_start", (event, ctx) => {
        if (event.reason === "startup" || event.reason === "reload") {
          ctx.ui.notify(`pi-kiro-secure: Kiro models are unavailable. ${redact(reason)}`, "warning");
        }
      });
    };

    if (!apiKey.startsWith("ksk_")) {
      warn("KIRO_API_KEY does not look like a Kiro API key (expected a ksk_ prefix).");
      return;
    }

    let catalog: Catalog;
    try {
      const regions = keyRegions(process.env.KIRO_REGION);
      catalog = await discover(apiKey, regions);
    } catch (error) {
      // Fail closed on models, not on pi: no catalog means no provider.
      warn(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    pi.registerProvider(PROVIDER_ID, {
      name: "Kiro (API key)",
      baseUrl: catalog.runtimeBaseUrl,
      apiKey: "$KIRO_API_KEY",
      api: API,
      models: catalog.models,
      streamSimple: createStreamKiro(() => catalog),
    });

    pi.registerCommand("kiro-usage", {
      description: "Show Kiro credits used this billing period",
      handler: async (_args, ctx) => {
        try {
          ctx.ui.notify(`Kiro ${formatUsage(await usage(apiKey, catalog))}`, "info");
        } catch (error) {
          ctx.ui.notify(`Kiro usage lookup failed: ${redact(error instanceof Error ? error.message : String(error))}`, "error");
        }
      },
    });
  };
}

export default createExtension();
