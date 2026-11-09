# pi-kiro-secure

A [pi](https://pi.dev) provider for Kiro using a Kiro API key (`ksk_…`). It is written from
scratch against the reviewed spec in [`docs/PROTOCOL.md`](docs/PROTOCOL.md). No code is
taken from other Kiro packages.

## Use

```bash
export KIRO_API_KEY="ksk_…"
pi -e /path/to/pi-kiro-secure/src/index.ts --list-models kiro
```

Or install it as a package with `pi install /path/to/pi-kiro-secure`.

API keys are region-scoped. The extension finds your key's region by itself (`us-east-1`,
then `eu-central-1`). Set `KIRO_REGION=eu-central-1` to try that region first and skip one
request.

**At startup**, the extension does the following:

1. Resolves your key's profile with `GetProfile`.
2. Lists the models that key can use.
3. Registers them under the provider id `kiro-secure`.

**Setting the key is opt-in.** The extension never stops pi from starting:

- **No `KIRO_API_KEY`:** the extension stays dormant. No Kiro models appear, nothing is sent
  anywhere, and no message is shown.
- **Key set but unusable** (wrong format, rejected, network failure): no Kiro models are
  registered and pi shows a warning when an interactive session starts. Discovery still fails
  closed: there is never a guessed model list.

## Check your credits

Run `/kiro-usage` inside pi. It shows something like:

```
Kiro KIRO PRO: 8 / 1000 credits used (0.8%) · resets 2026-12-01 · overage off
```

This command is read-only, and only one request is made each time you run it.

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

Against the live service, only `GetProfile` with an invalid key has been exercised so far.
Before relying on this provider, run the probes in PROTOCOL.md §9 with a real key:

- **Transport R.** Chat end to end.
- **User-Agent.** That the honest User-Agent is accepted.
- **Error frames.** Whether `:message-type: error` frames ever appear.
