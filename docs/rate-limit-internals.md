# Rate-Limit Internals

> Back to [AGENTS.md](../AGENTS.md). For the user-facing behavior (config
> knobs, banner appearance, `/gwdg-status`), see
> [rate-limiting.md](./rate-limiting.md).

The extension wraps **`globalThis.fetch`** (a `fetch` interceptor installed at
provider registration, `installFetchInterceptor`) to observe and reshape
rate-limited responses before the OpenAI SDK acts on them.

**Background:** The `openai-completions` API type uses the OpenAI SDK internally.
The SDK throws on non-2xx HTTP responses (including 429) **before** the
`onResponse` callback is invoked, so `after_provider_response` never fires for a
429. The SDK is also built with no custom `fetch`, so it uses `globalThis.fetch`
— which pi installs (undici) and which we can wrap. Wrapping the realm-wide
`fetch` (rather than the SDK's own `openai` module) avoids the module-duplication
trap: the extension resolves its own `openai` copy, distinct from pi-ai's, so a
prototype monkey-patch on the extension's copy would never fire.

The wrapper is symbol-guarded (`__gwdgFetchPatched`) and scoped to the GWDG
provider host. Everything else passes through untouched.

## Rate-Limit Flow (fetch interceptor)

0. **Pre-flight** (`waitForSharedRateLimit`, before `originalFetch`): host-matched read of the cross-session state file. If a peer published a still-active reset that is within `getMaxRateLimitWaitSec()`, wait it out with the same `abortableDelay` + banner as the wait path. See [Cross-Session Rate-Limit State](#cross-session-rate-limit-state-extensionsshared-statets) below.
1. Response received from the GWDG API; the wrapper returns early unless the URL matches the provider host, so the loop below only ever sees GWDG traffic.
2. **Harvest on every status.** Extract `x-ratelimit-*-{minute,hour,day,month}` and store the `RateLimitWindows` in the module-level singleton (`setRateLimitState`) — unconditionally, before any rate-limit decision, and only when the parse yielded at least one window (so a header-less `401` cannot blank out a good snapshot). This is the **only** place a non-2xx snapshot is ever seen: the SDK throws before `onResponse`, so `after_provider_response` fires for 2xx only — which is also why the harvest renders the footer itself via `renderQuotaFooter` (shared with the `after_provider_response` handler; needs `feedbackCtx`, so it is a no-op until the first event has been seen). Then extract `retry-after`; emit `pi:rate-limited` (if `emitRateLimitEvents`).
2a. **Classify.** `429` → always a rate limit. `>= 500` → a rate limit only if `isQuotaExhausted(headers, windows)`, capped at `MAX_THROTTLED_SERVER_ERROR_RETRIES` (3) **per HTTP attempt** (pi's agent-session retry can start a fresh attempt with a fresh count); past the cap the loop `break`s and the response is returned untouched. Anything else `break`s immediately. `isQuotaExhausted` checks the generic `ratelimit-remaining` alias **and** the parsed windows, because on a throttled 5xx the alias (which tracks GWDG's per-second window, not in `WINDOW_PATTERNS`) is the only exhaustion signal present.
3. Compute the **true** provider reset (uncapped): `retry-after` → smallest exhausted window reset → fallback. The fallback is `THROTTLED_SECOND_WINDOW_WAIT_SEC` (2s) for an inferred-throttle 5xx — there the exhaustion signal *was* the per-second window, so the minute-scale `DEFAULT_RATE_LIMIT_WAIT_SEC` would overshoot by two orders of magnitude — and `DEFAULT_RATE_LIMIT_WAIT_SEC` otherwise. On a **429** publish it to the shared state file (`publishSharedRateLimitState`) **before** the wait/cancel decision, so peers hold off either way; an inferred 5xx throttle is deliberately **not** published (one session's guess must not stall every peer).
4. Decide `willWait = resetSec > 0 && resetSec <= getMaxRateLimitWaitSec()`. A non-429 that would *not* wait `break`s here and is returned untouched: the cancel path asserts "quota exceeded" and suppresses every retry layer, which must not rest on an inference. For a 429, set `pendingRateLimitCancel = !willWait` (+ `pendingRateLimitCancelDetail`) **before** firing feedback, so the feedback knows whether a rewritten error message will carry the report.
5. Fire user feedback via `triggerRateLimitFeedback`: on the wait path, a live countdown to the **true** reset in the rate-limit banner (see below); on the cancel path, nothing — the rewritten `errorMessage` is the report (a debounced notification only fires on paths that produce no errored message).
6. Take control of retry timing:
   - **Wait:** `await abortableDelay(resetSec * 1000, init.signal)` **inside the interceptor**, then re-issue the request via `originalFetch` and loop on a fresh rate limit. The wait is done here (not delegated to the SDK via `Retry-After`) because the SDK's inter-retry sleep is **not** abortable — delegating it makes **ESC** laggy (cancel only observed after the full wait elapses); the abortable delay rejects with `AbortError` the instant `init.signal` fires, so ESC interrupts immediately.
   - **Cancel:** (429 only) rebuild the `Response` with `retry-after` deleted and `x-should-retry: false` (SDK does not retry).

## Rate-limit banner (wait path UI)

The countdown lives in the extension's **own keyed widget**
(`ctx.ui.setWidget("gwdg-rate-limit", …)`), not in the working-loader message.

**Why not `ctx.ui.setWorkingMessage`:** `workingMessage` is a single field on pi's
`InteractiveMode` (`interactive-mode.js`: `workingMessage = undefined`,
`setWorkingMessage: (m) => { this.workingMessage = m }`) — last writer wins, no
stack, no ownership. "Restoring" it means calling `setWorkingMessage()` with no
argument, which resets it to pi's **default**, not to whatever another extension
had set (pi ships `examples/extensions/working-message-test.ts`, which sets a
persistent custom message at `session_start` — we would silently wipe it, and
vice versa). Widgets are stored in a **per-key map** (`extensionWidgetsAbove`),
so extensions cannot collide. `setWidget` is also functional in RPC mode, where
`setWorkingMessage` is a no-op. Layout-wise the widget container sits between the
status/working row and the editor, so the banner shows exactly during streaming.

Implementation (`extensions/index.ts`):

| Piece | Detail |
|-------|--------|
| `RateLimitBanner` | Extends pi-tui's `Loader` — the same component pi's own status indicators extend — with `RetryStatusIndicator`'s colour pair (`warning` spinner, `muted` text), so the banner animates with pi's default frames/cadence. `render()` drops `Loader`'s leading blank line (the widget container already adds a spacer). `dispose()` sets `disposed` + stops the spinner. |
| Text | `GWDG rate limited — retrying in 12m 05s... (escape to cancel)` — phrased after pi's `Retrying (1/3) in 5s... (esc to cancel)`. The key hint comes from pi's exported `keyText("app.interrupt")` (try/catch → `"esc"`). `formatCountdown` keeps ticking granularity (`42s` / `12m 05s` / `1h 04m`), unlike `formatWait`'s rounded one-shot wording. |
| Cadence | `RATE_LIMIT_BANNER_TICK_MS = 1000` refreshes the text; the spinner animates itself. |
| Modes | `ctx.mode === "tui"` → component factory. Other UI modes (RPC) → string lines, re-pushed each tick (all `setWidget` transports there). `ctx.hasUI === false` (print/json) → no banner at all; the wait is logged once via `debug()`/`trace()` rather than writing to stdout/stderr a piped run would not expect. |
| Self-heal | Each tick reinstalls the widget if the component was `disposed` out from under us (`resetExtensionUI` on session invalidate / extension reload). |
| Clearing | Every path that ends a wait: retry fired, `AbortError` (ESC), any finalized assistant `message_end`, `agent_end`, quota recovery (`after_provider_response` < 400), `session_shutdown` — plus a safety `setTimeout` (`retryAt + RATE_LIMIT_BANNER_SAFETY_MARGIN_MS`), because a widget persists until cleared (unlike the working row, which vanishes when streaming ends). |
| Cancel key (detached waits) | On a real wait the hint needs no wiring: ESC aborts the in-flight request, `abortableDelay` rejects, the interceptor clears the banner. A **detached** wait (`startRateLimitBanner(ctx, retryAt, { onCancel })`, used only by `/gwdg-simulate-ratelimit`) has no request, so `installRateLimitCancelKey` subscribes `ctx.ui.onTerminalInput` — widgets are never focused and cannot read keys themselves. The key is matched with `getKeybindings().matches(data, "app.interrupt")` (honours rebinds; same manager `keyText` renders from) behind an explicit `isKeyRelease` guard, because extension input listeners run *before* pi-tui's own release filter and would otherwise fire twice on a kitty-protocol terminal. `stopRateLimitBanner` unsubscribes first thing, since `onCancel` re-enters it. |
| Consume policy | `{ consume: true }` **only while `ctx.isIdle()`** — extension input listeners pre-empt every other consumer, so consuming unconditionally would blackhole pi's interrupt and leave the user unable to abort a real turn started during the simulated countdown (verified: always-consume → the streaming turn survives ESC). When idle, consuming keeps ESC single-purpose — it does not arm pi's double-escape `/tree`. A running `!` bash command and open overlays are not observable from an extension, so there ESC does double duty (cancels the banner *and* its normal job). |

## Cancel report + suppressing pi's agent-session auto-retry (cancel path, GWDG only)

pi has **two** retry layers:

- **OpenAI SDK retry** — governed by `retry.provider.maxRetries` (default 0);
  controlled directly by the `x-should-retry` header the interceptor rewrites.
- **Agent-session auto-retry** — `retry.maxRetries` (default 3, 2s/4s/8s
  backoff), a layer *above* the SDK that re-runs the whole request. It classifies
  a failure purely from the finalized assistant `errorMessage` via pi-ai's
  `isRetryableAssistantError`, which tests a NON-retryable pattern first
  (quota/billing/usage-limit wording) then a retryable one matching
  `429`/`rate limit`. A cancelled 429 would therefore still be retried.

To stop that **without** touching pi's global `retry.*` settings and **only** for
GWDG, the `message_end` handler consumes `pendingRateLimitCancel` (+
`pendingRateLimitCancelDetail`) and — when the errored message belongs to the
`gwdg` provider (`message.provider` or `ctx.model.provider`) — replaces
`errorMessage` with `buildCancelErrorMessage(detail, original)`. pi applies the
returned `{ message }` (`emitMessageEnd` → `_replaceMessageInPlace`) *before* its
retry classification runs, so `isRetryableAssistantError` returns false and pi
skips the backoff loop. This mirrors the provider-scoped `message_end`
errorMessage-rewrite pattern the pi custom-provider docs document for
context-overflow normalization. The rewrite is idempotent (`/quota exceeded/i`
guard) and the wait path leaves the message untouched (pi's retry stays available
as a backstop there).

`buildCancelErrorMessage` does double duty: it is the **user-facing report** for
the cancel path (a countdown needs a repaintable surface; a finished turn is not
one), and its wording is what suppresses the retry.

```
GWDG rate limited — quota exceeded. Quota resets in ~120 min (at 14:48), beyond the
~60 min max wait, so the request was cancelled instead of blocking on it.
Raise the budget with /gwdg-settings → maxRateLimitWaitSec (or
$PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC); /gwdg-status shows the current quota.
Provider response: 429: {…}
```

Because that message exists, `triggerRateLimitFeedback` emits **no** notification
when `pendingRateLimitCancel` is set — it would only duplicate it. Cancel paths
with no errored message (the `message_end`/`agent_end` fallback,
`/gwdg-simulate-ratelimit`) still notify, reusing the same builder so there is one
wording for "cancelled because of quota".

> **Coupling note:** the non-retryable classification depends on pi-ai's private
> regex list in `utils/retry.ts`, where the matched phrase is **"quota exceeded"**
> (tested against the whole message, not as a prefix). Keep that phrase in
> `buildCancelErrorMessage`. If the list changes across pi versions, the only
> regression is the old behaviour returning (a few seconds of backoff before the
> cancel), not a crash.

The extension's role:
- Parse rate-limit headers from **successful** responses (`after_provider_response`) and **every** response the interceptor sees, whatever its status, into the same module-level singleton.
- Make the bounded wait-vs-cancel decision and align the SDK's retry timing to the true reset.
- Render the wait countdown in its own keyed widget (no cross-extension UI collisions).
- Report + suppress pi's auto-retry on cancel (GWDG-scoped, via `message_end`).
- Emit event-bus events for cross-extension consumers (opt-in).
- Store rate-limit state for `/gwdg-status` display.
- Share that state with concurrent sessions on the same key (below).

## Cross-Session Rate-Limit State (`extensions/shared-state.ts`)

`rate-limits.ts`'s singleton is per **process**; GWDG quota is per **API key**.
N concurrent sessions therefore each burn a request on a 429 to learn what a
sibling already knows. `shared-state.ts` is the transport that closes that gap.

**Layering.** `pi.events` stays the *local interface* — `pi.events` is a bare
`node:events` `EventEmitter` (`dist/core/event-bus.js`), so it is in-process only
and cannot carry this. The tmpfs file is the *cross-process transport*
underneath it: what the pre-flight reads is fed into the same
`emitRateLimitEvents` path, so consumers cannot tell local from remote and the
transport stays swappable (socket, daemon) without touching consumers.

| Aspect | Detail |
|--------|--------|
| Path | `$XDG_RUNTIME_DIR/pi-gwdg/<hash>.json`; falls back to `<getAgentDir()>/extensions/gwdg-state/` when `XDG_RUNTIME_DIR` is unset (non-systemd, some containers, ssh without `pam_systemd`). Overridable via `sharedStateDir` / `PI_GWDG_SHARED_STATE_DIR`. |
| Why not `/dev/shm` | Mode `1777` — a predictable path there lets another local user pre-create the file and receive our writes. `XDG_RUNTIME_DIR` is `0700` and user-owned. Dir is created `0700`, file `0600`. |
| Filename | `sha256(host + "\0" + apiKey).slice(0,16)` — scopes state per credential; the key never appears in a path or payload. |
| Payload | `{ v: 1, resetTimestamp, windows, writtenAt, pid }`. `resetTimestamp: 0` means "recovered". |
| Atomicity | Write to `<path>.<pid>.<n>.tmp` in the same directory, then `renameSync`. A concurrent reader sees the whole old file or the whole new one. |
| Validation | Rejects wrong `v`, non-finite numbers, `writtenAt` more than 60s in our future (clock skew), and resets more than 24h out. Bad `windows` degrades to `{}`. |
| Write points | 429 in the interceptor (before the wait/cancel decision); `after_provider_response` with `status < 400` (publishes recovery + fresh windows, throttled to 2s for routine snapshot refreshes — anything that changes whether peers should hold off bypasses the throttle). |
| Read point | `waitForSharedRateLimit`, host-matched, before every `originalFetch`. |
| Fail-open | Every export swallows its own errors. Unreadable, corrupt, or uncreatable state degrades to the per-process behaviour. A failed `mkdir` is not retried for 60s. |

Two deliberate constraints in `waitForSharedRateLimit`:

- **It only ever waits, never cancels.** If the shared reset exceeds
  `maxRateLimitWaitSec` it falls through and sends. The cancel path rewrites a
  real 429's headers and body; synthesising a fake `Response` to reuse it would
  be far more fragile than letting the provider produce a real one.
- **At most one wait per request.** A peer publishing a fresh limit mid-wait does
  not extend it — looping here would let busy peers starve a session. A limit
  still in force just yields a 429, handled by the loop below it.

Do not delete the state file on `session_shutdown`: peers still need it, and it
is self-expiring (tmpfs clears on reboot; entries expire by `resetTimestamp`).

## Testing without real quota

`tools/gwdg-sim-proxy.mjs` is a zero-dependency relay that forwards real requests
upstream but can inject synthetic 429s (modes `firstN` / `everyN` / `bucket`, or
manual `POST /__sim/429`) and halve the rate-limit numbers. Point pi at it with
`{ "baseUrl": "http://localhost:8787/v1" }`. `PI_GWDG_TRACE=1` (or a path) writes
a timestamped event trace via `debug.ts`'s `trace()` without touching the TUI.
The `/gwdg-simulate-ratelimit [seconds]` command drives the banner/decision path
directly (wait path when the argument is within `maxRateLimitWaitSec`, cancel
report otherwise).

Two useful non-TUI harnesses, both scriptable:

- **RPC mode** (`pi --mode rpc --no-session -e ./extensions/index.ts`) makes the
  banner observable as protocol frames — one
  `{"method":"setWidget","widgetKey":"gwdg-rate-limit","widgetLines":[…]}` per
  second, then the same frame without `widgetLines` when it clears.
- **pty driver** for the real TUI (Python `pty.fork()` + strip ANSI) verifies the
  animated spinner and the `(escape to cancel)` hint actually render — and is the
  only harness that can exercise the cancel key, since RPC mode delivers no
  keystrokes (`onTerminalInput` is a documented no-op there). Three checks worth
  keeping: ESC clears the banner + notifies; a double-tap does **not** open the
  tree selector (a run without the banner does, proving the key was consumed);
  and with a turn in flight — point `baseUrl` at a stub that stalls before its
  response headers, otherwise the 200 clears the banner via quota recovery — one
  ESC both clears the banner and interrupts the turn.

**Cross-session coordination** needs two sessions and a shared
`XDG_RUNTIME_DIR`. Point both at `tools/gwdg-sim-proxy.mjs`, run
`PI_GWDG_TRACE=1` in each, force a 429 in session A (`POST /__sim/429`), then
send a turn in session B: B's trace should show
`shared rate limit: peer limit active — waiting Ns` and no request reaching the
proxy until the wait ends. Worth checking alongside it:
`PI_GWDG_SHARED_STATE=0` restores the old independent behaviour byte for byte;
pointing `PI_GWDG_SHARED_STATE_DIR` at an uncreatable path (parent is a regular
file → `ENOTDIR`, which fails for root too, unlike a `chmod`) must leave requests
working; and `/gwdg-status` should show the resolved path and the peer's reset.
For a scripted version, spawning two node processes that load
`extensions/index.ts` against a stub HTTP server exercises the whole path —
pre-flight wait, 429 publish, process boundary — without real quota.

**Testing the status classification** (429 vs. throttled 5xx vs. genuine 5xx vs.
other 4xx) needs no proxy and no quota — run
`npx tsc && node tools/verify-ratelimit-classification.mjs`. It imports
`dist/index.js`, calls the default export with a stub `pi` (`on` records the
handlers, the rest are no-ops), and points `baseUrl` at a local
`http.createServer` serving a scripted queue of `[status, headers]` pairs. It
covers all seven cases in
[What Counts as a Rate Limit](./rate-limiting.md#what-counts-as-a-rate-limit),
including the three asymmetries that keep a wrong 5xx inference cheap: capped
retries, 429-only cancel, 429-only peer publish.

Four things make it honest, and are worth preserving in anything similar:
- Inject `baseUrl` through a **project config file** (`<cwd>/.pi/gwdg.json` plus
  `process.chdir`) — there is no `PI_GWDG_BASE_URL` env var, and without this the
  extension silently targets the real GWDG host, `providerHost` never matches, and
  every passthrough assertion passes vacuously.
- Assert `globalThis.__gwdgFetchPatched` **first** and bail if it is false, so that
  failure mode is caught rather than reported as green.
- Assert on *request counts* and *elapsed time*, not just final status — a
  passthrough and a retried-to-failure both end in `500`, and a 2s versus a 60s
  fallback wait is invisible in the response.
- Keep shared state **enabled** but redirect `PI_GWDG_SHARED_STATE_DIR` to a temp
  dir, clearing it between cases. `PI_GWDG_SHARED_STATE=0` isolates from live peers
  but makes every "did not publish" assertion vacuous.

`PI_CODING_AGENT_DIR` still points at a temp dir so the real `~/.pi/gwdg.json` and
models cache stay out of it. When adding a behavior, confirm the new assertion
fails without the fix — patching the built `dist/index.js` to restore the old
behavior is the quickest way to prove the check discriminates.

Notes when driving a real 429 through the proxy: the models cache is keyed by
`baseUrl`, so a proxy `baseUrl` misses the cache — either pre-seed a cache file
with the proxy URL under an isolated `PI_CODING_AGENT_DIR`, or run
`/gwdg-refresh`. `--provider gwdg` on the CLI is rejected (pi validates the flag
before extensions register their providers); select the model after startup
instead (RPC `set_model`, or `/model`).
