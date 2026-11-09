# Kiro wire protocol — working spec for pi-kiro-secure

Status: **Phase 0 draft, for review.** Phase 1 is implemented from this document only.

Kiro does not publish its wire protocol. Its only public documentation covers API-key
authentication (kiro.dev/docs/cli/authentication). Everything below comes from reading two
community packages as **protocol references only**. No code was copied from them, and none
of their scripts were run.

| Tag | Reference | Commit read |
|---|---|---|
| **A** | github.com/satiyap/pi-kiro-api | `86c8f2d` |
| **B** | github.com/mikeyobrien/pi-provider-kiro | `dd93f2e` |

Confidence markers used on every item:

- **[BOTH]**: both references implement it the same way.
- **[A]** / **[B]**: only one reference has it.
- **[CONFLICT]**: the references disagree. The entry says which one we follow and why.
- **[INFERRED]**: neither reference states it. It comes from the public AWS event-stream
  spec or from reasoning, and Phase 1 must verify it against the live service.

Pointers are written as `A:path:line` or `B:path:line`.

> **Caveat on [BOTH].** Reference A's files say they are vendored from an earlier package
> ("pi-kiro", `A:src/kiro/transform.ts:1`, `A:src/kiro/stream.ts:1-2`), and B appears to come
> from the same lineage. So "[BOTH]" means the two implementations agree. It does **not** mean
> two independent sources confirmed it. Anything load-bearing should still be probed live.

---

## 0. The fork in the road: two transports

The references talk to **different hosts with different request conventions**. Both claim to
work with a `ksk_` API key. We have to pick one before Phase 1.

| Aspect | Transport **Q** (used by A) | Transport **R** (used by B) |
|---|---|---|
| Chat host | `https://q.{region}.amazonaws.com/` (`A:extension.ts:40`) | `https://runtime.{region}.kiro.dev/generateAssistantResponse` (`B:src/endpoints.ts:44-50`, `B:src/stream.ts:666`) |
| Chat routing | `POST /` with `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse` (`A:src/kiro/stream.ts:475`) | REST path, no `X-Amz-Target` (`B:src/stream.ts:1036-1049`) |
| Chat `Content-Type` | `application/x-amz-json-1.0` (`A:src/kiro/stream.ts:471`) | `application/json` (`B:src/stream.ts:1039`) |
| Chat `Accept` | `application/json`; the body is still event-stream, see §4 (`A:src/kiro/stream.ts:472`) | `application/vnd.amazon.eventstream` (`B:src/stream.ts:1040`) |
| `origin` value | `AI_EDITOR`; A says API keys require it (`A:src/kiro/transform.ts:79-83`) | `KIRO_CLI` (`B:src/transform.ts:37`, `B:src/stream.ts:999`) |
| `profileArn` in body | not sent; A says API-key auth does not use it (`A/README.md:133-136`) | **required** top-level field (`B:src/stream.ts:234,1007`) |
| Model listing | same host, `X-Amz-Target: AmazonCodeWhispererService.ListAvailableModels` (`A:src/kiro/discover.ts:23`) | `GET https://management.{region}.kiro.dev/List-Available-Models?origin=KIRO_CLI&profileArn=…` (`B:src/management.ts:12,335-358`) |
| Profile lookup | none | `POST https://management.us-east-1.kiro.dev/` with `X-Amz-Target: AmazonCodeWhispererService.GetProfile` and body `{}` (`B:src/management.ts:183-207`) |
| Region rule | key is region-scoped; the wrong region returns `AccessDeniedException` (`A/README.md:81-83`) | API keys are issued in `us-east-1` (`B:src/management.ts:15-20`) — **wrong, see §2.1: disproved live 2026-11-05**; the runtime region must match the profile ARN's region (`B:src/endpoints.ts:52-63`) |
| Structured reasoning | none | `additionalModelRequestFields` (`B:src/effort.ts:126-147`) |
| Typed stream events | no; A sniffs JSON by field shape (`A:src/kiro/event-parser.ts:52-124`) | yes, routes on `:event-type` (`B:src/event-parser.ts:228-283`) |

B's changelog records a deliberate migration *away* from an older transport toward the
management/runtime services "matching the current kiro-cli and kiro-agent REST protocols"
(`B:CHANGELOG.md:137`). It also records a wire probe of transport R that returned HTTP 200
(`B:src/transform.ts:66-70`) and API-key support on that transport (`B:CHANGELOG.md:60,72`).

**Recommendation: implement transport R** (B's runtime/management hosts). It is the one with
typed events, structured reasoning, a usage/stop-reason event, and a recorded live probe.
Transport Q is documented here so we can fall back to it if a Phase 1 probe shows R refusing
our key. **This needs your decision before Phase 1.**

The rest of this document describes both transports where they differ. Payload shapes
(§3) are the same on both, apart from `origin` and `profileArn`.

---

## 1. Authentication and common headers

| Header | Value | Status |
|---|---|---|
| `Authorization` | `Bearer <ksk_… key>` | [BOTH] `A:src/kiro/stream.ts:473`, `B:src/oauth.ts:66-74` |
| `tokentype` | `API_KEY` whenever the token starts with `ksk_` | [BOTH] `A:src/kiro/stream.ts:474`, `B:src/oauth.ts:70-78` |
| `x-amzn-codewhisperer-optout` | `true` (opts out of data sharing) | [BOTH] `A:src/kiro/stream.ts:476`, `B:src/stream.ts:1043` |
| `x-amzn-kiro-agent-mode` | `vibe` (chat only) | [BOTH] `A:src/kiro/stream.ts:479`, `B:src/stream.ts:1046` |
| `amz-sdk-invocation-id` | random UUID per request | [BOTH] `A:src/kiro/stream.ts:477`, `B:src/stream.ts:1044` |
| `amz-sdk-request` | `attempt=1; max=1` | [BOTH] `A:src/kiro/stream.ts:478`, `B:src/stream.ts:1045` |
| `user-agent` / `x-amz-user-agent` | Both send an AWS-SDK-shaped UA that impersonates the Amazon Q CLI (`aws-sdk-rust/… app/AmazonQ-For-CLI …`) | [BOTH] `A:src/kiro/stream.ts:456-457`, `B:src/stream.ts:1015-1016` |

Notes:

- **API-key format.** Keys start with `ksk_` [B] (`B:src/oauth.ts:76-82`) [A] (`A/README.md:27`).
- **User-Agent is a policy choice for us.** Neither reference shows the server *requiring*
  the impersonated UA. For a package called *-secure*, Phase 1 should first probe with an
  honest UA (e.g. `pi-kiro-secure/<version>`) and only fall back if the server rejects it.
  [INFERRED: whether the UA is checked is unknown.]
- `tokentype: EXTERNAL_IDP` exists for enterprise OIDC JWTs (`B:src/token-type.ts:34-45`).
  This is out of scope because we support API keys only.
- **Secrets hygiene.** B redacts error bodies before logging (`B:src/stream.ts:1071`). We must
  never log the `Authorization` header or the raw key. This is a policy for us, not protocol.

---

## 2. Model listing (ListAvailableModels)

### 2.1 Transport R [B]

1. **Resolve the profile ARN.** `POST https://management.{region}.kiro.dev/`, tried in each
   Kiro region in turn (`us-east-1`, then `eu-central-1`; `KIRO_REGION` first if set). See the
   region note below.
   - Headers: `Content-Type: application/x-amz-json-1.0`,
     `X-Amz-Target: AmazonCodeWhispererService.GetProfile`, plus the auth headers.
   - Body: `{}`.
   - Response: `{ "profile": { "arn": "arn:aws:…:<region>:…" } }`.
   - Pointers: `B:src/management.ts:183-207`, `B:src/oauth.ts:93-119`.
   - `ListAvailableProfiles` answers **403 "Unsupported token type"** for `ksk_` keys, so do not
     use it (`B:src/management.ts:15-19`, `B:CHANGELOG.md:60`).
   - An env override `KIRO_PROFILE_ARN` takes precedence in B (`B:src/management.ts:89-95`).
     Optional for us.
2. **List models.** `GET https://management.{region}.kiro.dev/List-Available-Models`
   - Query: `origin=KIRO_CLI`, `profileArn=<arn>`.
   - Headers: `Accept: application/json` plus auth.
   - `{region}` is the profile ARN's own region. B pins it to `us-east-1` for API keys
     (`B:src/management.ts:370-372`); that is wrong for keys issued elsewhere.

**Region note — observed live 2026-11-05, supersedes [B].** API keys are region-scoped, as A says
(`A/README.md:81-83`). A real `eu-central-1` key got
`400 {"__type":"com.amazon.kiro.controlplane#AccessDeniedException","message":"Invalid token"}`
from `GetProfile` in `us-east-1` and `200` with an `eu-central-1` profile ARN from `eu-central-1`.
`List-Available-Models` in `eu-central-1` then returned the catalog. So:

- an "Invalid token" in one region means "try the next region", not "bad key";
- only when every region rejects the key is it treated as invalid;
- the catalog and the runtime host both follow the profile ARN's region.

The live response also carries fields not listed in §2.3: `profile.optInFeatures`
(`apiKeys.toggle`, `modelConfiguration.allowlistedModels`) and, on catalog models,
`availableOrigins`, `modelProvider`, `promptCaching`, `rateUnit`. A model id `auto` exists.
   - Pointers: `B:src/management.ts:107-134,335-358`.

### 2.2 Transport Q [A]

`POST https://q.{region}.amazonaws.com/`

- Headers: `Content-Type: application/x-amz-json-1.0`, `Accept: application/json`,
  `X-Amz-Target: AmazonCodeWhispererService.ListAvailableModels`, plus the auth headers.
- Body: `{"origin":"AI_EDITOR"}`.
- The target prefix is `AmazonCodeWhispererService`, **not** `…StreamingService`. The
  streaming prefix answers `UnknownOperationException` (`A:src/kiro/discover.ts:17-23`).
- `origin` filters the result server-side. It must equal the origin used for chat, or we may
  advertise models chat cannot use (`A:src/kiro/discover.ts:163-166`).
- Pointer: `A:src/kiro/discover.ts:149-167`.

### 2.3 Response shape

```jsonc
{
  "defaultModel": { /* Model */ },             // [A] A:src/kiro/discover.ts:38-41
  "models": [
    {
      "modelId": "claude-sonnet-4.6",          // [BOTH] dot-form version
      "modelName": "…",                        // [A]
      "description": "…",                      // [A]
      "supportedInputTypes": ["TEXT","IMAGE"], // [A] "IMAGE" means vision-capable
      "rateMultiplier": 1.3,                   // [A] credit multiplier, not USD
      "tokenLimits": { "maxInputTokens": 200000, "maxOutputTokens": 64000 }, // [BOTH]
      "additionalModelRequestFieldsSchema": { /* JSON Schema */ }            // [B] see §3.6
    }
  ]
}
```

Pointers: `A:src/kiro/discover.ts:28-41`, `B:src/management.ts:27-41`.

Rules:

- **Empty list.** Treat empty `models` as an error, never as "no models"
  [BOTH] (`A:src/kiro/discover.ts:192-198`, `B:src/management.ts:350-355`).
- **Fail closed.** Never fall back to a hardcoded catalog: models are entitlement-scoped
  [A] (`A:src/kiro/discover.ts:8-11`).
- **Model-ID mapping.** Kiro uses a dot form (`4.6`) and pi IDs use a dash form (`4-6`).
  Convert with `(\d)\.(\d)` ↔ `(\d)-(\d)` [BOTH] (`A:src/kiro/discover.ts:74-77`,
  `A:src/kiro/models.ts:55-64`, `B:src/models.ts:430,607-621`).
- **`-1m` long-context variants.** These are accepted on chat but never listed. A derives them
  only for listed bases (`A:src/kiro/discover.ts:64-72,108-130`). [A] and unverified. Phase 1
  should leave them out unless probed.
- **Missing defaults.** Use `contextWindow` = `maxInputTokens ?? 200000` and
  `maxTokens` = `maxOutputTokens ?? 8192` [A] (`A:src/kiro/discover.ts:102-103`).
- **Pricing.** Kiro bills credits (`rateMultiplier`), so pi `cost` is all zeros [A]
  (`A:src/kiro/discover.ts:98-101`).

### 2.4 Usage limits (credits)

**Request.** Same auth headers as §2.1, in the **profile ARN's region**. The request form is
[B] (`B:src/management.ts:43-48,379-405`); **API-key access and the response shape below were
observed live on 2026-11-05.**

```
GET https://management.{region}.kiro.dev/Get-Usage-Limits
    ?profileArn=<arn>&origin=KIRO_CLI&resourceType=CREDIT&isEmailRequired=false
Accept: application/json
```

**Response** (live, KIRO PRO plan, identifiers omitted):

```jsonc
{
  "nextDateReset": 1796083200,            // Unix SECONDS, not ms (= 2026-12-01T00:00Z)
  "daysUntilReset": null,
  "limits": null,
  "overageConfiguration": { "overageStatus": "DISABLED" },
  "subscriptionInfo": {
    "subscriptionTitle": "KIRO PRO",
    "type": "Q_DEVELOPER_STANDALONE_PRO",
    "overageCapability": "OVERAGE_CAPABLE",
    "upgradeCapability": "UPGRADE_INCAPABLE",
    "subscriptionManagementTarget": "MANAGE"
  },
  "usageBreakdownList": [{
    "resourceType": "CREDIT",
    "displayName": "Credit", "displayNamePlural": "Credits",
    "unit": "INVOCATIONS",
    "currentUsage": 8,  "currentUsageWithPrecision": 8,      // prefer *WithPrecision
    "usageLimit": 1000, "usageLimitWithPrecision": 1000,
    "currentOverages": 0, "currentOveragesWithPrecision": 0,
    "overageCap": 10000, "overageCapWithPrecision": 10000,
    "overageRate": 0.04, "overageCharges": 0, "currency": "USD",
    "nextDateReset": 1796083200,
    "bonuses": [], "overageCredits": [], "freeTrialInfo": null, "addOnMetadata": null,
    "dimensionType": null
  }],
  "userInfo": { "email": null, "userId": "<opaque id>" }
}
```

**Rules for clients:**
- **Pick the entry.** Read the `usageBreakdownList` entry whose `resourceType` is `CREDIT`.
  Prefer the `*WithPrecision` fields, which can be fractional; credits per request are
  fractional (§5.2 `meteringEvent`).
- **Unknown shapes.** The element shapes of `bonuses`, `overageCredits` and `freeTrialInfo`
  are not yet observed. Count them, but do not interpret them. [INFERRED]
- **Don't log identity.** Never surface `userInfo`.
- **Per-request cost.** A turn's own cost comes from `meteringEvent.usage` (§5.2), not from
  this endpoint.

---

## 3. Chat request (GenerateAssistantResponse)

### 3.1 Envelope

```jsonc
{
  "conversationState": {
    "chatTriggerType": "MANUAL",            // [BOTH]
    "agentTaskType": "vibe",                // [BOTH]
    "conversationId": "<uuid>",             // [BOTH] pi sessionId if present, else a random UUID
    "currentMessage": { "userInputMessage": UserInputMessage },
    "history": [ HistoryEntry, … ]          // [BOTH] omitted when empty
  },
  "agentMode": "vibe",                      // [BOTH]
  "profileArn": "arn:…",                    // [B] transport R only, required
  "additionalModelRequestFields": { … }     // [B] optional, see §3.6
}
```

Pointers: `A:src/kiro/stream.ts:167-177,415-432`, `B:src/stream.ts:225-236,990-1009`.
The `conversationId` source is [BOTH] (`A:src/kiro/stream.ts:291`, `B:src/stream.ts:732`).

### 3.2 Message types

```ts
UserInputMessage = {
  content: string;            // see invariant I7
  modelId: string;            // Kiro dot-form id; repeated on every user entry [BOTH]
  origin: "AI_EDITOR" | "KIRO_CLI";       // depends on transport, see §0
  images?: Image[];
  userInputMessageContext?: {
    toolResults?: ToolResult[];
    tools?: ToolSpec[];       // sent on currentMessage only [BOTH]
  };
}
AssistantResponseMessage = { content: string; toolUses?: ToolUse[] }
HistoryEntry = { userInputMessage: UserInputMessage } | { assistantResponseMessage: AssistantResponseMessage }
ToolSpec   = { toolSpecification: { name: string; description: string; inputSchema: { json: <JSON Schema> } } }
ToolUse    = { toolUseId: string; name: string; input: object }   // input is a parsed object, not a string
ToolResult = { toolUseId: string; status: "success" | "error"; content: [{ text: string }] }
Image      = { format: "png" | "jpeg" | "gif" | "webp"; source: { bytes: <base64 string> } }
```

All shapes above are [BOTH]: `A:src/kiro/transform.ts:32-73,128-145`, `B:src/transform.ts:17-48,187-199`.

- **Image `format`.** It is the MIME subtype (`image/png` → `png`). The list of accepted
  values is [INFERRED].
- **`assistantResponseMessage.reasoningContent`.** B notes this typed field exists in
  first-party Kiro but neither reference sends it (`B:src/transform.ts:273-276`). Treat it as
  [INFERRED] and do not send it.

### 3.3 System prompt

There is no system field. Prepend the system prompt (followed by `\n\n`) to the **first** user
message in the conversation, whether that is in history or the current message [BOTH]
(`A:src/kiro/transform.ts:154-155,185-188`, `A:src/kiro/stream.ts:396-398`,
`B:src/transform.ts:223-226`).

### 3.4 Splitting pi messages into history and currentMessage [BOTH]

Pointers: `A:src/kiro/transform.ts:157-177`, `B:src/transform.ts:210-217`.

1. Drop assistant messages whose `stopReason` is `error` or `aborted`
   (`A:src/kiro/transform.ts:20-28`, `B:src/transform.ts:107-115`).
2. Walk back from the end over trailing `toolResult` messages. If the anchor is an assistant
   message **with** tool calls, the current turn starts at that assistant. Otherwise it starts
   right after.
3. Build the current message from what is left:
   - **Trailing user message.** `content` is its text and `images` are its images.
   - **Trailing tool results.** They become `userInputMessageContext.toolResults`.
     - Their `content` is `""` in B (`B:src/transform.ts:336-346`, `B:CHANGELOG.md:102`).
     - A sends `"Tool results provided."` instead → see [CONFLICT] C2.
   - **Assistant-with-tool-calls anchor.** That assistant turn is appended to history and its
     results form the current message (`A:src/kiro/stream.ts:310-371`).
4. **Consecutive user turns** in history are merged into one entry. Contents are joined with
   `\n\n`; B joins **only non-empty** sides (`B:src/transform.ts:239-246`).
5. **Consecutive tool results** are batched into one carrier entry. If the previous entry is a
   user entry, they merge into it (`A:src/kiro/transform.ts:239-295`,
   `B:src/transform.ts:296-348`).
6. **Tool-result images** move onto the carrying user entry's `images`. This is [BOTH].
7. **pi `developer` messages** are lowered to user messages [B] (`B:src/transform.ts:50-55,114`).

### 3.5 Tools

- **Mapping.** Each pi tool becomes a `toolSpecification` whose `inputSchema.json` is the
  tool's JSON Schema [BOTH].
- **Catalog must cover history.** If history mentions a tool name that is missing from the
  current `tools`, Kiro answers `400 Improperly formed request`. B synthesizes placeholder
  specs for those names [B] (`B:src/stream.ts:881-893`).
- **`toolUseId` format.** Must match `^[a-zA-Z0-9_.:-]{1,64}$`. Remap any other ID
  deterministically, for example `pi_` plus a truncated SHA-256, and apply the same mapping to
  uses and results [B] (`B:src/transform.ts:93-105`, `B:CHANGELOG.md:79`).
- **Tool-result truncation.** Both truncate results longer than 250,000 characters in the
  middle (`A:src/kiro/transform.ts:77-90`, `B:src/transform.ts:57,87-91`). The *server*
  limit is [INFERRED]; this is a client choice.

### 3.6 Thinking / reasoning hints

**Text directive [BOTH].** When reasoning is requested, prepend this to the system prompt:

```
<thinking_mode>enabled</thinking_mode><max_thinking_length>N</max_thinking_length>
```

Budget per pi level:

| pi level | N |
|---|---|
| minimal / low | 10000 |
| medium | 20000 |
| high | 30000 |
| xhigh / max | 50000 |

Pointers: `A:src/kiro/stream.ts:274-289`, `B:src/stream.ts:136-143,704-707`. A maps only
`xhigh` to 50000; B also maps `max` to 50000 (`B:CHANGELOG.md:14`).

**Structured effort [B], transport R.** Read it from the model's
`additionalModelRequestFieldsSchema`:

- If the schema has `properties.reasoning.properties.effort.enum`, send:
  ```json
  { "additionalModelRequestFields": { "reasoning": { "effort": "<value>" } } }
  ```
  This is used for GPT-family models.
- If the schema has `properties.output_config.properties.effort.enum`, send:
  ```json
  { "additionalModelRequestFields": { "output_config": { "effort": "<value>" },
                                       "thinking": { "type": "adaptive", "display": "summarized" } } }
  ```
  Include `display` only when `properties.thinking.properties.display.enum` contains
  `"summarized"`. This is used for Claude-family models.
- Clamp the effort to a value in the enum (`B:src/effort.ts:46-68,91-147`).
- B sends **both** the directive and the structured field, except when the field is
  `reasoning` (`B:src/stream.ts:700-707`, `B:CHANGELOG.md:126`).

**Reasoning output** arrives two ways:

- As `reasoningContentEvent` frames [B] (`B:src/event-parser.ts:234-241`,
  `B:CHANGELOG.md:120`).
- As inline `<thinking>…</thinking>` text in `assistantResponseEvent.content` [BOTH]
  (`A:src/kiro/thinking-parser.ts:5,13-19`, `B:src/thinking-parser.ts:11-19`). B also sees
  `<reasoning>` and `<thought>` tags.

**Thinking in history:** see [CONFLICT] C1.

---

## 4. Response stream framing

### 4.1 What the references do

- **A** never decodes the binary framing. It UTF-8-decodes the raw bytes and scans for known
  JSON prefixes such as `{"content":` and `{"toolUseId":` (`A:src/kiro/event-parser.ts:126-224`).
  This works only because event payloads are JSON. It is fragile: a payload byte pattern or a
  multi-byte character split across chunks can misparse. **We will not do this.**
- **B** decodes with the AWS Smithy event-stream marshaller and routes on headers
  (`B:src/stream.ts:148-151,1299-1363`).
- Neither reference contains a hand-written decoder. We write our own (no dependency), based
  on the public AWS event-stream format below.

### 4.2 Binary message layout [INFERRED, from the public AWS event-stream spec]

All integers are big-endian.

```
+--------------------+--------------------+--------------------+
| total_length  u32  | headers_length u32 | prelude_crc   u32  |   prelude, 12 bytes
+--------------------+--------------------+--------------------+
| headers (headers_length bytes)                               |
+--------------------------------------------------------------+
| payload (total_length - headers_length - 16 bytes)           |
+--------------------------------------------------------------+
| message_crc u32                                              |
+--------------------------------------------------------------+
```

- **`prelude_crc`** is the CRC-32 (IEEE 802.3 / zlib polynomial `0xEDB88320`, reflected) of the
  first 8 bytes.
- **`message_crc`** is the CRC-32 of every byte from offset 0 to `total_length - 4`.
- **Minimum size.** `total_length` is at least 16.
- **Decoder rules:**
  - Reject `headers_length > total_length - 16`.
  - Enforce a sane maximum `total_length`. 16 MiB is the AWS SDK convention [INFERRED].
  - Treat any CRC mismatch as a fatal stream error. Never skip ahead to resync.
  - Buffer across chunk boundaries. A frame may span many network chunks, and one chunk may
    hold many frames.
  - Decode the payload as UTF-8 only after the frame is complete.

Header encoding (repeat until `headers_length` bytes are used):

```
name_len u8 | name (utf8, name_len bytes) | value_type u8 | value
```

| type | meaning | value encoding |
|---|---|---|
| 0 | bool true | (none) |
| 1 | bool false | (none) |
| 2 | byte | i8 |
| 3 | short | i16 |
| 4 | integer | i32 |
| 5 | long | i64 |
| 6 | byte array | u16 length + bytes |
| 7 | string | u16 length + utf8 |
| 8 | timestamp | i64 ms since epoch |
| 9 | uuid | 16 bytes |

Reject an unknown type as fatal.

### 4.3 Headers Kiro sends

| Header | Values | Status |
|---|---|---|
| `:message-type` | `event` or `exception`; `error` is possible ([INFERRED], AWS convention) | `event`/`exception` [B] (`B:.agents/skills/verify-pi-provider-kiro/scripts/fake-kiro.mjs:138-151`, `B:src/stream.ts:1324`) |
| `:event-type` | event name, see §5 | [B] (`fake-kiro.mjs:138`, `B:src/event-parser.ts:13-27`) |
| `:exception-type` | error member name or exception class name | [B] (`fake-kiro.mjs:149`, `B:src/event-parser.ts:75-94`) |
| `:content-type` | `application/json` | [B] (`fake-kiro.mjs:140,151`) |
| `:error-code`, `:error-message` | on `:message-type: error` frames | [INFERRED] (AWS convention) |

The payload of `event` and `exception` frames is a JSON object [BOTH].

### 4.4 Transport Q note

A sends `Accept: application/json` but still receives an event-stream body
(`A:src/kiro/event-parser.ts:5-8`). Whether that body carries the same `:event-type` headers
as transport R is [INFERRED]. A's prefix list suggests the payloads match.

---

## 5. Stream events

Route on `:event-type`; never sniff by field shape (`B:CHANGELOG.md:64`).

### 5.1 Content and tool events

**`assistantResponseEvent`** (status [BOTH])

- Payload: `{ "content": string }`.
- Text delta. It may contain inline `<thinking>` tags (§3.6).
- A drops a chunk equal to the previous chunk (`A:src/kiro/stream.ts:649-651`); B does not.
  [A], unexplained, and Phase 1 should **not** dedupe without evidence.

**`toolUseEvent`** (status [BOTH])

- Payload: `{ "toolUseId", "name", "input"?: string, "stop"?: bool }`.
- One call is split across frames:
  - First frame: `name` + `toolUseId` (+ input fragment).
  - Continuation frames: `input` only.
  - Last frame: `stop: true`.
- Concatenate the `input` strings and JSON-parse once `stop` arrives or the stream ends.
- A different `toolUseId` closes the previous call.
- An empty input means `{}`.
- If the input does not parse, drop the call and report it.
- Pointers: `B:src/event-parser.ts:148-167`, `B:src/stream.ts:1475-1495`,
  `A:src/kiro/stream.ts:184-209,678-701`.

**`reasoningContentEvent`** (status [B])

- Payload: `{ "text"?, "signature"?, "redactedContent"? }`.
- `text` is a thinking delta.
- `signature` closes the thinking block.
- `redactedContent` is opaque.
- Pointers: `B:src/event-parser.ts:234-241`, `B:src/stream.ts:1438-1457`.

### 5.2 Usage and stop events

**`contextUsageEvent`** (status [BOTH])

- Payload: `{ "contextUsagePercentage": number }`.
- Percent of the context window.
- Pointers: `B:src/event-parser.ts:244-247`, `A:src/kiro/stream.ts:643-647`.

**`metadataEvent`** (status [B]; A expects `{usage:{inputTokens,outputTokens}}` instead)

- Payload:
  ```
  { "tokenUsage": { uncachedInputTokens, outputTokens, totalTokens,
                    cacheReadInputTokens, cacheWriteInputTokens,
                    contextUsagePercentage, normalizedTokenUsage },
    "stopReason"?: string, "stopDetails"?: object }
  ```
- May be split across several frames; merge them.
- `stopReason` values are listed in §5.4.
- Pointers: `B:src/event-parser.ts:37-57,169-189`, `B:src/stream.ts:1496-1507`;
  A's shape is at `A:src/kiro/event-parser.ts:112-121`.

**`meteringEvent`** (status [B])

- Payload: `{ "usage": number, "unit"?, "unitPlural"? }`.
- `usage` counts **credits, not tokens**. Never map it to token usage.
- Pointer: `B:src/event-parser.ts:250-255`.

### 5.3 Other events and errors

**`followupPrompt`** (status [A])

- A recognises it by shape only. Ignore it.
- Pointer: `A:src/kiro/event-parser.ts:96-98`.

**`codeReferenceEvent`, `documentCitationEvent`, `toolResultEvent`** (status [B])

- Known but unused. Ignore them.
- Pointer: `B:src/event-parser.ts:267-271`.

**Error members** (status [B])

- Members and their exception classes:
  - `error` → `InternalServerException`
  - `throttlingError` → `ThrottlingException`
  - `validationError` → `ValidationException`
  - `serviceUnavailableError` → `ServiceUnavailableException`
- Normally delivered as `:message-type: exception` with the name in `:exception-type`. The
  name may be the member name **or** the class name.
- Payload: `{ message, reason?, retryAfterMilliseconds? }`.
- Classify from the header even when the body is not JSON.
- Pointers: `B:src/event-parser.ts:59-118,297-302`, `B:src/stream.ts:1324-1360`.

**Unknown `:event-type`**

- Ignore it and log the key at debug level. Do not fail the stream.
- Pointer: `B:src/event-parser.ts:215-227,272-281`.

### 5.4 Stop-reason mapping

**When `metadataEvent.stopReason` is present** [B] (`B:src/stream.ts:1714-1748`):

| Kiro `stopReason` | pi result |
|---|---|
| `END_TURN` | `stop` |
| `TOOL_USE` | `toolUse` if at least one call parsed, else `stop` |
| `MAX_TOKENS` | `length` |
| `MODEL_CONTEXT_WINDOW_EXCEEDED` | error `context_length_exceeded` |
| `CONTENT_FILTERED` | error; drop any tool calls and do **not** retry |
| `PAUSE_TURN` | error (continuation is not supported) |

**When it is absent** [BOTH]: `toolUse` if calls were emitted, else `stop` if a
`contextUsageEvent` arrived, else `length` (`A:src/kiro/stream.ts:797-804`,
`B:src/stream.ts:1747`).

**Degenerate turns** [BOTH] (`A:src/kiro/stream.ts:777-795`, `B:src/stream.ts:1711-1718`):

- **Empty turn:** no text and no tool calls, and no explicit stop reason. Retry it.
- **Echo turn:** the whole text matches `^\s*(continue|\.+)\s*$`. B retries it. The echo rule
  is [B].

---

## 6. Conversation invariants

These are the seven rules first-party Kiro Agent enforces. They are listed in
`B:src/history-validator.ts:22-43` and are [B].

| ID | Rule | Rejection seen on the wire |
|---|---|---|
| I1 `STARTS_WITH_USER_MESSAGE` | The first entry is a user entry, and not a bare tool-result carrier | — |
| I2 `ENDS_WITH_USER_MESSAGE` | history + currentMessage ends on a user entry (always true, since currentMessage is a user entry) | — |
| I3 `ALTERNATING_MESSAGES` | No two adjacent user entries and no two adjacent assistant entries | — (B says the API *tolerates* non-alternation, `B:src/stream.ts:909-910`; both references merge anyway) |
| I4 `TOOL_USES_AND_RESULTS` | An assistant entry with `toolUses` is followed by a user entry whose `toolResults` IDs exactly equal the `toolUses` IDs | `400 TOOL_USE_RESULT_MISMATCH` ("tool_use ids were found without tool_result blocks immediately after") (`B:src/history-validator.ts:59-67`, `B:CHANGELOG.md:100`) |
| I5 `TOOL_RESULTS_AND_NO_USES` | A user entry with `toolResults` must directly follow an assistant entry with `toolUses` | `TOOL_USE_RESULT_MISMATCH` |
| I6 `TOOL_RESULTS_ORPHAN_IDS` | No result ID is missing from the preceding `toolUses`, and no ID is duplicated | `TOOL_USE_RESULT_MISMATCH` |
| I7 `NON_EMPTY_USER_MESSAGE` | Every user entry has non-blank `content` **or** at least one `toolResult` | `400 REQUEST_BODY_INVALID` (`B:CHANGELOG.md:103`, `B:src/transform.ts:59-78`) |

Additional constraints, each [B] unless marked:

- **I8.** Every tool name referenced in history must appear in `currentMessage…tools`, or the
  request gets `400 Improperly formed request` (`B:src/stream.ts:881-885`).
- **I9.** `toolUseId` must match `^[a-zA-Z0-9_.:-]{1,64}$`, or the request gets
  `400 REQUEST_BODY_INVALID` (`B:src/transform.ts:93`, `B:CHANGELOG.md:79`).
- **I10.** On transport R, the region in `profileArn` must match the runtime host region, or
  the request gets `400 {"message":"Improperly formed request."}` (`B:src/endpoints.ts:52-58`,
  `B:CHANGELOG.md:44`).
- **I11.** Strip unpaired UTF-16 surrogates from text (`B:src/transform.ts:80-85`). Why the
  server needs this is [INFERRED]; most likely its JSON parser rejects them.
- **I12.** Repair the conversation before sending; never send something we know is invalid
  (`B:src/history-validator.ts:274-412`, `B:src/stream.ts:912-989`). The repair steps:
  1. Drop leading non-user entries and leading bare carriers.
  2. Merge adjacent tool-only carriers.
  3. Strip orphan and duplicate results.
  4. Add a synthetic `status:"error"` result for every unanswered use.
  5. Put a neutral placeholder on a user entry that is still empty.
  - Run it on history **plus** currentMessage, then split them again.
  - Before any of this, move a displaced result next to the call that issued it
    (`B:src/transform.ts:117-164`).
- **I13.** Client-side size guards. These are client heuristics, not server limits:
  - B fails locally when the JSON size of history exceeds `850000 × contextWindow / 200000`
    characters (`B:src/history.ts:5-7,100-105`, `B:src/stream.ts:770`).
  - B keeps only the newest image-bearing history turn, and only if it is at most 512 KiB of
    base64 (`B:src/history.ts:8-37`).

---

## 7. Errors and retry policy

### 7.1 HTTP errors (before the stream starts)

Kiro's error body is usually `{"message": "...", "reason": "<CODE>"}`. Classify on the parsed
`reason` first and fall back to a substring scan [B] (`B:src/errors.ts:65-90`,
`B:src/retry.ts:46-57`).

| Status | Code / marker | Meaning | Retry? | Status / pointer |
|---|---|---|---|---|
| 400 | `REQUEST_BODY_INVALID` ("Improperly formed request.") | Malformed body (I7–I10) | **No.** This is a bug; surface it. It is not a context overflow, see C3 | [B] `B:src/retry.ts:140-146` |
| 400 | `TOOL_USE_RESULT_MISMATCH` | I4–I6 broken | No (repair should have prevented it) | [B] `B:src/history-validator.ts:59-62` |
| 400 / 413 | `CONTENT_LENGTH_EXCEEDS_THRESHOLD`, prose "Input is too long", or bare 413 | Context too large | No. Report it as `context_length_exceeded` so pi compacts | [BOTH] `A:src/kiro/stream.ts:64,72-74`, `B:src/retry.ts:129-134,200-203` |
| any (seen as 429) | `MONTHLY_REQUEST_COUNT` | Quota exhausted | **Never.** The error must not look like a generic 429 to pi's outer retry | [BOTH] `A:src/kiro/stream.ts:65`, `B:src/retry.ts:135`, `B:CHANGELOG.md:233` |
| any | `INSUFFICIENT_MODEL_CAPACITY` | Model capacity | Yes: up to 3 attempts, delay `5s·2^n` capped at 30s; then surface it as non-retryable | [BOTH] `A:src/kiro/stream.ts:60-62,497-512`, `B:src/stream.ts:1088-1101` |
| 429 | `USER_REQUEST_RATE_EXCEEDED` | Short-window throttle | Yes, within the retry budget. Wait for `retry-after-ms`, `retry-after` (seconds or HTTP date), or `x-ratelimit-reset-after`; fallback 10s, cap 10s | [B] `B:src/retry.ts:59-111`, `B:src/stream.ts:1077-1119` |
| 429 / 5xx | other | Generic | B leaves these to pi's outer retry (`B:CHANGELOG.md:229`) | [B] |
| 401 / 403 | `AccessDeniedException` / "Invalid token" / "bearer token … is invalid" | Bad key, or key used in the wrong region | No. Tell the user to check the key and region. (B's token-refresh retry does not apply to static API keys) | [A] `A:src/kiro/stream.ts:517-521`, `A/README.md:81-83`; [B] `B:src/oauth.ts:112-114` |
| 403 | "Unsupported token type" | `ListAvailableProfiles` called with a `ksk_` key | No; use GetProfile instead | [B] `B:src/management.ts:15-19` |
| 400 | `UnknownOperationException` | Wrong `X-Amz-Target` prefix (transport Q) | No | [A] `A:src/kiro/discover.ts:17-21` |
| 400 | `__type: AccessDeniedException`, message "Invalid token" | Bad or revoked `ksk_` key on `GetProfile`. **Auth failure despite the 400 status**: classify by exception type, not status | No | **Observed live 2026-11-05** (bogus key against `management.us-east-1.kiro.dev`) |

### 7.2 Mid-stream errors

- **Exception frames (§5.3).** Retry within the shared budget of 3. The delay is
  `1s·2^n`, capped at 10s, but a `retryAfterMilliseconds` value wins (also capped at 10s, and
  an explicit `0` means retry now). Pointers: [B] `B:src/retry.ts:159-189`,
  `B:src/stream.ts:1532-1573`; [BOTH] for the basic retry, `A:src/kiro/stream.ts:720-739`.
- **Do not retry `ValidationException`.** [INFERRED]: it is deterministic. B retries it today;
  we deliberately differ.
- **On retry, throw away partial output.** Both references reset `content` (and B also resets
  usage) before retrying (`A:src/kiro/stream.ts:731-733`, `B:src/stream.ts:1566`).
- **Once deltas have reached pi, a retry duplicates visible output.** [INFERRED] risk. Phase 1
  should only retry before the first emitted delta, or restart cleanly.

### 7.3 Timeouts (client policy, [BOTH] unless noted)

| Timeout | Value | Status / pointer |
|---|---|---|
| Response headers | 90 s | [B] `B:src/retry.ts:10-11` |
| First event | 90 s, overridable per model | `A:src/kiro/stream.ts:55`, `B:src/retry.ts:9` |
| Idle between events | 300 s | `A:src/kiro/stream.ts:56` |
| Model discovery | 15 s | [A] `A:src/kiro/discover.ts:26` |

- **Clear the losing timer** of every race. Otherwise it keeps the process alive
  (`B:CHANGELOG.md:42`).
- **On abort, cancel the body reader** (`B:CHANGELOG.md:62`).

---

## 8. Conflicts between the references

- **C1. Thinking blocks in history.**
  - A writes `<thinking>…</thinking>` into the assistant `content` (`A:src/kiro/transform.ts:217-218`).
  - B drops them, because first-party Kiro sends text blocks only (`B:src/transform.ts:264-277`,
    `B:CHANGELOG.md:99`).
  - **We follow B:** we drop them, but keep a thinking-only turn as `content: ""` so
    alternation holds.
- **C2. Content of tool-result turns.**
  - A sends `"Tool results provided."` and appends it to real user text
    (`A:src/kiro/transform.ts:271,288`).
  - B sends `""` and has a recorded 200 response for it (`B:src/transform.ts:66-70`).
  - **We follow B.** We use the placeholder `"Please proceed with the task."` only for a turn
    with neither text nor results.
- **C3. "Improperly formed" handling.**
  - A treats it as context-too-large (`A:src/kiro/stream.ts:64`).
  - B shows it is `REQUEST_BODY_INVALID` and that treating it as too-large causes compaction
    loops (`B:CHANGELOG.md:103`).
  - **We follow B.**
- **C4. Usage event shape.**
  - A expects `{usage:{inputTokens,outputTokens}}`.
  - B uses `metadataEvent.tokenUsage`.
  - **We follow B**, because it is modeled and has `:event-type` routing.
- **C5. Transport.** See §0. **Awaiting your decision.**

---

## 9. Open items Phase 1 must probe live before relying on them

1. **Transport.** Does transport R (or Q) accept our `ksk_` key end to end? This decides C5.
2. **User-Agent.** Is the impersonating User-Agent required, or does an honest UA work?
3. **Event headers on transport Q.** If we choose Q, does it send the same `:event-type`
   headers?
4. **`-1m` variants.** Are they accepted for API-key accounts?
5. **Image formats.** Exact accepted image `format` values and size limits.
6. **Error frames.** Does `:message-type: error` (as opposed to `exception`) ever appear?

### Live observations so far

- **2026-11-05, real key.** Region scoping confirmed; see the §2.1 region note. Discovery
  (`GetProfile` + `List-Available-Models`) works end to end in `eu-central-1`.
- **2026-11-05, real key, first chat.**
  - Call: `pi --model kiro-secure/claude-haiku-5-5 -p "Reply with just the word: ok"`
    returned `ok` through `runtime.eu-central-1.kiro.dev/generateAssistantResponse`.
  - Transport: this confirms transport R end to end (§9 item 1).
  - User-Agent: the honest User-Agent `pi-kiro-secure/0.1.0` is accepted, so impersonation is
    not needed (§9 item 2).
  - Framing: the binary decoder handled the real framing.
  - Still open: tool calls, reasoning events, images, and the error-frame question
    (§9 items 4–6).
  - The catalog reported 64K max output for every model and 1M context for most Claude
    models.
- **2026-11-05, bogus key.** `POST https://management.us-east-1.kiro.dev/` with
  `X-Amz-Target: AmazonCodeWhispererService.GetProfile`, `tokentype: API_KEY` and a bogus
  `ksk_` key returned `400 {"__type":"…#AccessDeniedException","message":"Invalid token"}`.
  - This confirms the host exists, the target is routed, and API-key tokens are recognised
    as such.
  - It does not yet confirm a working chat call. Items 1–6 above remain open until a real key
    is available.

Out of scope for this document: pi's provider/stream contract. Phase 1 will take it from the
installed `@earendil-works/pi-ai` type definitions, not from the references.
