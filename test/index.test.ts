import assert from "node:assert/strict";
import { test } from "node:test";
import type { RefreshModelsContext, ModelsPublication } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { type Discovery, createProfileResolver } from "../src/catalog.ts";
import { createExtension, type Deps, PROVIDER_ID } from "../src/index.ts";
import { API_KEY, fakeFetch, PROFILE_ARN, testModel } from "./helpers.ts";

const discovery = (): Discovery => ({ profileArn: PROFILE_ARN, models: [testModel()] });

function fakePi(deps: Deps = {}) {
  const providers = new Map<string, ProviderConfig>();
  const notices: string[] = [];
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const sessionStart: Array<(e: unknown, ctx: unknown) => void> = [];
  const pi = {
    registerProvider: (id: string, config: ProviderConfig) => providers.set(id, config),
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, opts.handler),
    on: (event: string, handler: (e: unknown, ctx: unknown) => void) => {
      assert.equal(event, "session_start");
      sessionStart.push(handler);
    },
  } as unknown as ExtensionAPI;
  createExtension({ env: {}, ...deps })(pi);
  const ui = { notify: (m: string) => notices.push(m) };
  const startSession = () => {
    for (const h of sessionStart) h({ type: "session_start", reason: "startup" }, { ui });
  };
  const ctx = (key?: string) => ({ ui, modelRegistry: { getApiKeyForProvider: async () => key } });
  const provider = providers.get(PROVIDER_ID);
  assert.ok(provider?.refreshModels);
  const published: ModelsPublication[] = [];
  const refresh = (opts: Partial<RefreshModelsContext> = {}) =>
    provider.refreshModels?.({
      allowNetwork: false,
      signal: new AbortController().signal,
      publish: async (p) => {
        published.push(p);
        return true;
      },
      ...opts,
    } as RefreshModelsContext);
  return { provider, notices, commands, startSession, ctx, refresh, published };
}

const piKey = (key: string) => ({ credential: { type: "api_key" as const, key } });
const mustNotDiscover: Deps["discover"] = async () => assert.fail("must not discover");

test("the provider is always registered, synchronously, with no network at load", () => {
  const f = fakePi({ discover: mustNotDiscover });
  assert.equal(f.provider.api, "kiro-runtime");
  assert.deepEqual(f.provider.models, []);
  assert.equal(f.provider.apiKey, "$KIRO_API_KEY");
});

test("no key anywhere: no models, no network, no warning", async () => {
  const f = fakePi({ discover: mustNotDiscover });
  assert.deepEqual(await f.refresh({ allowNetwork: true }), []);
  f.startSession();
  assert.deepEqual(f.notices, []);
});

test("key from pi's credential (auth.json / !command): discovers, persists only model facts, seeds the profile", async () => {
  const seen: string[] = [];
  const profiles = createProfileResolver(fakeFetch([]).impl);
  const f = fakePi({
    profiles,
    discover: async (key) => {
      seen.push(key);
      return discovery();
    },
  });
  const models = await f.refresh({ ...piKey(API_KEY), allowNetwork: true });
  assert.deepEqual(seen, [API_KEY]);
  assert.deepEqual(models?.map((m) => m.id), ["claude-sonnet-4-6"]);
  const stored = JSON.stringify(f.published[0]?.persist);
  assert.ok(stored.includes("claude-sonnet-4.6"));
  assert.ok(!stored.includes(API_KEY) && !stored.includes(PROFILE_ARN), "store holds neither the key nor the ARN");
  assert.equal(await profiles.get(API_KEY), PROFILE_ARN, "first chat needs no GetProfile");
});

test("KIRO_API_KEY still works when pi has no stored credential", async () => {
  const seen: string[] = [];
  const f = fakePi({ env: { KIRO_API_KEY: ` ${API_KEY} ` }, discover: async (key) => (seen.push(key), discovery()) });
  await f.refresh({ allowNetwork: true });
  assert.deepEqual(seen, [API_KEY]);
});

test("cache-only startup serves the store and stays off the network", async () => {
  const f = fakePi({ discover: mustNotDiscover });
  const stored = JSON.parse(JSON.stringify([testModel()]));
  const models = await f.refresh({ ...piKey(API_KEY), stored: { models: stored } });
  assert.deepEqual(models?.map((m) => m.id), ["claude-sonnet-4-6"]);
  assert.equal(f.published.length, 0);
});

test("an empty store is filled on first use even at cache-only startup, unless PI_OFFLINE is set", async () => {
  let calls = 0;
  const discover: Deps["discover"] = async () => (calls++, discovery());
  assert.equal((await fakePi({ discover }).refresh(piKey(API_KEY)))?.length, 1);
  assert.equal(calls, 1);
  assert.deepEqual(await fakePi({ discover, env: { PI_OFFLINE: "1" } }).refresh(piKey(API_KEY)), []);
  assert.equal(calls, 1);
});

test("concurrent refreshes share one discovery", async () => {
  let calls = 0;
  const f = fakePi({ discover: async () => (calls++, discovery()) });
  await Promise.all([f.refresh({ ...piKey(API_KEY), allowNetwork: true }), f.refresh({ ...piKey(API_KEY), allowNetwork: true })]);
  assert.equal(calls, 1);
});

test("discovery failure keeps the stored models and warns without the key", async () => {
  const f = fakePi({
    discover: async () => {
      throw new Error(`rejected ${API_KEY}`);
    },
  });
  const stored = JSON.parse(JSON.stringify([testModel()]));
  const models = await f.refresh({ ...piKey(API_KEY), allowNetwork: true, stored: { models: stored } });
  assert.deepEqual(models?.map((m) => m.id), ["claude-sonnet-4-6"]);
  f.startSession();
  assert.match(f.notices[0] ?? "", /Model discovery failed/);
  assert.ok(!f.notices[0]?.includes(API_KEY));
});

test("a wrong-looking key or an invalid KIRO_REGION is a warning, not a crash", async () => {
  const bad = fakePi({ discover: mustNotDiscover });
  assert.deepEqual(await bad.refresh({ ...piKey("sk-not-kiro"), allowNetwork: true }), []);
  bad.startSession();
  assert.match(bad.notices[0] ?? "", /ksk_ prefix/);

  const region = fakePi({ env: { KIRO_REGION: "nope.example.com" }, discover: async () => discovery() });
  assert.deepEqual(await region.refresh({ ...piKey(API_KEY), allowNetwork: true }), []);
  region.startSession();
  assert.match(region.notices[0] ?? "", /KIRO_REGION/);
});

test("/kiro-usage uses the key pi resolves, and reports failures without the key", async () => {
  const profiles = createProfileResolver(fakeFetch([]).impl);
  profiles.seed(API_KEY, PROFILE_ARN);
  const ok = fakePi({
    profiles,
    usage: async (key, profile) => {
      assert.equal(key, API_KEY);
      assert.deepEqual(profile, { profileArn: PROFILE_ARN, region: "us-east-1" });
      return { used: 8, limit: 1000, overageEnabled: false, overageUsed: 0, overageCharges: 0, bonusCount: 0 };
    },
  });
  await ok.commands.get("kiro-usage")?.("", ok.ctx(API_KEY));
  assert.match(ok.notices.at(-1) ?? "", /8 \/ 1000 credits used/);

  const none = fakePi();
  await none.commands.get("kiro-usage")?.("", none.ctx(undefined));
  assert.match(none.notices.at(-1) ?? "", /no Kiro API key is configured/);

  const bad = fakePi({
    profiles,
    usage: async () => {
      throw new Error(`denied for ${API_KEY}`);
    },
  });
  await bad.commands.get("kiro-usage")?.("", bad.ctx(API_KEY));
  assert.match(bad.notices.at(-1) ?? "", /usage lookup failed/);
  assert.ok(!bad.notices.at(-1)?.includes(API_KEY));
});
