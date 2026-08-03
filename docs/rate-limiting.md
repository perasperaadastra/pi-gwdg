# Rate Limits

> Back to [README.md](../README.md). For the internal implementation (fetch
> interceptor, shared-state file format, testing harnesses), see
> [rate-limit-internals.md](./rate-limit-internals.md).

GWDG enforces per-minute, per-hour, and per-day rate limits communicated via
`x-ratelimit-*` response headers. The extension tracks remaining quota in the
status footer, and on a rate limit it makes a **bounded** wait-or-cancel decision based
on when the quota actually resets:

- **Reset within `maxRateLimitWaitSec`** (default 3600s) → wait for the reset,
  then retry automatically. A live countdown to the true reset is shown in a
  banner above the editor while the request waits (see
  [Rate-Limit Banner](#rate-limit-banner)).
- **Reset beyond `maxRateLimitWaitSec`** (e.g. an hour/day window) → cancel the
  request immediately instead of blocking on a far-off reset. The cancelled turn's
  error message explains why, when the quota resets, and how to raise the budget.
  `maxRateLimitWaitSec: 0` cancels on the first 429.

The wait/cancel threshold is configurable via `maxRateLimitWaitSec`
(config file) or `PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC` (env), and editable in
`/gwdg-settings`. Both surfaces always report the **true** provider reset, even
when it exceeds the wait budget.

## What Counts as a Rate Limit

GWDG returns the `x-ratelimit-*` headers on **every** status except `401`, so the
extension harvests the quota snapshot from all of them — including error
responses. Without this, a run that only produced errors would leave the footer
and `/gwdg-status` showing stale numbers, because `after_provider_response` never
fires for a non-2xx response.

Harvesting is not the same as waiting. Two kinds of response enter the
wait path:

| Response | Treated as a rate limit? |
|----------|--------------------------|
| `429` | **Always.** Definitive: waited out as often as the provider says, or cancelled if the reset is beyond the budget. |
| `5xx` **with quota exhausted in the headers** | **Yes**, but wait-only and at most `3` times per HTTP attempt. GWDG's gateway substitutes a `500` for a `429` under throttling. |
| `5xx` with quota remaining | No — surfaced as the server error it is. |
| `4xx` other than `429` (e.g. `404`) | No. Deterministic; retrying cannot help. |
| `401` | No, and carries no headers at all. |

**Why a 5xx is handled more cautiously than a 429.** A `429` states plainly that
you are over quota. A `5xx` is only *inferred* to be a throttle, from headers that
happen to show no quota left — so a genuinely broken endpoint during an exhausted
window looks identical. Three consequences follow, all of them about keeping a
wrong inference cheap:

- **The retries are capped.** After 3 waited retries the response is handed back
  untouched and treated as a normal server error, so a real outage cannot become
  an unbounded retry loop. The cap counts within one HTTP attempt; pi's
  agent-session retry (`retry.maxRetries`) may then start a fresh attempt with a
  fresh count, so the practical bound is 3 × (1 + `retry.maxRetries`).
- **The cancel path is `429`-only.** Cancelling reports "quota exceeded" and
  suppresses every retry layer, which is the wrong answer for a server error. So
  when an inferred-throttle `5xx` has a reset beyond the wait budget, the extension
  surfaces the `5xx` as-is and leaves pi's retry available, rather than asserting a
  quota diagnosis it cannot back up.
- **Nothing is published to peers.** Only a `429` writes the shared state file. A
  guess should not stall every other session — and the per-second window behind a
  `5xx` throttle clears faster than a peer's pre-flight read is worth.

**Detection detail.** On a throttled `5xx` the *only* exhaustion signal is the
generic `ratelimit-remaining: 0` header — the named minute/hour/day/month windows
all still show quota available. That generic header tracks GWDG's tightest window
(per-second), so it is read directly as an exhaustion signal, independent of the
per-window snapshot shown in the footer. The wait follows from the same fact: with
no `retry-after` and no exhausted *named* window, the fallback is ~2s (the
per-second window's horizon), not the minute-scale `DEFAULT_RATE_LIMIT_WAIT_SEC`
that a `429` with no headers at all would get.

## Rate-Limit Banner

While a 429 wait is in progress, the countdown appears in the extension's own
keyed widget above the editor, deliberately styled like pi's built-in retry
indicator (warning-coloured spinner, muted text, cancel hint):

```
⠹ Working…                                                   ← pi's own loader
  ⠹ GWDG rate limited — retrying in 12m 05s... (escape to cancel)
> _
```

It is cleared as soon as the retry fires, the wait is cancelled with **ESC**, the
turn ends, or the quota recovers.

**ESC during a real wait** cancels the in-flight request, which ends the wait. A
wait with no request behind it — only `/gwdg-simulate-ratelimit` produces one —
listens for the key itself, so the hint means the same thing there. It gives up
the key whenever the agent is streaming, so cancelling the simulation never costs
you the ability to interrupt a real turn.

**Why a widget and not the working message.** `ctx.ui.setWorkingMessage()` writes
to a single global slot with no ownership: "restoring" it resets it to pi's
default rather than to whatever another extension had set, so two extensions that
both use it silently overwrite each other. Widgets are keyed per extension
(`gwdg-rate-limit` here), so they cannot collide. `setWidget` also works in RPC
mode, where `setWorkingMessage` is a no-op.

Per UI mode:

| Mode | Banner |
|------|--------|
| `tui` | Animated spinner + countdown + `(escape to cancel)` hint |
| `rpc` | Same countdown as `setWidget` widget lines (one update/second), no spinner or key hint |
| `print` / `json` | No UI exists in these modes; the wait is logged once via `PI_GWDG_DEBUG=1` / `PI_GWDG_TRACE` instead |

## Footer Auto-Clear

After each normal response, the quota status in the footer is cleared after
`footerTimeoutSec` seconds (default 60). Each new response resets the timer,
giving you a full timeout from the latest activity. Set `footerTimeoutSec: 0`
to keep the status visible until the next response.

## Cross-Session Rate Limit Coordination

GWDG counts quota **per API key**, but pi's rate-limit state is **per process**.
Run three pi sessions against the same key and each one believes it owns the full
per-minute allowance — each discovers otherwise only by burning its own request
on a 429.

The extension closes that gap by sharing rate-limit state between concurrent
sessions through a small JSON file. When any session hits a 429 it publishes the
reset; every other session reads it just before sending and waits out the limit
instead of rediscovering it. **On by default.**

```
session A ──429──▶ publishes reset ──▶ ┌──────────────────────┐
                                       │ $XDG_RUNTIME_DIR/    │
session B ─────── reads before send ──▶│   pi-gwdg/<hash>.json│
session C ─────── reads before send ──▶└──────────────────────┘
```

**Where it lives.** `$XDG_RUNTIME_DIR/pi-gwdg/<hash>.json` — tmpfs, so the
coordination costs no disk I/O and is cleared on reboot. When `XDG_RUNTIME_DIR`
is unset (non-systemd hosts, some containers, ssh without `pam_systemd`) it falls
back to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg-state/`. Override with `sharedStateDir` /
`PI_GWDG_SHARED_STATE_DIR`. `/dev/shm` is deliberately **not** used: it is mode
`1777`, so a predictable path there would let another local user pre-create the
file and receive our writes.

**Scoping.** The filename is a truncated SHA-256 of the endpoint host and the API
key, so sessions on different keys never suppress each other. The key itself
never appears in the path or the payload.

**Behaviour and limits:**

- The pre-flight check only ever **waits**, never cancels. If the shared reset
  lies beyond `maxRateLimitWaitSec`, the request is sent anyway and the normal
  429 cancel path handles the real response.
- It waits **at most once** per request, so a stream of busy peers cannot starve
  a session indefinitely. A limit that is still in force simply produces a 429,
  handled as usual.
- Waking peers are spread by up to `sharedStateJitterMs` (default 1000ms) so they
  do not all fire at the same instant and immediately re-exhaust the window.
- Every read and write is **fail-open**: a missing, corrupt, or unwritable state
  file degrades silently to the per-process behaviour described above.
- Same host, same user only. It does not coordinate across machines, across user
  accounts, or across container mount namespaces.
- Coordination does not *create* quota. If aggregate demand exceeds the limit,
  this turns scattered 429s into orderly waiting — a latency and noise win, not a
  throughput one.

`/gwdg-status` shows the resolved file path, any active peer limit, and how long
ago it was published. Turn the whole thing off with `sharedRateLimitState: false`,
`PI_GWDG_SHARED_STATE=0`, or the toggle in `/gwdg-settings`.

## Architecture (Summary)

The extension parses rate-limit headers from **successful** responses via
`after_provider_response`. For every **other** status it relies on a
`globalThis.fetch` interceptor installed at provider registration, because the
`openai-completions` API type uses the OpenAI SDK internally and the SDK throws
on non-2xx responses **before** the `onResponse` callback fires — so
`after_provider_response` never sees an error response.

The interceptor is scoped to the GWDG base URL. **Before** each request it runs
the shared-state pre-flight check described above, waiting out a limit a peer
session already hit. It records the quota snapshot from every response it sees —
and renders the footer from it, since nothing else does for a non-2xx (see
[What Counts as a Rate Limit](#what-counts-as-a-rate-limit)) — and when a
response qualifies as a rate limit it:

1. Extracts `x-ratelimit-*` / `retry-after` headers and computes the **true**
   provider reset (uncapped); on a `429` it also publishes that reset to the
   shared state file so peer sessions hold off too.
2. Decides `willWait = reset > 0 && reset <= maxRateLimitWaitSec`. A `429` takes
   either branch; an inferred-throttle `5xx` only ever waits — `!willWait` returns
   it untouched instead of cancelling.
3. Takes control of retry timing:
   - **Wait:** pauses for the true reset **inside the interceptor** using an
     abortable delay, then retries the request itself (looping if it gets a
     fresh 429). The wait is done here rather than by handing `Retry-After` to
     the SDK because the SDK's inter-retry sleep is not abortable — delegating it
     would make **ESC** laggy (the cancel would only take effect after the full
     wait elapsed). Doing it here lets ESC abort the wait immediately.
   - **Cancel:** deletes `Retry-After` and sets `x-should-retry: false` so the
     SDK does not retry.
4. Drives user feedback via the most recently captured UI context: the live
   countdown banner on the wait path, or (on the cancel path) the rewritten error
   message described below.

**The cancel report lives in the error message.** A countdown needs a surface
that can be repainted; a finished turn cannot be. So on the cancel path the
explanation goes where the turn actually ends — the errored assistant message,
whose raw `429: {…}` provider text is replaced with:

```
GWDG rate limited — quota exceeded. Quota resets in ~120 min (at 14:48), beyond the
~60 min max wait, so the request was cancelled instead of blocking on it.
Raise the budget with /gwdg-settings → maxRateLimitWaitSec (or
$PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC); /gwdg-status shows the current quota.
```

No notification is emitted for that path, since it would duplicate the message.
Paths that produce no errored message — the `message_end`/`agent_end` fallback and
`/gwdg-simulate-ratelimit` — still notify, with the same wording.

**Suppressing pi's auto-retry on cancel (GWDG only).** pi has a second retry
layer above the SDK — its agent-session auto-retry (`retry.maxRetries`, default
3, 2s/4s/8s backoff). It classifies a failure purely from the assistant
`errorMessage` text, so a cancelled 429 (message contains "429"/"rate limit")
would otherwise still be retried. The rewrite above is also what prevents that:
it contains **"quota exceeded"**, one of pi-ai's non-retryable patterns, so pi
classifies the message as non-retryable and skips its backoff loop — without
changing pi's global retry settings or affecting other providers (the rewrite is
scoped to the `gwdg` provider). This uses exactly the provider-scoped
`message_end` rewrite pattern the pi custom-provider docs prescribe (documented
there for context-overflow normalization). The wait path leaves the message
untouched, so pi's retry remains a backstop there.

| Event | Purpose |
|-------|---------|
| `after_provider_response` | Extract rate-limit headers from **successful** responses; update footer; emit event-bus events (error responses are harvested by the fetch interceptor instead, which is the only layer that sees them) |
| `message_end` / `agent_end` | Observe terminal `stopReason: "error"` (429) as a notification fallback; clear a stale banner; on the cancel path, rewrite the GWDG error message (user-facing report + auto-retry suppression) |
| `session_start` | Capture UI context early; install custom autocomplete provider for `/gwdg-settings <scope>` argument completion (`project`/`global`) |
| `session_shutdown` | Cancel footer auto-clear + banner timers; clear GWDG status indicator and banner widget; clear debug context |
