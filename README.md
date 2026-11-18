# pi-kiro-secure

A [pi](https://pi.dev) provider for Kiro using a Kiro API key (`ksk_…`). It is written from
scratch against the reviewed spec in [`docs/PROTOCOL.md`](docs/PROTOCOL.md). No code is
taken from other Kiro packages.

## Use

Install it as a package with `pi install /path/to/pi-kiro-secure`, or load it for one run with
`pi -e /path/to/pi-kiro-secure/src/index.ts`. Then give pi your key (below) and pick a model:

```bash
pi --list-models kiro-secure
pi --model kiro-secure/haiku -p "hello"
```

### Give pi your key

pi resolves the key, so it can come from wherever pi reads credentials. The recommended way is
a command in `~/.pi/agent/auth.json` that prints the key from your OS secret store. pi runs it
when the key is first needed and keeps the result in memory only; the key is never written to
disk.

```json
{
  "kiro-secure": { "type": "api_key", "key": "!<command that prints the key>" }
}
```

| Secret store | Command |
|---|---|
| macOS Keychain | `security find-generic-password -a "$USER" -s kiro-api-key -w` |
| Linux (libsecret) | `secret-tool lookup service kiro-api-key` |
| `pass` (any OS) | `pass show kiro-api-key` |
| Windows (SecretManagement) | `powershell -NoProfile -Command "Get-Secret kiro-api-key -AsPlainText"` |
| 1Password | `op read op://Private/kiro/credential` |
| Bitwarden | `bw get password kiro-api-key` |

Other ways:

- **`/login` in pi:** stores the key itself in `auth.json` (a plain file, mode 0600).
- **`KIRO_API_KEY`:** the environment variable. This only reaches processes started from a shell
  that set it, so subagents and apps launched elsewhere may not see it; `auth.json` avoids that.

### Models in every pi process

The model list is kept in pi's model store (`~/.pi/agent/models-store.json`), so any pi process
lists the Kiro models at startup without a network call: subagents, scripts and other apps
included. The store holds model facts only (IDs, names, limits, input types, thinking levels),
never the key, and never your profile ARN, which contains your AWS account ID. The ARN is looked
up once per process, on the first chat request, and kept in memory.

- **First use:** when the store has no Kiro models, the extension fills it (two requests:
  `GetProfile`, then the model list). `PI_OFFLINE=1` / `--offline` skips this.
- **Refresh:** `pi update --models` fetches the list again, for example after a plan change or a
  new key.

API keys are region-scoped. The extension finds your key's region by itself (`us-east-1`,
then `eu-central-1`). Set `KIRO_REGION=eu-central-1` to try that region first and skip one
request.

**Setting a key is opt-in.** The extension never stops pi from starting:

- **No key anywhere:** no Kiro models appear and nothing is sent anywhere.
- **Key set but unusable** (wrong format, rejected, network failure): pi keeps the models it
  had stored (or lists none) and shows a warning when an interactive session starts. Discovery
  still fails closed: there is never a guessed model list.

## Check your credits

Run `/kiro-usage` inside pi. It shows something like:

```
Kiro KIRO PRO: 8 / 1000 credits used (0.8%) · resets 2026-12-01 · overage off
```

It uses the same key pi resolves. It is read-only, and makes one request each time you run it.

## Design choices that differ from other Kiro providers

- **Honest User-Agent.** Requests identify as `pi-kiro-secure/<version>` instead of
  impersonating the Amazon Q CLI.
- **Real event-stream decoding.** Every frame's two CRC-32 checksums and its length bounds are
  verified. A corrupted stream is a hard error, never skipped over.
- **No credential leakage.** Error text is scrubbed of `ksk_` keys, bearer tokens and JWTs.
  Caller-supplied headers cannot override `Authorization`, `tokentype`, `Content-Type` or
  `Accept`.
- **Safe retries.** A turn is retried only before any output has reached pi, so retries never
  duplicate visible text. `ValidationException` and malformed-request (400) errors are never
  retried.
- **Repair before sending.** The conversation is repaired before it is sent (PROTOCOL.md §6).
  Unanswered tool calls get an explicit "interrupted" result instead of a request Kiro would
  reject.
- **Malformed tool arguments are kept.** A call whose arguments don't parse is kept with
  `argumentsError`, so the model can see why it failed.

## Develop

```bash
pnpm install   # dev tools only: typescript, @types/node
pnpm link-pi   # symlink pi's own @earendil-works packages for tests/types
pnpm typecheck
pnpm test
```

## Status

The unit and integration tests run against local fixtures.

Verified live: key lookup in both regions, model discovery, the model store, a plain chat
request, the honest User-Agent, and `/kiro-usage`. Not yet exercised live: tool calls,
reasoning effort and thinking events, image input, and `:message-type: error` frames.
