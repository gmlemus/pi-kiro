import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverCatalog, keyRegions } from "../src/catalog.ts";
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
  const c = await discoverCatalog(API_KEY, f.impl);

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

  assert.equal(c.runtimeBaseUrl, "https://runtime.us-east-1.kiro.dev/");
  assert.deepEqual(c.models.map((m) => m.id), ["claude-opus-4-8", "minimax-m2-5"]);
  const opus = c.models[0] as { input: string[]; contextWindow: number; maxTokens: number; thinkingLevelMap?: object };
  assert.deepEqual(opus.input, ["text", "image"]);
  assert.equal(opus.contextWindow, 1000000);
  assert.equal(opus.maxTokens, 128000);
  assert.deepEqual(opus.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
  assert.equal(c.byPiId.get("minimax-m2-5")?.kiroId, "minimax-m2.5");
  assert.deepEqual((c.models[1] as { input: string[] }).input, ["text"]);
});

test("runtime host follows the profile ARN's region", async () => {
  const f = fakeFetch([
    () => json({ profile: { arn: "arn:aws:codewhisperer:eu-central-1:1:profile/X" } }),
    () => json({ models: [{ modelId: "m" }] }),
  ]);
  const c = await discoverCatalog(API_KEY, f.impl);
  assert.equal(c.runtimeBaseUrl, "https://runtime.eu-central-1.kiro.dev/");
});

test("discovery fails closed", async () => {
  await assert.rejects(discoverCatalog(API_KEY, fakeFetch([() => json({ profile: {} })]).impl), /no usable profile ARN/);
  await assert.rejects(
    discoverCatalog(API_KEY, fakeFetch([() => json({ profile: { arn: "arn:aws:x:not a region:1:p" } })]).impl),
    /no usable profile ARN/,
  );
  await assert.rejects(
    discoverCatalog(API_KEY, fakeFetch([() => json({ profile: { arn: PROFILE_ARN } }), () => json({ models: [] })]).impl),
    /no models/,
  );
  await assert.rejects(
    discoverCatalog(
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
  const c = await discoverCatalog(API_KEY, f.impl);
  assert.deepEqual(
    f.calls.map((call) => new URL(call.url).host),
    ["management.us-east-1.kiro.dev", "management.eu-central-1.kiro.dev", "management.eu-central-1.kiro.dev"],
  );
  assert.equal(c.runtimeBaseUrl, "https://runtime.eu-central-1.kiro.dev/");
  assert.equal(c.profileArn, EU_ARN);
});

test("KIRO_REGION is tried first", async () => {
  const f = fakeFetch([() => json({ profile: { arn: EU_ARN } }), () => json({ models: [{ modelId: "auto" }] })]);
  await discoverCatalog(API_KEY, f.impl, keyRegions("EU-Central-1"));
  assert.equal(new URL(f.calls[0]?.url ?? "").host, "management.eu-central-1.kiro.dev");
  assert.deepEqual(keyRegions(undefined), ["us-east-1", "eu-central-1"]);
  assert.throws(() => keyRegions("eu-central-1.evil.com"), /not a valid AWS region/);
});

test("a key rejected everywhere names every region tried", async () => {
  await assert.rejects(
    discoverCatalog(API_KEY, fakeFetch([invalidToken, invalidToken]).impl),
    /rejected the API key in every region tried \(us-east-1, eu-central-1\)/,
  );
});

test("a non-auth failure does not fall through to the next region", async () => {
  const f = fakeFetch([() => json({ message: "boom" }, 500)]);
  await assert.rejects(discoverCatalog(API_KEY, f.impl), /server error/);
  assert.equal(f.calls.length, 1);
});
