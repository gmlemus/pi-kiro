import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension, PROVIDER_ID } from "../src/index.ts";
import { API_KEY, testCatalog } from "./helpers.ts";

const saved = { key: process.env.KIRO_API_KEY, region: process.env.KIRO_REGION };
afterEach(() => {
  for (const [name, value] of [["KIRO_API_KEY", saved.key], ["KIRO_REGION", saved.region]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function fakePi() {
  const providers: string[] = [];
  const notices: string[] = [];
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const pi = {
    registerProvider: (id: string) => providers.push(id),
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, opts.handler),
    on: (event: string, handler: (e: unknown, ctx: unknown) => void) => {
      assert.equal(event, "session_start");
      handler({ type: "session_start", reason: "startup" }, { ui: { notify: (m: string) => notices.push(m) } });
    },
  } as unknown as ExtensionAPI;
  const ctx = { ui: { notify: (m: string) => notices.push(m) } };
  return { pi, providers, notices, commands, ctx };
}

test("no key: dormant, no provider, no warning, no network", async () => {
  delete process.env.KIRO_API_KEY;
  const f = fakePi();
  await createExtension(() => assert.fail("must not discover"))(f.pi);
  assert.deepEqual([f.providers, f.notices], [[], []]);
});

test("blank key counts as not set", async () => {
  process.env.KIRO_API_KEY = "   ";
  const f = fakePi();
  await createExtension(() => assert.fail("must not discover"))(f.pi);
  assert.deepEqual([f.providers, f.notices], [[], []]);
});

test("wrong-looking key: warns, registers nothing, does not throw", async () => {
  process.env.KIRO_API_KEY = "sk-not-kiro";
  const f = fakePi();
  await createExtension(() => assert.fail("must not discover"))(f.pi);
  assert.deepEqual(f.providers, []);
  assert.match(f.notices[0] ?? "", /ksk_ prefix/);
});

test("discovery failure: warns without the key, registers nothing, does not throw", async () => {
  process.env.KIRO_API_KEY = API_KEY;
  const f = fakePi();
  await createExtension(async () => {
    throw new Error(`rejected ${API_KEY}`);
  })(f.pi);
  assert.deepEqual(f.providers, []);
  assert.match(f.notices[0] ?? "", /Model discovery failed/);
  assert.ok(!f.notices[0]?.includes(API_KEY));
});

test("invalid KIRO_REGION is a warning, not a crash", async () => {
  process.env.KIRO_API_KEY = API_KEY;
  process.env.KIRO_REGION = "nope.example.com";
  const f = fakePi();
  await createExtension(async () => testCatalog())(f.pi);
  assert.deepEqual(f.providers, []);
  assert.match(f.notices[0] ?? "", /KIRO_REGION/);
});

test("valid key: registers the provider", async () => {
  process.env.KIRO_API_KEY = API_KEY;
  delete process.env.KIRO_REGION;
  const f = fakePi();
  await createExtension(async () => testCatalog())(f.pi);
  assert.deepEqual(f.providers, [PROVIDER_ID]);
});

test("/kiro-usage is registered only with the provider, and reports failures without the key", async () => {
  delete process.env.KIRO_API_KEY;
  const off = fakePi();
  await createExtension()(off.pi);
  assert.equal(off.commands.size, 0);

  process.env.KIRO_API_KEY = API_KEY;
  delete process.env.KIRO_REGION;
  const ok = fakePi();
  await createExtension(
    async () => testCatalog(),
    async () => ({ used: 8, limit: 1000, overageEnabled: false, overageUsed: 0, overageCharges: 0, bonusCount: 0 }),
  )(ok.pi);
  await ok.commands.get("kiro-usage")?.("", ok.ctx);
  assert.match(ok.notices.at(-1) ?? "", /8 \/ 1000 credits used/);

  const bad = fakePi();
  await createExtension(
    async () => testCatalog(),
    async () => {
      throw new Error(`denied for ${API_KEY}`);
    },
  )(bad.pi);
  await bad.commands.get("kiro-usage")?.("", bad.ctx);
  assert.match(bad.notices.at(-1) ?? "", /usage lookup failed/);
  assert.ok(!bad.notices.at(-1)?.includes(API_KEY));
});
