# pi-gwdg — AGENTS.md

[pi](https://github.com/earendil-works/pi) extension providing a custom LLM
provider for **GWDG AI services** (OpenAI-compatible, `https://chat-ai.academiccloud.de/v1`).

> **General usage, commands, configuration, environment variables, and
> cross-extension rate-limit events** → [README.md](./README.md)

---

## Project Structure

```
pi-gwdg/
├── AGENTS.md                       ← this file
├── README.md                       ← user-facing docs (commands, config, env vars)
├── docs/                           ← detailed docs, see below
├── package.json                    ← pi: {extensions: ["./extensions/index.ts"]}, type: module
├── tsconfig.json                   ← target es2022, module es2022, bundler
├── extensions/
│   ├── index.ts                    ← Extension entry: provider registration, events, commands, fetch interceptor
│   ├── models.ts                   ← Model discovery (API fetch + cache)
│   ├── rate-limits.ts              ← Rate limit state tracking (module-level singleton), types
│   ├── shared-state.ts             ← Cross-session rate-limit state over a tmpfs file (transport for the per-process singleton)
│   ├── config.ts                   ← Config loading (global + project JSON merge), env overlay, model overrides
│   ├── debug.ts                    ← Shared debug logging (TUI-aware, respects config/env) + file tracer
│   └── ambient.d.ts                ← Ambient type declarations for external modules
├── tools/
│   ├── gwdg-sim-proxy.mjs          ← Zero-dep relay proxy for testing 429 handling against real upstream
│   └── verify-ratelimit-classification.mjs ← Stub-server checks for 429 / throttled-5xx / genuine-5xx handling
├── dist/                           ← Compiled JS output (tsc build target)
└── node_modules/                   ← Installed dependencies
```

## Key Architecture

Provider registration, event handlers, model mapping, config module, debug
logging, ambient types, and the command table are documented in
**[docs/architecture.md](./docs/architecture.md)**.

The rate-limit fetch interceptor, the rate-limit banner UI, the cancel-report /
auto-retry-suppression logic, the cross-session shared-state file format, and
the testing harnesses (status-classification checks, sim proxy, RPC mode, pty
driver) are documented in
**[docs/rate-limit-internals.md](./docs/rate-limit-internals.md)**.

## Development

### Build

```bash
npx tsc
```

TypeScript source files in `extensions/` are compiled to `dist/` (as configured
in `tsconfig.json`: `outDir: "dist"`, `rootDir: "extensions"`).

### Key Constraints

1. No custom `streamSimple` — uses built-in `openai-completions`.
2. No key rotation — single endpoint, single API key.
3. All imports use `@earendil-works/...` (not `@mariozechner/...`).
4. No `openai` dependency. 429 handling wraps `globalThis.fetch` (the realm-wide
   fetch the SDK uses) rather than patching the SDK — the extension's own `openai`
   copy would differ from pi-ai's, so a prototype patch would never fire.
5. Cache uses `getAgentDir()` from `@earendil-works/pi-coding-agent`.
6. API key ref: `apiKey: "$GWDG_API_KEY"`.
7. Config follows pi-search-hub pattern (global + project merge, TTL-guarded refresh).
8. `extensions/ambient.d.ts` provides ambient types so `tsc --noEmit` passes without `@types/node`.
9. All debug logging goes through `extensions/debug.ts`; config gating via `isDebugEnabled()`.
10. **`fetch` interceptor** (`installFetchInterceptor`) — symbol-guarded
    (`__gwdgFetchPatched`), scoped to the GWDG host, wrapped in `try/catch` for
    graceful degradation. On the wait path it performs an **abortable** delay and
    retries in-process (so ESC cancels immediately); on the cancel path it sets
    `x-should-retry: false`. `AbortError` is always rethrown from the wrapper's
    `try/catch` so cancellation propagates.
10a. **Quota harvesting is status-agnostic; the wait decision is not.** The
    interceptor stores the `x-ratelimit-*` snapshot from every response and
    renders the footer from it (GWDG sends the headers on all statuses but 401,
    and `after_provider_response` only ever sees 2xx, so the interceptor is the
    only layer that can keep an error-only run's footer honest). Entering the
    wait path is narrower: always for 429, for `>= 500` only when
    `isQuotaExhausted()` and only up to `MAX_THROTTLED_SERVER_ERROR_RETRIES`
    times per HTTP attempt. Do not widen this to 4xx (deterministic — a retry
    cannot help) and do not uncap the 5xx retries: a 5xx throttle is *inferred*,
    so a real outage during an exhausted window is indistinguishable from
    throttling and would loop forever.
10b. **Everything that acts on an *inferred* 5xx throttle stays cheap and local.**
    Three deliberate asymmetries, all reversible only with new evidence: the
    cancel path is 429-only (it asserts "quota exceeded" and suppresses every
    retry layer — too strong a claim for an inference, so a 5xx past the wait
    budget is returned untouched instead); the shared state file is published on
    429 only (a guess must not stall peer sessions); and the no-header wait
    fallback is `THROTTLED_SECOND_WINDOW_WAIT_SEC` (2s) rather than
    `DEFAULT_RATE_LIMIT_WAIT_SEC` (60s), because the signal that classified it
    was the generic per-second alias, which clears in about a second.
    `tools/verify-ratelimit-classification.mjs` locks all of this in.
11. **pi auto-retry suppression is GWDG-scoped** via the `message_end`
    errorMessage rewrite (which must keep the phrase "quota exceeded"), gated on
    `pendingRateLimitCancel`. It couples to pi-ai's private non-retryable regex
    list; verify against the installed pi version if retry behaviour on cancel
    regresses.
12. **Shared state is fail-open and advisory.** Every read/write in
    `shared-state.ts` swallows its own errors, and the pre-flight check only ever
    delays a request — it never cancels one and never blocks on a reset beyond
    `maxRateLimitWaitSec`. Nothing in the request path may become dependent on
    the file existing, being readable, or being truthful. Never write the API key
    into the payload or the filename (hash it), and never put the file somewhere
    world-writable such as `/dev/shm`.
13. **Never use `ctx.ui.setWorkingMessage` (or `setWorkingIndicator`) for
    extension state.** Both are single global slots with no ownership, so
    extensions overwrite each other and "restoring" resets to pi's default rather
    than the previous owner's value. Use keyed surfaces — `setWidget(key, …)`,
    `setStatus(key, …)` — which pi stores per key. `CANCEL_REPORT_MARKER` plays
    the same role for text we write into messages: it makes our own output
    recognisable so the `message_end`/`agent_end` fallback never re-reports it.

### Related Docs

- [README.md](./README.md) — commands, env vars, config files, cross-extension events
- [docs/architecture.md](./docs/architecture.md) — provider registration, events, model mapping, config, debug logging, commands
- [docs/rate-limit-internals.md](./docs/rate-limit-internals.md) — fetch interceptor, banner, cancel report, cross-session state, testing
- [docs/configuration.md](./docs/configuration.md) — env vars, config file schema, thinking level map
- [docs/rate-limiting.md](./docs/rate-limiting.md) — user-facing rate-limit behavior
- [docs/events.md](./docs/events.md) — cross-extension rate-limit event bus
- [GWDG SAIA docs](https://docs.hpc.gwdg.de/services/ai-services/saia/)
