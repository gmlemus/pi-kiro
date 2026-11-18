import assert from "node:assert/strict";
import { test } from "node:test";
import { createProfileResolver, discoverModels, keyRegions, kiroMeta, restoreModels } from "../src/catalog.ts";
import { API_KEY, fakeFetch, headerOf, PROFILE_ARN } from "./helpers.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("discovery: GetProfile then List-Available-Models, mapped to pi models", async () => {
  const f = fakeFetch([
    () => json({ profile: { arn: PROFILE_ARN } }),
    () =>
      json({
        models: [
          {
            modelId: "claude-opus-4.8",
            modelName: "Claude Opus 4.8",
            supportedInputTypes: ["TEXT", "IMAGE"],
            tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 128000 },
            additionalModelRequestFieldsSchema: {
              properties: { output_config: { properties: { effort: { enum: ["low", "high", "xhigh", "max"] } } } },
            },
          },
          { modelId: "minimax-m2.5" },
          { modelId: "bad id with spaces" },
          { modelId: 42 },
        ],
      }),
  ]);
  const c = await discoverModels(API_KEY, f.impl);

  const [profile, list] = f.calls;
  assert.ok(profile && list);
  assert.equal(profile.url, "https://management.us-east-1.kiro.dev/");
  assert.equal(headerOf(profile, "x-amz-target"), "AmazonCodeWhispererService.GetProfile");
  assert.equal(headerOf(profile, "tokentype"), "API_KEY");
  assert.equal(profile.init.body, "{}");
  const url = new URL(list.url);
  assert.equal(url.origin + url.pathname, "https://management.us-east-1.kiro.dev/List-Available-Models");
  assert.equal(url.searchParams.get("origin"), "KIRO_CLI");
  assert.equal(url.searchParams.get("profileArn"), PROFILE_ARN);

  assert.equal(c.profileArn, PROFILE_ARN);
  assert.equal(c.models[0]?.baseUrl, "https://runtime.us-east-1.kiro.dev/");
  assert.deepEqual(c.models.map((m) => m.id), ["claude-opus-4-8", "minimax-m2-5"]);
  const opus = c.models[0] as { input: string[]; contextWindow: number; maxTokens: number; thinkingLevelMap?: object };
  assert.deepEqual(opus.input, ["text", "image"]);
  assert.equal(opus.contextWindow, 1000000);
  assert.equal(opus.maxTokens, 128000);
  assert.deepEqual(opus.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
  assert.deepEqual(c.models[1]?.kiro, { id: "minimax-m2.5", region: "us-east-1" });
  assert.equal(c.models[0]?.kiro.effort?.field, "output_config");
  assert.deepEqual((c.models[1] as { input: string[] }).input, ["text"]);
});

test("runtime host follows the profile ARN's region", async () => {
  const f = fakeFetch([
    () => json({ profile: { arn: "arn:aws:codewhisperer:eu-central-1:1:profile/X" } }),
    () => json({ models: [{ modelId: "m" }] }),
  ]);
  const c = await discoverModels(API_KEY, f.impl);
  assert.equal(c.models[0]?.baseUrl, "https://runtime.eu-central-1.kiro.dev/");
});

test("discovery fails closed", async () => {
  await assert.rejects(discoverModels(API_KEY, fakeFetch([() => json({ profile: {} })]).impl), /no usable profile ARN/);
  await assert.rejects(
    discoverModels(API_KEY, fakeFetch([() => json({ profile: { arn: "arn:aws:x:not a region:1:p" } })]).impl),
    /no usable profile ARN/,
  );
  await assert.rejects(
    discoverModels(API_KEY, fakeFetch([() => json({ profile: { arn: PROFILE_ARN } }), () => json({ models: [] })]).impl),
    /no models/,
  );
  await assert.rejects(
    discoverModels(
      API_KEY,
      fakeFetch([() => json({ message: `bad key ${API_KEY}` }, 403), () => json({ message: `bad key ${API_KEY}` }, 403)]).impl,
    ),
    (e: Error) => /rejected the API key/.test(e.message) && !e.message.includes(API_KEY),
  );
});

const invalidToken = () =>
  json({ __type: "com.amazon.kiro.controlplane#AccessDeniedException", message: "Invalid token" }, 400);
const EU_ARN = "arn:aws:codewhisperer:eu-central-1:210987654321:profile/X";

test("an eu-central-1 key: us-east-1 says Invalid token, eu-central-1 answers, everything follows the ARN", async () => {
  const f = fakeFetch([invalidToken, () => json({ profile: { arn: EU_ARN } }), () => json({ models: [{ modelId: "auto" }] })]);
  const c = await discoverModels(API_KEY, f.impl);
  assert.deepEqual(
    f.calls.map((call) => new URL(call.url).host),
    ["management.us-east-1.kiro.dev", "management.eu-central-1.kiro.dev", "management.eu-central-1.kiro.dev"],
  );
  assert.equal(c.models[0]?.baseUrl, "https://runtime.eu-central-1.kiro.dev/");
  assert.equal(c.models[0]?.kiro.region, "eu-central-1");
  assert.equal(c.profileArn, EU_ARN);
});

test("KIRO_REGION is tried first", async () => {
  const f = fakeFetch([() => json({ profile: { arn: EU_ARN } }), () => json({ models: [{ modelId: "auto" }] })]);
  await discoverModels(API_KEY, f.impl, keyRegions("EU-Central-1"));
  assert.equal(new URL(f.calls[0]?.url ?? "").host, "management.eu-central-1.kiro.dev");
  assert.deepEqual(keyRegions(undefined), ["us-east-1", "eu-central-1"]);
  assert.throws(() => keyRegions("eu-central-1.evil.com"), /not a valid AWS region/);
});

test("a key rejected everywhere names every region tried", async () => {
  await assert.rejects(
    discoverModels(API_KEY, fakeFetch([invalidToken, invalidToken]).impl),
    /rejected the API key in every region tried \(us-east-1, eu-central-1\)/,
  );
});

test("a non-auth failure does not fall through to the next region", async () => {
  const f = fakeFetch([() => json({ message: "boom" }, 500)]);
  await assert.rejects(discoverModels(API_KEY, f.impl), /server error/);
  assert.equal(f.calls.length, 1);
});

test("a stored catalog round-trips, and derived fields are recomputed, not trusted", async () => {
  const f = fakeFetch([
    () => json({ profile: { arn: EU_ARN } }),
    () =>
      json({
        models: [
          {
            modelId: "claude-haiku-5.5",
            modelName: "Claude Haiku 5.5",
            supportedInputTypes: ["TEXT", "IMAGE"],
            tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 },
            additionalModelRequestFieldsSchema: {
              properties: { output_config: { properties: { effort: { enum: ["low", "high", "max"] } } } },
            },
          },
        ],
      }),
  ]);
  const { models } = await discoverModels(API_KEY, f.impl);
  // What pi's model store hands back: plain JSON, plus fields pi adds.
  const stored = JSON.parse(JSON.stringify(models.map((m) => ({ ...m, provider: "kiro-secure" }))));
  assert.deepEqual(restoreModels(stored), models);
  assert.ok(!JSON.stringify(stored).includes(EU_ARN.split(":")[4] as string), "no ARN in the store");

  const tampered = [{ ...stored[0], baseUrl: "https://evil.example/", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }];
  const [m] = restoreModels(tampered);
  assert.equal(m?.baseUrl, "https://runtime.eu-central-1.kiro.dev/");
  assert.equal(m?.cost.input, 0);
});

test("restoreModels drops entries that are not well-formed Kiro models", () => {
  const good = { id: "auto", api: "kiro-runtime", name: "Auto", input: ["text"], kiro: { id: "auto", region: "us-east-1" } };
  assert.deepEqual(
    restoreModels([
      good,
      { ...good, api: "openai-completions" },
      { ...good, kiro: { id: "auto", region: "evil.com/x" } },
      { ...good, kiro: { id: "bad id", region: "us-east-1" } },
      { ...good, id: "other" },
      { ...good },
      "junk",
      null,
    ]).map((m) => m.id),
    ["auto"],
  );
  assert.deepEqual(restoreModels(undefined), []);
  assert.equal(kiroMeta({ kiro: { id: "m", region: "us-east-1", effort: { field: "nope", values: ["low"] } } })?.effort, undefined);
});

test("profile resolver: one lookup per key, seedable, failures do not stick", async () => {
  const f = fakeFetch([
    () => json({ message: "boom" }, 500),
    () => json({ profile: { arn: EU_ARN } }),
  ]);
  const r = createProfileResolver(f.impl);
  await assert.rejects(r.get(API_KEY, "eu-central-1"), /server error/);
  assert.equal(await r.get(API_KEY, "eu-central-1"), EU_ARN);
  assert.equal(await r.get(API_KEY, "eu-central-1"), EU_ARN);
  assert.equal(f.calls.length, 2);
  assert.equal(new URL(f.calls[1]?.url ?? "").host, "management.eu-central-1.kiro.dev", "region hint tried first");

  r.seed("ksk_other", PROFILE_ARN);
  assert.equal(await r.get("ksk_other"), PROFILE_ARN);
  assert.equal(f.calls.length, 2);
});
