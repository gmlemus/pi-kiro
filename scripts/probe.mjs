// Live diagnostic for KIRO_API_KEY (PROTOCOL.md §9). Never prints the key.
//
//   node scripts/probe.mjs
//
// Checks the key's shape, then tries GetProfile in each Kiro region and, for
// the first region that answers, lists the models. Read-only: no chat call,
// no credits spent.

const REGIONS = ["us-east-1", "eu-central-1"];
const raw = process.env.KIRO_API_KEY;

const redact = (s) =>
  String(s)
    .replace(/ksk_[A-Za-z0-9_\-.]+/g, "ksk_[REDACTED]")
    .replace(/(bearer\s+)\S+/gi, "$1[REDACTED]")
    .slice(0, 300);

console.log("== key shape (value never printed)");
if (!raw) {
  console.log("KIRO_API_KEY is NOT set in this process's environment.");
  process.exit(1);
}
const key = raw.trim();
console.log({
  length: raw.length,
  hadSurroundingWhitespace: raw !== key,
  startsWithKsk: key.startsWith("ksk_"),
  containsQuotes: /["']/.test(key),
  containsWhitespaceInside: /\s/.test(key),
  containsNonPrintable: /[^\x21-\x7e]/.test(key),
});

const headers = (extra) => ({
  Authorization: `Bearer ${key}`,
  tokentype: "API_KEY",
  "user-agent": "pi-kiro-secure-probe/0.1.0",
  "x-amzn-codewhisperer-optout": "true",
  ...extra,
});

async function call(label, url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    console.log(`${label}: HTTP ${res.status} ${redact(body)}`);
    return res.ok ? JSON.parse(body) : undefined;
  } catch (e) {
    console.log(`${label}: request failed: ${redact(e.message)}`);
    return undefined;
  }
}

console.log("\n== GetProfile per region");
let found;
for (const region of REGIONS) {
  const data = await call(`GetProfile ${region}`, `https://management.${region}.kiro.dev/`, {
    method: "POST",
    headers: headers({
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererService.GetProfile",
    }),
    body: "{}",
  });
  const arn = data?.profile?.arn;
  if (arn && !found) found = { region, arn };
}

if (!found) {
  console.log("\nNo region accepted the key. Either the key is not the one you think, or it is revoked/expired.");
  process.exit(2);
}

const arnRegion = found.arn.split(":")[3];
console.log(`\nprofile found via ${found.region}; ARN region = ${arnRegion}`);

console.log("\n== List-Available-Models");
for (const region of [...new Set([found.region, arnRegion])]) {
  const url = new URL("List-Available-Models", `https://management.${region}.kiro.dev/`);
  url.searchParams.set("origin", "KIRO_CLI");
  url.searchParams.set("profileArn", found.arn);
  const data = await call(`ListAvailableModels ${region}`, url, {
    method: "GET",
    headers: headers({ Accept: "application/json" }),
  });
  if (data?.models) console.log(`  models: ${data.models.map((m) => m.modelId).join(", ")}`);
}

// ---- Credits / usage (PROTOCOL.md: not yet specified; this probe defines it) ----

/** Mask personal identifiers but keep the structure and numbers we need to see. */
const mask = (value) =>
  JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "string"
        ? v
            .replace(/[^\s@"]+@[^\s@"]+\.[^\s@"]+/g, "[email]")
            .replace(/(arn:aws:[a-z-]+:[a-z0-9-]*:)\d{12}/g, "$1[account]")
            .replace(/ksk_[A-Za-z0-9_\-.]+/g, "ksk_[REDACTED]")
        : v,
    ),
  );

async function show(label, url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    console.log(`${label}: HTTP ${res.status} content-type=${res.headers.get("content-type")}`);
    try {
      console.log(JSON.stringify(mask(JSON.parse(text)), null, 2));
    } catch {
      console.log(redact(text));
    }
    return res.ok;
  } catch (e) {
    console.log(`${label}: request failed: ${redact(e.message)}`);
    return false;
  }
}

console.log("\n== Usage limits (credits)");
const usageUrl = new URL("Get-Usage-Limits", `https://management.${arnRegion}.kiro.dev/`);
usageUrl.searchParams.set("profileArn", found.arn);
usageUrl.searchParams.set("origin", "KIRO_CLI");
usageUrl.searchParams.set("resourceType", "CREDIT");
usageUrl.searchParams.set("isEmailRequired", "false");
const restOk = await show(`GET Get-Usage-Limits ${arnRegion} (as reference B calls it)`, usageUrl, {
  method: "GET",
  headers: headers({ Accept: "application/json" }),
});

if (!restOk) {
  await show(`POST GetUsageLimits ${arnRegion} (RPC form, a guess)`, `https://management.${arnRegion}.kiro.dev/`, {
    method: "POST",
    headers: headers({
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
    }),
    body: JSON.stringify({ profileArn: found.arn, origin: "KIRO_CLI", resourceType: "CREDIT", isEmailRequired: false }),
  });
}
