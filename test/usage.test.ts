import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchUsage, formatUsage, parseUsage } from "../src/usage.ts";
import { API_KEY, fakeFetch, headerOf } from "./helpers.ts";

// Live response from 2026-11-05 (PROTOCOL.md §2.4), identifiers removed.
const LIVE = {
  daysUntilReset: null,
  limits: null,
  nextDateReset: 1796083200,
  overageConfiguration: { overageStatus: "DISABLED" },
  subscriptionInfo: {
    overageCapability: "OVERAGE_CAPABLE",
    subscriptionManagementTarget: "MANAGE",
    subscriptionTitle: "KIRO PRO",
    type: "Q_DEVELOPER_STANDALONE_PRO",
    upgradeCapability: "UPGRADE_INCAPABLE",
  },
  usageBreakdownList: [
    {
      addOnMetadata: null,
      bonuses: [],
      currency: "USD",
      currentOverages: 0,
      currentOveragesWithPrecision: 0,
      currentUsage: 8,
      currentUsageWithPrecision: 8,
      dimensionType: null,
      displayName: "Credit",
      displayNamePlural: "Credits",
      freeTrialInfo: null,
      nextDateReset: 1796083200,
      overageCap: 10000,
      overageCapWithPrecision: 10000,
      overageCharges: 0,
      overageCredits: [],
      overageRate: 0.04,
      resourceType: "CREDIT",
      unit: "INVOCATIONS",
      usageLimit: 1000,
      usageLimitWithPrecision: 1000,
    },
  ],
  userInfo: { email: "someone@example.com", userId: "opaque" },
};

test("parses the live response; reset is seconds; identity is never read", () => {
  const u = parseUsage(LIVE);
  assert.deepEqual(u, {
    plan: "KIRO PRO",
    used: 8,
    limit: 1000,
    resetsAt: 1796083200_000,
    overageEnabled: false,
    overageUsed: 0,
    overageCap: 10000,
    overageRate: 0.04,
    overageCharges: 0,
    currency: "USD",
    bonusCount: 0,
  });
  assert.equal(formatUsage(u), "KIRO PRO: 8 / 1000 credits used (0.8%) · resets 2026-12-01 · overage off");
  assert.ok(!JSON.stringify(u).includes("someone@example.com"));
});

test("prefers fractional precision fields and shows overage when enabled", () => {
  const body = structuredClone(LIVE) as typeof LIVE & { overageConfiguration: { overageStatus: string } };
  body.overageConfiguration.overageStatus = "ENABLED";
  Object.assign(body.usageBreakdownList[0] as object, {
    currentUsage: 1000,
    currentUsageWithPrecision: 1000,
    currentOveragesWithPrecision: 12.345,
    overageCharges: 0.49,
  });
  assert.equal(
    formatUsage(parseUsage(body)),
    "KIRO PRO: 1000 / 1000 credits used (100.0%) · resets 2026-12-01 · overage on: 12.35 / 10000 credits at 0.04 USD/credit, 0.49 USD charged",
  );
});

test("rejects responses without a usable CREDIT entry", () => {
  assert.throws(() => parseUsage({}), /no CREDIT entry/);
  assert.throws(() => parseUsage({ usageBreakdownList: [{ resourceType: "CREDIT" }] }), /missing current usage/);
});

test("request goes to the profile's region with the documented query", async () => {
  const f = fakeFetch([() => new Response(JSON.stringify(LIVE), { status: 200 })]);
  await fetchUsage(API_KEY, { profileArn: "arn:aws:codewhisperer:eu-central-1:1:profile/X", region: "eu-central-1" }, f.impl);
  const call = f.calls[0];
  assert.ok(call);
  const url = new URL(call.url);
  assert.equal(url.origin + url.pathname, "https://management.eu-central-1.kiro.dev/Get-Usage-Limits");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    profileArn: "arn:aws:codewhisperer:eu-central-1:1:profile/X",
    origin: "KIRO_CLI",
    resourceType: "CREDIT",
    isEmailRequired: "false",
  });
  assert.equal(headerOf(call, "tokentype"), "API_KEY");
});
