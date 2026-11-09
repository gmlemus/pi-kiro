// Account credit usage (PROTOCOL.md §2.4).

import type { Catalog } from "./catalog.ts";
import { KiroError } from "./errors.ts";
import { authHeaders, baseHeaders, fetchWithHeaderTimeout, managementBase, readJson } from "./http.ts";
import { ORIGIN } from "./wire.ts";

const USAGE_TIMEOUT_MS = 15_000;

export interface CreditUsage {
  plan?: string;
  used: number;
  limit: number;
  /** Reset time in ms since epoch. */
  resetsAt?: number;
  overageEnabled: boolean;
  overageUsed: number;
  overageCap?: number;
  overageRate?: number;
  overageCharges: number;
  currency?: string;
  bonusCount: number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Extract the CREDIT breakdown. `userInfo` is deliberately never read. */
export function parseUsage(body: unknown): CreditUsage {
  const root = rec(body);
  const list = Array.isArray(root.usageBreakdownList) ? root.usageBreakdownList.map(rec) : [];
  const credit = list.find((e) => e.resourceType === "CREDIT");
  if (!credit) throw new KiroError("protocol", "Kiro usage response has no CREDIT entry");
  const used = num(credit.currentUsageWithPrecision) ?? num(credit.currentUsage);
  const limit = num(credit.usageLimitWithPrecision) ?? num(credit.usageLimit);
  if (used === undefined || limit === undefined) {
    throw new KiroError("protocol", "Kiro usage response is missing current usage or the limit");
  }
  const reset = num(credit.nextDateReset) ?? num(root.nextDateReset);
  const out: CreditUsage = {
    used,
    limit,
    overageEnabled: rec(root.overageConfiguration).overageStatus === "ENABLED",
    overageUsed: num(credit.currentOveragesWithPrecision) ?? num(credit.currentOverages) ?? 0,
    overageCharges: num(credit.overageCharges) ?? 0,
    bonusCount: Array.isArray(credit.bonuses) ? credit.bonuses.length : 0,
  };
  const plan = str(rec(root.subscriptionInfo).subscriptionTitle);
  if (plan) out.plan = plan;
  // Seconds on the wire (§2.4).
  if (reset !== undefined) out.resetsAt = reset * 1000;
  const cap = num(credit.overageCapWithPrecision) ?? num(credit.overageCap);
  if (cap !== undefined) out.overageCap = cap;
  const rate = num(credit.overageRate);
  if (rate !== undefined) out.overageRate = rate;
  const currency = str(credit.currency);
  if (currency) out.currency = currency;
  return out;
}

export async function fetchUsage(
  apiKey: string,
  catalog: Pick<Catalog, "profileArn" | "region">,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CreditUsage> {
  const url = new URL("Get-Usage-Limits", managementBase(catalog.region));
  url.searchParams.set("profileArn", catalog.profileArn);
  url.searchParams.set("origin", ORIGIN);
  url.searchParams.set("resourceType", "CREDIT");
  url.searchParams.set("isEmailRequired", "false");
  const response = await fetchWithHeaderTimeout(
    fetchImpl,
    url.toString(),
    { method: "GET", headers: { ...baseHeaders(), ...authHeaders(apiKey), Accept: "application/json" } },
    USAGE_TIMEOUT_MS,
    signal,
    "GetUsageLimits",
  );
  return parseUsage(await readJson<unknown>(response, "GetUsageLimits"));
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function formatUsage(u: CreditUsage): string {
  const pct = u.limit > 0 ? ` (${((u.used / u.limit) * 100).toFixed(1)}%)` : "";
  const parts = [`${u.plan ? `${u.plan}: ` : ""}${fmt(u.used)} / ${fmt(u.limit)} credits used${pct}`];
  if (u.resetsAt !== undefined) parts.push(`resets ${new Date(u.resetsAt).toISOString().slice(0, 10)}`);
  if (u.bonusCount > 0) parts.push(`${u.bonusCount} bonus grant(s)`);
  if (u.overageEnabled) {
    const money = u.overageRate !== undefined ? ` at ${u.overageRate} ${u.currency ?? ""}/credit`.trimEnd() : "";
    parts.push(
      `overage on: ${fmt(u.overageUsed)}${u.overageCap !== undefined ? ` / ${fmt(u.overageCap)}` : ""} credits${money}` +
        (u.overageCharges > 0 ? `, ${fmt(u.overageCharges)} ${u.currency ?? ""} charged`.trimEnd() : ""),
    );
  } else {
    parts.push("overage off");
  }
  return parts.join(" · ");
}
