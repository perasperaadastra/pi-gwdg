# Architecture

> Back to [AGENTS.md](../AGENTS.md). For the rate-limit internals (fetch
> interceptor, cross-session state, banner UI, testing), see
> [rate-limit-internals.md](./rate-limit-internals.md).

## Project Structure

```
pi-gwdg/
├── AGENTS.md                       ← agent-facing docs, points here
├── README.md                       ← user-facing docs (commands, config, env vars)
├── docs/                           ← detailed docs (this directory)
├── package.json                    ← pi: {extensions: ["./extensions/index.ts"]}, type: module
├── package-lock.json               ← npm lockfile
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
│   └── gwdg-sim-proxy.mjs          ← Zero-dep relay proxy for testing 429 handling against real upstream
├── dist/                           ← Compiled JS output (tsc build target)
└── node_modules/                   ← Installed dependencies
```

## Provider Registration

| Aspect | Detail |
|--------|--------|
| Provider name | `gwdg` |
| API type | `openai-completions` (pi's built-in streaming — no custom `streamSimple`) |
| API key | `$GWDG_API_KEY` env var (never read or logged directly) |
| Base URL | Configurable (default `https://chat-ai.academiccloud.de/v1`) |
| Models | File cache first (TTL configurable, default 30d), then `GET /v1/models` |
| Cache path | `<getAgentDir()>/cache/pi-gwdg/models-cache.json` |
| Env var registration | `pi.registerEnvVar("GWDG_API_KEY", { description })` — guarded by feature detection |

## Events

| Event | Purpose | Sync/Async |
|-------|---------|------------|
| `after_provider_response` | Extract per-window rate-limit headers (`x-ratelimit-*-{minute,hour,day,month}`) from **successful** responses; update footer with remaining quota (auto-clear after `footerTimeoutSec`); emit event-bus events (`pi:rate-limits`); manage auto-clear timer. Ignores responses while the active model belongs to another provider (the event carries no provider — see [Provider scoping](./rate-limit-internals.md#provider-scoping)). 429 handling is done by the `fetch` interceptor (see [rate-limit-internals.md](./rate-limit-internals.md)). | Sync |
| `message_end` | Capture UI ctx; clear a stale rate-limit banner on any finalized assistant message; observe a terminal assistant `stopReason: "error"` (429) **from the GWDG provider** as a notification fallback; on the cancel path, rewrite the GWDG error message into the user-facing cancel report, which also suppresses pi's auto-retry (see [rate-limit-internals.md](./rate-limit-internals.md)). Returns `{ message }` to mutate the finalized message. | Sync |
| `agent_end` | Per-run fallback for the notification + banner clear (covers paths where `message_end` is not emitted for error outputs); provider-scoped like `message_end`. | Sync |
| `session_start` | Capture UI ctx early; install custom autocomplete provider for `/gwdg-settings <scope>` argument completion (`project`/`global`). | Async |
| `session_shutdown` | Cancel footer auto-clear + rate-limit banner timers; clear GWDG status indicator and banner widget; clear debug context. | Sync |

## Model Mapping

- Defaults: `contextWindow: 128000`, `maxTokens: 4096`, `reasoning: false`, `cost: all zero`.
- Vision heuristic: model id/name matches `image`, `gemma-4`, `mistral-medium`, `omni`, `qwen3.5`, `qwen3.6`.
- Per-model overrides from config (`modelOverrides`) can override `contextWindow`, `maxTokens`, `reasoning`, `input`, `thinkingLevelMap`.
- `thinkingLevelMap` maps pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to provider-specific values (string = supported, `null` = unsupported, omitted = default). Managed via `/gwdg-settings` override submenu or directly in config JSON.

## Config (`extensions/config.ts`)

- pi-search-hub pattern: global (`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg.json`) + project (`.pi/gwdg.json`) merge, module-level mutable state, TTL-guarded refresh (10s), env-var overlay.
- **Model overrides merge:** Merged additively — global overrides are the base, project overrides layer on top. An empty `{}` at either level does NOT wipe overrides from the other level.
- Env overlays: `PI_GWDG_DEBUG`, `PI_GWDG_HIDE_FOOTER`, `PI_GWDG_FOOTER_TIMEOUT`, `PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC`, `PI_GWDG_EMIT_RATE_LIMIT_EVENTS`, `PI_GWDG_SHARED_STATE`, `PI_GWDG_SHARED_STATE_DIR`, `PI_GWDG_SHARED_STATE_JITTER_MS`.
- `maxRateLimitWaitSec` (default 3600, clamped 0–86400 in `setSetting`; 0 = never wait): max seconds to wait for a 429 reset before cancelling. Read via `getMaxRateLimitWaitSec()`.
- `sharedRateLimitState` (default **true**): cross-session coordination on/off. Read via `isSharedRateLimitStateEnabled()`. Unlike the older opt-in flags, its env var is **tri-state** (`envBool`: `1`/`true`, `0`/`false`, unset) because a default-on setting needs an off switch too.
- `sharedStateDir` (default `""` = auto) / `sharedStateJitterMs` (default 1000, clamped 0–60000). Read via `getConfiguredSharedStateDir()` / `getSharedStateJitterMs()`.
- **Adding a setting touches five places** here — the `GwdgConfig` field (with an env-var doc comment), `getDefaultConfig()`, the `refreshConfig()` env overlay, a clamping branch in `setSetting()`, and a convenience accessor — plus, in `index.ts`, a `/gwdg-settings` item, an `applySettingChange` case, the persist-on-close `settings` object, and a `/gwdg-status` line. Omitting it from the persist object means the toggle applies live and is then silently lost on close.
- `setSetting(key, value, persistPath?)` — live-apply + optionally persist.
- `persistSettings(settings, persistPath)` — batch-persist (used by `/gwdg-settings` on close).
- `setModelOverride(modelId, fields, persistPath?)` — set/merge fields into a per-model override.
- `removeModelOverride(modelId, persistPath?)` — remove a per-model override entirely.
- `getOverrideModelIds()` — list model IDs that have overrides.
- `getModelOverride(modelId)` — get the override for a specific model.
- Footer auto-clear: cancellable `setTimeout` after `footerTimeoutSec` (default 60s, 0 = never). Each new response cancels the previous timer.
- Exported TypeScript types: `GwdgConfig`, `GwdgModelOverride`, `SettingValue`.

## Rate Limit Header Extraction (`extensions/rate-limits.ts`)

Per-window quotas from `x-ratelimit-*-{minute,hour,day,month}` headers. Each window's `reset`:
- `minute` — seconds until next minute boundary (`:00` seconds)
- `hour` — seconds until next hour boundary (`:00:00`)
- `day` — seconds until next midnight UTC
- `month` — seconds until 1st of next month, midnight UTC

**Exported types for cross-extension consumption:**
- `ProviderRateLimitEvent` — emitted on every provider response via `pi:rate-limits`
- `ProviderRateLimitedEvent` — emitted on 429 via `pi:rate-limited` (extends `ProviderRateLimitEvent` with non-null `retryAfter`)
- `RateLimitState`, `RateLimitWindows` — raw state types

**`extractRetryAfter`** checks `retry-after` header first, falls back to `ratelimit-reset`.

## Debug Logging (`extensions/debug.ts`)

- Shared debug logging module used by all other extension modules.
- Gated through `config.isDebugEnabled()` which respects both config file and `PI_GWDG_DEBUG` env var.
- In TUI mode, routes messages through `ctx.ui.notify()` (no flicker). In print/RPC/json mode, uses `console.log`.
- Supports printf-style format specifiers (`%d`, `%s`, `%j`, etc.).
- Module-level mutable ctx reference: `setDebugCtx(ctx)` / `clearDebugCtx()` called at event handler boundaries.

## Ambient Type Declarations (`extensions/ambient.d.ts`)

- Declares types for Node.js built-ins (`node:fs`, `node:path`, `node:fs/promises`, `node:os`, `node:crypto`, `process`) and external modules (`@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent`).
- Allows `tsc --noEmit` to pass without requiring `@types/node` or a fully-formed package.json in node_modules.
- Never loaded at runtime — only used by the TypeScript compiler.

## Commands

| Command | Handler | Arguments | Features |
|---------|---------|-----------|----------|
| `/gwdg-status` | Inline | None | Shows endpoint, API key status, active provider, model count, config summary, rate limits (per-window remaining + retry-after), rate-limited state |
| `/gwdg-info <model>` | Inline | model ID | Shows capabilities, context window, max output, reasoning, cost for a specific model |
| `/gwdg-models` | Inline | None | Lists all GWDG models grouped by capability (text / vision / embeddings) with tree formatting |
| `/gwdg-refresh` | Inline | None | Force-fetch models from API, re-read config, update cache, re-register provider |
| `/gwdg-simulate-ratelimit [seconds]` | Inline | reset seconds (default 30) | Drives `triggerRateLimitFeedback` with `willWait` computed from `maxRateLimitWaitSec` — exercises the countdown banner / cancel report + wait-vs-cancel without a real 429. Passes `simulated: true`, which wires the interrupt key to the banner (see [rate-limit-internals.md](./rate-limit-internals.md#cancel-key-detached-waits)); ESC clears the wait state (`clearRateLimitWait`, so `/gwdg-status` stops reporting a rate limit) and notifies |
| `/gwdg-settings [scope]` | Inline → TUI submenu | `project` (default) or `global` | Interactive TUI editor: hide footer, debug, footer timeout, cache TTL, max rate-limit wait, emit rate limit events + **model overrides submenu** (add/edit/delete per-model overrides with field-level editor for maxTokens, contextWindow, reasoning, input, thinkingLevelMap) |

### Autocomplete for `/gwdg-settings`

A custom autocomplete provider is installed via `session_start` → `ctx.ui.addAutocompleteProvider()`.
It overrides `shouldTriggerFileCompletion` to return `true` when the cursor is
in a `/gwdg-settings <arg>` context (the built-in provider incorrectly returns
`false` because `trim()` strips the trailing space). `getSuggestions` returns
`project` / `global` scope items.
