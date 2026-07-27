/**
 * pi-gwdg — GWDG provider extension for pi.
 *
 * Registers an OpenAI-compatible provider pointing at GWDG's AI services API,
 * with model discovery (cached for 30 days), rate limit tracking, and
 * commands for status/info/refresh.
 *
 * Rate limit architecture
 * -----------------------
 * Successful responses: `after_provider_response` extracts the per-window
 * `x-ratelimit-*` headers and renders remaining quota in the status footer.
 *
 * 429 responses: these are handled entirely INSIDE the OpenAI SDK — it retries
 * non-2xx responses, honouring `Retry-After`, within a single request. As a
 * result NO pi extension event ever observes an in-flight 429:
 *   - `after_provider_response` only fires for the final 2xx (the SDK never
 *     calls `onResponse` for the intermediate 429s).
 *   - `message_end` / `agent_end` only carry the final assistant message
 *     (success, or a terminal error once retries are exhausted).
 * We verified this empirically: 5 proxied 429s produced zero extension events.
 *
 * The only layer that sees every attempt is the HTTP transport. pi's provider
 * constructs the OpenAI client with no custom `fetch`, so the SDK uses
 * `globalThis.fetch` (which pi has pointed at undici). We install a thin
 * wrapper around `globalThis.fetch`; on a 429 from the configured GWDG endpoint
 * it reads the `x-ratelimit-*` / `Retry-After` headers to determine the true
 * quota reset and then decides, based on `maxRateLimitWaitSec`:
 *
 *   - If the reset is within `maxRateLimitWaitSec` (setting): wait for it HERE,
 *     using an abortable delay, then retry the request ourselves. We do the wait
 *     in the interceptor rather than handing `Retry-After` to the SDK because the
 *     SDK's inter-retry sleep is NOT abortable — delegating it would make ESC
 *     laggy (the cancel is only seen after the full wait elapses). A live
 *     countdown to the reset is shown meanwhile, in our own keyed widget above
 *     the editor (see "Rate-limit banner" below).
 *   - If the reset is further away than `maxRateLimitWaitSec`: set
 *     `x-should-retry: false` so the SDK does NOT retry and fails immediately,
 *     rather than blocking until a far-off quota reset. (`maxRateLimitWaitSec: 0`
 *     fails on the first 429.) The cancelled turn's error message carries the
 *     full explanation (reset time, budget, how to change it).
 *
 * `globalThis` is a single realm-wide object, so this avoids the module-
 * duplication trap that made the earlier `OpenAI.prototype` monkey-patch a
 * no-op (the extension's own `openai` copy was never the one making requests).
 *
 * Cross-session coordination
 * --------------------------
 * All of the above is per-process, but GWDG quota is per API key: N concurrent
 * pi sessions each believe they own the full allowance and each learns otherwise
 * by eating its own 429. `shared-state.ts` publishes the reset to a small tmpfs
 * file keyed by a hash of the credential; the interceptor reads it before every
 * request and waits out a peer's limit instead of rediscovering it. See
 * `waitForSharedRateLimit`. Controlled by `sharedRateLimitState` (default on),
 * and fail-open: any problem with the shared file degrades to the per-process
 * behaviour described above.
 *
 * Note: pi's agent-session retry layer sits above the SDK and may still do a
 * few quick exponential retries after a cancel; those are bounded (seconds) and
 * governed by pi's own `retry.maxRetries` setting, not by this extension.
 *
 * The `message_end` / `agent_end` handlers remain as a best-effort fallback
 * for terminal errors that surface as an assistant `stopReason: "error"`.
 */
import { DynamicBorder, getSelectListTheme, getSettingsListTheme, ExtensionInputComponent, getAgentDir, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Loader, SelectList, SettingsList, getKeybindings, isKeyRelease, type AutocompleteItem, type TUI } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { loadModelsFromCache, fetchModelsFromApi, saveModelsToCache } from "./models.js";
import { extractRateLimitsFromHeaders, extractRetryAfter, getRateLimitState, setRateLimitState, clearRetryAfter } from "./rate-limits.js";
import { refreshConfig, config, apiKey as cfgApiKey, isRateLimitEmitEnabled, getFooterTimeoutMs, getMaxRateLimitWaitSec, isSharedRateLimitStateEnabled, getSharedStateJitterMs, setSetting, persistSettings, recordProviderRegistration, setModelOverride, removeModelOverride, getOverrideModelIds, getModelOverride, } from "./config.js";
import { readSharedRateLimitState, publishSharedRateLimitState, getSharedStateDiagnostics } from "./shared-state.js";
import { debug, trace, setDebugCtx, clearDebugCtx } from "./debug.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROVIDER_NAME = "gwdg";
const ENV_VAR_KEY = "GWDG_API_KEY";

/**
 * Format a reset value for a given window.
 * Shows appropriate granularity:
 *   minute  → seconds (e.g. "38s")
 *   hour    → minutes (e.g. "2m"), with seconds for <1m
 *   day     → hours (e.g. "1h"), with minutes for <1h
 *   month   → days (e.g. "3d"), with hours for <1d
 */
function formatWindowReset(window: string, seconds: number) {
    if (seconds === undefined || seconds === null || seconds <= 0)
        return "";
    switch (window) {
        case "minute":
            return `${Math.round(seconds)}s`;
        case "hour": {
            const m = Math.floor(seconds / 60);
            return m < 1 ? `${Math.round(seconds)}s` : `${m}m`;
        }
        case "day": {
            const h = Math.floor(seconds / 3600);
            if (h < 1) {
                const m = Math.floor(seconds / 60);
                return m < 1 ? `${Math.round(seconds)}s` : `${m}m`;
            }
            return `${h}h`;
        }
        case "month": {
            const d = Math.floor(seconds / 86400);
            if (d < 1) {
                const h = Math.floor(seconds / 3600);
                if (h < 1) {
                    const m = Math.floor(seconds / 60);
                    return m < 1 ? `${Math.round(seconds)}s` : `${m}m`;
                }
                return `${h}h`;
            }
            return `${d}d`;
        }
        default:
            return `${Math.round(seconds)}s`;
    }
}
// ---------------------------------------------------------------------------
// Module-level state for footer auto-clear
// ---------------------------------------------------------------------------
/**
 * Tracks the most recent footer auto-clear timeout.
 * When a new response arrives, the old timeout is cleared and a fresh one
 * is started, giving the user a full `footerTimeoutSec` from the latest
 * activity rather than having a stale timeout fire prematurely.
 */
let footerClearTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Schedule (or reschedule) a full footer-timeout from now.
 * Any previously scheduled clear is cancelled.
 */
function scheduleFooterClear(key: string, ctx: { ui: { setStatus: (k: string, v: string | undefined) => void } }, timeoutMs: number) {
    if (footerClearTimer) {
        clearTimeout(footerClearTimer);
    }
    footerClearTimer = setTimeout(() => {
        footerClearTimer = null;
        try {
            ctx.ui.setStatus(key, undefined);
        }
        catch {
            // ctx may be stale
        }
    }, timeoutMs);
}

// ---------------------------------------------------------------------------
// 429 rate-limit feedback state
// ---------------------------------------------------------------------------

/**
 * Most recent ExtensionCommandContext captured from an event handler. The
 * global-fetch wrapper runs outside any event context, so it borrows this to
 * reach `ctx.ui.setWidget` / `ctx.ui.notify` / `ctx.ui.setStatus`. Refreshed by
 * every handler; the TUI it points at stays valid for the life of the session.
 */
let feedbackCtx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext | null = null;

/**
 * Set by the fetch interceptor when it decides to CANCEL a 429 (reset beyond the
 * configured max wait) rather than wait+retry. pi's agent-session auto-retry is
 * a layer ABOVE the OpenAI SDK — the SDK's `x-should-retry: false` stops the
 * SDK's own retry, but pi would still re-run the request up to `retry.maxRetries`
 * times because it classifies the failure purely from the assistant
 * `errorMessage` text (a "429"/"rate limit" message matches its RETRYABLE
 * pattern). We consume this flag in `message_end` to rewrite the errorMessage so
 * pi classifies it as NON-retryable — scoped to the GWDG provider only, leaving
 * pi's retry behaviour for every other provider (and for our own wait+retry
 * path) untouched. See the note above the `message_end` handler for details.
 *
 * It also decides where the user-facing report goes: when it is set, the
 * rewritten error message IS the report, so no notification is emitted.
 */
let pendingRateLimitCancel = false;

/**
 * Details of the cancellation the `message_end` rewrite turns into user-facing
 * prose. Set alongside `pendingRateLimitCancel`, consumed (and cleared) by the
 * rewrite; `null` means "cancelled but we don't know the numbers", which yields
 * a shorter generic message.
 */
let pendingRateLimitCancelDetail: { resetSec: number; maxWaitSec: number } | null = null;

// ---------------------------------------------------------------------------
// Rate-limit banner (live wait-and-retry countdown in a keyed widget)
// ---------------------------------------------------------------------------
/**
 * On the wait+retry path the request stays in-flight while we sleep, so pi's
 * working loader is on screen with nothing to explain the pause. We render the
 * countdown in our OWN keyed widget above the editor:
 *
 *   ⠹ Working…                                                    ← pi's, untouched
 *     ⠹ GWDG rate limited — retrying in 12m 05s... (escape to cancel)   ← ours
 *   > _
 *
 * Why not `ctx.ui.setWorkingMessage`: `workingMessage` is a SINGLE field on pi's
 * interactive mode (last writer wins, no stack, no ownership). Restoring it
 * means calling `setWorkingMessage()` with no argument, which resets it to pi's
 * DEFAULT — not to whatever another extension had set. Any extension that keeps
 * a custom working message (pi ships exactly that as an example) would be
 * silently wiped by us, and vice versa. Widgets are stored in a per-key map, so
 * extensions cannot clobber each other's. `setWidget` is also functional in RPC
 * mode, where `setWorkingMessage` is a no-op.
 *
 * The banner deliberately mirrors pi's built-in `RetryStatusIndicator`
 * ("Retrying (1/3) in 5s... (esc to cancel)"): same pi-tui `Loader` component,
 * same default spinner frames and cadence, same warning-coloured spinner with
 * muted text — so it reads as part of pi rather than as a bolted-on surface.
 */
const RATE_LIMIT_WIDGET_KEY = "gwdg-rate-limit";
/** How often the countdown text is refreshed (the spinner animates itself). */
const RATE_LIMIT_BANNER_TICK_MS = 1000;
/**
 * Grace period after the expected retry moment before the banner force-clears
 * itself. A widget is persistent (unlike the working row, which disappears when
 * streaming ends), so a missed clear would leave a stale banner above the editor
 * for the rest of the session.
 */
const RATE_LIMIT_BANNER_SAFETY_MARGIN_MS = 15_000;

/**
 * The banner component. Reuses pi-tui's `Loader` — the same class pi's own
 * status indicators extend — with `RetryStatusIndicator`'s colour pair.
 */
class RateLimitBanner extends Loader {
    /** Set when pi disposes this widget, so the ticker can reinstall it. */
    disposed = false;

    constructor(tui: TUI, theme: import("@earendil-works/pi-coding-agent").Theme, message: string) {
        super(tui, (s: string) => theme.fg("warning", s), (t: string) => theme.fg("muted", t), message);
    }

    /**
     * `Loader.render()` emits a leading blank line (it owns the gap above pi's
     * working row). The widget container already inserts that spacer, so drop
     * the extra one to avoid a double gap above the editor.
     */
    render(width: number): string[] {
        return super.render(width).slice(1);
    }

    /** Called by pi when the widget is replaced, cleared, or the UI is reset. */
    dispose(): void {
        this.disposed = true;
        this.stop();
    }
}

/** Absolute ms timestamp the current wait retries at (0 = no wait active). */
let rateLimitRetryAt = 0;
/** Countdown ticker; also the self-heal driver (see `tickRateLimitBanner`). */
let rateLimitBannerTimer: ReturnType<typeof setInterval> | null = null;
/** Hard stop so a banner can never outlive its rate-limit episode. */
let rateLimitBannerSafetyTimer: ReturnType<typeof setTimeout> | null = null;
/** ctx that owns the widget — needed to clear it again. */
let rateLimitBannerCtx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext | null = null;
/** Live component (TUI mode only); non-TUI modes push plain string lines. */
let rateLimitBanner: RateLimitBanner | null = null;
/** True while a widget is installed — guards against clearing one we never set. */
let rateLimitBannerActive = false;
/**
 * Unsubscribe for the interrupt-key listener of a DETACHED wait (one with no
 * request behind it — see `installRateLimitCancelKey`). Null whenever no such
 * listener is installed.
 */
let rateLimitBannerInputOff: (() => void) | null = null;

/**
 * Countdown text for the banner: `42s`, `12m 05s`, `1h 04m`. Unlike
 * `formatWait` (which rounds to "~12 min" for one-shot messages) this keeps a
 * ticking second/minute component, since it is repainted every second.
 */
function formatCountdown(seconds: number): string {
    const total = Math.max(0, Math.ceil(seconds));
    if (total < 60) return `${total}s`;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
    return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`;
}

/**
 * The keys bound to pi's interrupt action ("esc"), as pi's own indicators
 * render them. Reads pi's global keybindings manager, which only exists in TUI
 * mode — hence the fallback.
 */
function interruptKeyText(): string {
    try {
        return keyText("app.interrupt") || "esc";
    }
    catch {
        return "esc";
    }
}

/**
 * True when raw terminal input is the interrupt key ("esc"), as pi's own editor
 * tests it (`KeybindingsManager.matches(data, "app.interrupt")`), so a user
 * rebinding is honoured — the same manager `interruptKeyText` renders from.
 *
 * The `isKeyRelease` guard is not optional: extension input listeners run BEFORE
 * pi-tui's own key-release filter (which only guards dispatch to the focused
 * component), so on a kitty-protocol terminal press+release would fire twice.
 */
function isInterruptKey(data: string): boolean {
    try {
        if (isKeyRelease(data)) return false;
        return getKeybindings().matches(data, "app.interrupt");
    }
    catch {
        // No keybindings manager (non-TUI host) — fall back to a bare ESC byte.
        return data === "\x1b";
    }
}

/**
 * Banner text for `secsLeft` seconds until retry, phrased like pi's built-in
 * retry indicator. The cancel hint is TUI-only (an RPC client has no ESC key).
 */
function rateLimitBannerMessage(secsLeft: number, withCancelHint: boolean): string {
    const base = `GWDG rate limited — retrying in ${formatCountdown(secsLeft)}...`;
    return withCancelHint ? `${base} (${interruptKeyText()} to cancel)` : base;
}

/** Seconds remaining until the pending retry fires. */
function rateLimitSecondsLeft(): number {
    return Math.ceil((rateLimitRetryAt - Date.now()) / 1000);
}

/**
 * (Re)install the banner widget. TUI mode gets the animated `Loader` component;
 * every other UI mode (RPC) gets string lines, which is all `setWidget`
 * transports there.
 */
function installRateLimitBanner(ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext): void {
    const secsLeft = rateLimitSecondsLeft();
    if (ctx.mode === "tui") {
        ctx.ui.setWidget(RATE_LIMIT_WIDGET_KEY, (tui: TUI, theme: import("@earendil-works/pi-coding-agent").Theme) => {
            rateLimitBanner = new RateLimitBanner(tui, theme, rateLimitBannerMessage(secsLeft, true));
            return rateLimitBanner;
        });
    }
    else {
        rateLimitBanner = null;
        ctx.ui.setWidget(RATE_LIMIT_WIDGET_KEY, [rateLimitBannerMessage(secsLeft, false)]);
    }
    rateLimitBannerActive = true;
}

/** One countdown tick: refresh the text, reinstall if pi dropped the widget. */
function tickRateLimitBanner(ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext): void {
    const secsLeft = rateLimitSecondsLeft();
    if (secsLeft <= 0) {
        // Reset reached — the retry is firing, so pi's plain working row is the
        // truthful display again.
        stopRateLimitBanner();
        return;
    }
    try {
        if (rateLimitBanner && !rateLimitBanner.disposed) {
            rateLimitBanner.setMessage(rateLimitBannerMessage(secsLeft, true));
        }
        else {
            // Non-TUI: string widgets have no instance, so this is the normal
            // per-tick update. TUI: our component was disposed out from under us
            // (session invalidate / extension reload) — reinstall it.
            installRateLimitBanner(ctx);
        }
    }
    catch {
        // ctx went stale — drop the banner rather than leak a timer.
        stopRateLimitBanner();
    }
}

/**
 * Make the interrupt key cancel a DETACHED wait — one with no request behind it,
 * i.e. `/gwdg-simulate-ratelimit`. A real wait needs none of this: ESC aborts the
 * in-flight request, `abortableDelay` rejects with `AbortError`, and the
 * interceptor clears the banner. The simulation has no request and no signal, so
 * without this the banner's own `(escape to cancel)` hint is a lie.
 *
 * Widgets are never focused, so the banner component cannot read keys itself;
 * `ctx.ui.onTerminalInput` is the extension-level hook, and its listeners run
 * before every other consumer of the key (pi-tui `TUI.handleInput`).
 *
 * The key is CONSUMED only while no agent run is active. Swallowing it during
 * streaming would blackhole pi's interrupt and leave the user unable to abort a
 * real turn started during the simulated countdown; consuming when idle keeps ESC
 * single-purpose (no double-escape `/tree` arming). A running `!` bash command
 * and open overlays are not observable from an extension, so there ESC does
 * double duty — it cancels the banner AND its normal job, the benign failure.
 */
function installRateLimitCancelKey(
    ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
    onCancel: () => void,
): void {
    if (ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function") return;
    try {
        rateLimitBannerInputOff = ctx.ui.onTerminalInput((data: string) => {
            if (!isInterruptKey(data)) return undefined;
            onCancel();
            // Positive knowledge only: if `isIdle` is unavailable, pass the key on
            // rather than risk swallowing an interrupt someone else needs.
            return ctx.isIdle?.() === true ? { consume: true } : undefined;
        });
        trace("installRateLimitCancelKey: interrupt key wired for detached wait");
    }
    catch (err) {
        trace("installRateLimitCancelKey: onTerminalInput failed (%s)", err instanceof Error ? err.message : String(err));
        rateLimitBannerInputOff = null;
    }
}

/**
 * Remove the banner and stop its timers. Safe to call when none is active, and
 * called from every path that ends a wait (retry fired, ESC, terminal message,
 * quota recovery, session shutdown).
 */
function stopRateLimitBanner(): void {
    // First, and unconditionally: `onCancel` runs from inside the listener and
    // lands back here, so the unsubscribe must be detached before it is called.
    const inputOff = rateLimitBannerInputOff;
    rateLimitBannerInputOff = null;
    if (inputOff) {
        try {
            inputOff();
        }
        catch {
            // Listener list already torn down (session reload / shutdown).
        }
    }
    if (rateLimitBannerTimer) {
        clearInterval(rateLimitBannerTimer);
        rateLimitBannerTimer = null;
    }
    if (rateLimitBannerSafetyTimer) {
        clearTimeout(rateLimitBannerSafetyTimer);
        rateLimitBannerSafetyTimer = null;
    }
    rateLimitRetryAt = 0;
    const ctx = rateLimitBannerCtx;
    const wasActive = rateLimitBannerActive;
    rateLimitBannerActive = false;
    rateLimitBanner = null;
    rateLimitBannerCtx = null;
    if (wasActive && ctx) {
        try {
            ctx.ui.setWidget(RATE_LIMIT_WIDGET_KEY, undefined);
        }
        catch {
            // ctx may be stale (session ended) — nothing left to clear.
        }
    }
}

/**
 * Show the live countdown to `retryAt` (absolute ms). Replaces any banner
 * already showing. Self-clears when the countdown reaches zero, and — as a
 * backstop against a missed clear — shortly after the expected retry moment.
 *
 * `opts.onCancel` marks the wait as detached (no request behind it) and wires the
 * interrupt key to it; see `installRateLimitCancelKey`.
 */
function startRateLimitBanner(
    ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
    retryAt: number,
    opts?: { onCancel?: () => void },
): void {
    stopRateLimitBanner();
    rateLimitRetryAt = retryAt;
    if (ctx.hasUI === false) {
        // print/json mode: every ui method is a no-op, so a ticking banner would
        // render nowhere. Log the wait once instead of writing to stdout/stderr,
        // which a piped run would not expect.
        debug("rate limited — waiting %s for quota reset (no UI in %s mode)", formatCountdown(rateLimitSecondsLeft()), ctx.mode ?? "non-tui");
        trace("startRateLimitBanner: no UI (mode=%s) — wait is %ds", ctx.mode ?? "?", rateLimitSecondsLeft());
        return;
    }
    rateLimitBannerCtx = ctx;
    try {
        installRateLimitBanner(ctx); // paint immediately, no blank first second
    }
    catch (err) {
        trace("startRateLimitBanner: setWidget failed (%s)", err instanceof Error ? err.message : String(err));
        stopRateLimitBanner();
        return;
    }
    if (opts?.onCancel) installRateLimitCancelKey(ctx, opts.onCancel);
    rateLimitBannerTimer = setInterval(() => tickRateLimitBanner(ctx), RATE_LIMIT_BANNER_TICK_MS);
    rateLimitBannerSafetyTimer = setTimeout(() => {
        trace("rate-limit banner: safety timeout — force-clearing");
        stopRateLimitBanner();
    }, Math.max(0, retryAt - Date.now()) + RATE_LIMIT_BANNER_SAFETY_MARGIN_MS);
}

/** Clear the active rate-limit wait state (e.g. once quota recovers). */
function clearRateLimitWait(): void {
    clearRetryAfter();
    stopRateLimitBanner();
}

/**
 * Detect whether an error message describes an HTTP 429 / rate-limit error.
 * The `openai-completions` provider surfaces errors as a formatted string
 * (see pi-ai `error-body.ts`) shaped like `"429: {\"error\":...}"`, so we
 * match on the status code and common rate-limit phrasings.
 */
function looksLikeRateLimit(errorMessage: string | undefined): boolean {
    if (!errorMessage) return false;
    return /(^|\D)429(\D|$)/.test(errorMessage)
        || /too many requests/i.test(errorMessage)
        || /rate[ _-]?limit/i.test(errorMessage);
}

/**
 * Best-effort estimate of how many seconds until the rate limit resets.
 * Headers are unavailable on the error path, so we fall back through:
 *   1. an explicit retry-after / reset hint parsed from the error body,
 *   2. the smallest reset among windows that are exhausted (remaining <= 0),
 *   3. the smallest reset among any known windows,
 *   4. a conservative default.
 */
const DEFAULT_RATE_LIMIT_WAIT_SEC = 60;

/** Debounce so pi's own quick retries don't spam duplicate notifications. */
const RATE_LIMIT_NOTIFY_DEBOUNCE_MS = 5000;
let lastRateLimitNotifyAt = 0;

function estimateResetSeconds(errorMessage: string | undefined): number {
    // 1. explicit hint in the error body
    const hint = errorMessage?.match(/retry[ _-]?after["':\s]*(\d+)/i)
        ?? errorMessage?.match(/(?:ratelimit[ _-]?reset|reset)["':\s]*(\d+)/i);
    if (hint) {
        const n = parseInt(hint[1], 10);
        if (Number.isFinite(n) && n > 0) return n;
    }
    // 2 & 3. derive from the last-known per-window state
    const windows = getRateLimitState().windows;
    const order = ["minute", "hour", "day", "month"] as const;
    const exhausted: number[] = [];
    const any: number[] = [];
    for (const key of order) {
        const w = windows[key];
        if (!w || !Number.isFinite(w.reset) || w.reset <= 0) continue;
        any.push(w.reset);
        if (w.remaining <= 0) exhausted.push(w.reset);
    }
    if (exhausted.length) return Math.min(...exhausted);
    if (any.length) return Math.min(...any);
    // 4. default
    return DEFAULT_RATE_LIMIT_WAIT_SEC;
}

function formatWait(seconds: number): string {
    return seconds > 90 ? `~${Math.ceil(seconds / 60)} min` : `${seconds}s`;
}

/** Local wall-clock `HH:MM` for an absolute timestamp. */
function formatClockTime(timestamp: number): string {
    return new Date(timestamp).toTimeString().slice(0, 5);
}

/**
 * Opening phrase of every cancel report we write. Doubles as the marker that
 * lets `handleRateLimitError` recognise our own text and not treat it as a fresh
 * rate-limit error (`agent_end` sees the rewritten message and would otherwise
 * emit a notification duplicating it).
 *
 * It contains "quota exceeded" for pi's retry classification — see below.
 */
const CANCEL_REPORT_MARKER = "GWDG rate limited — quota exceeded";

/**
 * User-facing text for a 429 the interceptor CANCELLED, used to replace pi's raw
 * provider error (`429: {"error":…}`) on the errored assistant turn. This is the
 * report for the cancel path — the live banner only exists while we wait, and a
 * transcript entry cannot tick, so the explanation belongs here.
 *
 * It MUST keep containing "quota exceeded": that is one of pi-ai's NON-retryable
 * patterns (`utils/retry.ts`), and matching it is what stops pi's agent-session
 * auto-retry from re-running the doomed request. The pattern is tested against
 * the whole string, so the wording around it is free.
 */
function buildCancelErrorMessage(
    detail: { resetSec: number; maxWaitSec: number } | null,
    original: string,
): string {
    const lines: string[] = [];
    if (detail) {
        const resetAt = formatClockTime(Date.now() + detail.resetSec * 1000);
        lines.push(
            `${CANCEL_REPORT_MARKER}. Quota resets in ${formatWait(detail.resetSec)} (at ${resetAt}), `
            + `beyond the ${detail.maxWaitSec === 0 ? "disabled" : formatWait(detail.maxWaitSec)} max wait, `
            + "so the request was cancelled instead of blocking on it.",
        );
        lines.push("Raise the budget with /gwdg-settings → maxRateLimitWaitSec (or $PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC); /gwdg-status shows the current quota.");
    }
    else {
        lines.push(`${CANCEL_REPORT_MARKER}, and the reset is beyond the configured max wait, so the request was cancelled. See /gwdg-status.`);
    }
    if (original) {
        lines.push(`Provider response: ${original}`);
    }
    return lines.join("\n");
}

/** True if an error represents an aborted operation (ESC / cancelled request). */
function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
}

/**
 * Sleep for `ms`, resolving on timeout or rejecting IMMEDIATELY with an
 * AbortError the moment `signal` aborts. Used for the wait-and-retry pause so
 * ESC interrupts the wait instantly, instead of only being observed after the
 * full delay has elapsed (which is what happens when the OpenAI SDK does its
 * own non-abortable sleep between retries).
 */
function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const abortErr = () =>
            (signal && signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) {
            reject(abortErr());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortErr());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export default async function (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) {
    // -----------------------------------------------------------------------
    // Event bus emission helper
    // -----------------------------------------------------------------------
    /**
     * Emit rate limit data on the shared pi event bus.
     *
     * Called from `after_provider_response` when `emitRateLimitEvents` is enabled.
     * Emits `pi:rate-limits` on every response, and additionally `pi:rate-limited`
     * on 429 responses (when retryAfter is available).
     */
    function emitRateLimitEvents(status: number, windows: import("./rate-limits.js").RateLimitWindows) {
        try {
            if (!pi.events || typeof pi.events.emit !== "function") {
                debug("pi.events not available, skipping rate limit emission");
                return;
            }
            const rl = getRateLimitState();
            const baseEvent = {
                provider: PROVIDER_NAME,
                status,
                timestamp: Date.now(),
                windows,
                retryAfter: rl.retryAfter,
            };
            pi.events.emit("pi:rate-limits", baseEvent);
            // Emit rate-limited event on 429 with retry-after info
            if (status === 429 && rl.retryAfter) {
                const limitedEvent = {
                    ...baseEvent,
                    retryAfter: rl.retryAfter,
                    isRetryAfter: true,
                };
                pi.events.emit("pi:rate-limited", limitedEvent);
                debug("Emitted pi:rate-limited (429) event");
            }
            else {
                debug("Emitted pi:rate-limits event (status=%d)", status);
            }
        }
        catch (err) {
            debug("Failed to emit rate limit event:", err);
        }
    }

    /**
     * Record an active rate-limit wait so `/gwdg-status` reflects it and the
     * shared event bus can report the retry-after. Returns the absolute
     * timestamp at which the automatic retry will fire, which the notification
     * surfaces to the user. No footer/status-bar countdown is rendered — the
     * countdown lives in the one-shot notification instead.
     */
    function recordRateLimitWait(seconds: number): number {
        const resetAt = Date.now() + seconds * 1000;
        setRateLimitState({ retryAfter: { retryAfter: seconds, resetTimestamp: resetAt } });
        return resetAt;
    }

    /**
     * Core feedback for a rate-limit episode: on the wait path it drives the live
     * countdown banner; on the cancel path there is nothing to count down, so the
     * report is the rewritten error message on the cancelled turn (see
     * `buildCancelErrorMessage`) — which is also why the notification here is
     * skipped whenever such a message is coming (`pendingRateLimitCancel`).
     * Paths without an errored message (the `message_end`/`agent_end` fallback,
     * `/gwdg-simulate-ratelimit`) still notify, debounced.
     *
     * @param resetSec  true seconds until the provider quota resets (for display)
     * @param opts.willWait  whether the request will wait+retry (vs. be cancelled)
     * @param opts.maxWaitSec  the configured max-wait budget (for the message)
     * @param opts.windows  per-window snapshot to store for `/gwdg-status`
     * @param opts.simulated  no request behind this wait (`/gwdg-simulate-ratelimit`),
     *   so the banner's cancel hint needs the interrupt key wired up explicitly
     */
    function triggerRateLimitFeedback(
        ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
        resetSec: number,
        opts: { willWait: boolean; maxWaitSec: number; windows?: import("./rate-limits.js").RateLimitWindows; simulated?: boolean },
    ): void {
        if (opts.windows) setRateLimitState({ windows: opts.windows });
        debug("rate limit: reset=%ds willWait=%s", resetSec, opts.willWait);
        trace("triggerRateLimitFeedback: reset=%d willWait=%s maxWait=%d", resetSec, opts.willWait, opts.maxWaitSec);
        if (opts.willWait) {
            // Records the wait (retry timestamp aligned to the same reset the
            // interceptor sleeps on) and gives us the concrete moment the retry
            // fires, which the banner counts down to.
            const retryAt = recordRateLimitWait(resetSec);
            startRateLimitBanner(ctx, retryAt, opts.simulated
                ? {
                    // A real wait is cancelled by aborting the request; a simulated
                    // one has nothing to abort, so drop the recorded wait too or
                    // `/gwdg-status` keeps reporting "Rate limited? Yes", and say so
                    // — the cancelled turn is the real path's evidence, this has none.
                    onCancel: () => {
                        debug("simulate-ratelimit: cancelled via %s", interruptKeyText());
                        trace("simulate-ratelimit: interrupt key pressed — clearing simulated wait");
                        clearRateLimitWait();
                        try {
                            ctx.ui.notify("GWDG rate-limit simulation cancelled.", "info");
                        }
                        catch {
                            // ctx went stale — the banner is gone either way.
                        }
                    },
                }
                : undefined);
        }
        else {
            stopRateLimitBanner();
            // The interceptor's cancel path always produces an errored assistant
            // message, and `message_end` rewrites its text into the full
            // explanation — notifying here too would just duplicate it.
            if (!pendingRateLimitCancel) {
                const now = Date.now();
                if (now - lastRateLimitNotifyAt >= RATE_LIMIT_NOTIFY_DEBOUNCE_MS) {
                    // Same text the cancelled turn's error message carries, so
                    // there is one wording for "cancelled because of quota".
                    ctx.ui.notify(buildCancelErrorMessage({ resetSec, maxWaitSec: opts.maxWaitSec }, ""), "warning");
                    lastRateLimitNotifyAt = now;
                }
            }
        }
        if (isRateLimitEmitEnabled()) {
            emitRateLimitEvents(429, getRateLimitState().windows);
        }
    }

    /**
     * Fallback path: a terminal error surfaced as an assistant message. The
     * fetch wrapper handles in-flight 429s; this only catches 429s that reach
     * the extension as an errored assistant message (e.g. retries exhausted).
     * By the time this fires the request has already failed, so willWait=false.
     */
    function handleRateLimitError(errorMessage: string | undefined, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext): void {
        // Our own cancel report, seen again (message_end rewrites the message, then
        // agent_end delivers the rewritten one). Re-handling it would notify about
        // a cancel the message already explains.
        if (errorMessage?.includes(CANCEL_REPORT_MARKER)) {
            trace("handleRateLimitError: already our cancel report — skipping");
            return;
        }
        const matched = looksLikeRateLimit(errorMessage);
        debug("handleRateLimitError: looksLikeRateLimit=%s", matched);
        trace("handleRateLimitError: matched=%s errorMessage=%s", matched,
            errorMessage ? JSON.stringify(errorMessage.slice(0, 300)) : "(none)");
        if (!matched) return;
        triggerRateLimitFeedback(ctx, estimateResetSeconds(errorMessage), {
            willWait: false,
            maxWaitSec: getMaxRateLimitWaitSec(),
        });
    }

    /**
     * Pre-flight: hold this request back if a peer session has already found the
     * shared quota exhausted.
     *
     * GWDG counts quota per API key, but pi's rate-limit state is per process, so
     * without this every concurrent session has to burn its own request on a 429
     * to learn what a sibling already knows. `shared-state.ts` carries that
     * knowledge between processes; this is where it is acted on.
     *
     * Two deliberate limits:
     *
     *   - It only ever WAITS, never cancels. If the shared reset lies beyond
     *     `maxRateLimitWaitSec` we fall through and send anyway: the cancel path
     *     rewrites a real 429 response's headers and body, so letting the provider
     *     produce one is far more robust than synthesising a fake response here.
     *   - It waits at most once per request. A peer publishing a fresh limit
     *     during our wait does not extend it; if quota really is still gone, the
     *     429 loop below picks it up with a fresh decision. Looping here would let
     *     busy peers starve this session indefinitely.
     *
     * Fail-open throughout: any error means send the request as before.
     *
     * @param url for tracing only — the caller has already matched the host
     * @returns after the wait, or immediately if there is nothing to wait for
     */
    async function waitForSharedRateLimit(url: string, signal?: AbortSignal | null): Promise<void> {
        let plan: { waitMs: number; maxWaitSec: number; windows: import("./rate-limits.js").RateLimitWindows } | null = null;
        try {
            if (!isSharedRateLimitStateEnabled()) return;
            const shared = readSharedRateLimitState();
            if (!shared) return;
            const remainingMs = shared.resetTimestamp - Date.now();
            if (!(remainingMs > 0)) return;

            const maxWaitSec = getMaxRateLimitWaitSec();
            if (remainingMs > maxWaitSec * 1000) {
                trace("shared rate limit: peer reset %dms away exceeds max wait %ds — sending anyway",
                    remainingMs, maxWaitSec);
                return;
            }
            // Jitter so peers released by the same reset don't fire in lockstep
            // and instantly re-exhaust the window.
            const jitterMs = getSharedStateJitterMs();
            plan = {
                waitMs: remainingMs + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0),
                maxWaitSec,
                windows: shared.windows,
            };
        }
        catch (err) {
            trace("shared rate limit: pre-flight check failed (%s) — sending anyway",
                err instanceof Error ? err.message : String(err));
            return;
        }

        const waitSec = Math.ceil(plan.waitMs / 1000);
        trace("shared rate limit: peer limit active — waiting %ds before %s", waitSec, url);
        debug("shared rate limit: waiting %ds (peer session hit the quota)", waitSec);
        const ctx = feedbackCtx;
        if (ctx) {
            // Same countdown banner and event emission as a first-hand 429 — from
            // the user's side this IS a rate-limit wait, just one we were warned
            // about instead of discovering. An empty `windows` is withheld so a
            // peer with no snapshot cannot blank out our own /gwdg-status data.
            triggerRateLimitFeedback(ctx, waitSec, {
                willWait: true,
                maxWaitSec: plan.maxWaitSec,
                windows: Object.keys(plan.windows).length > 0 ? plan.windows : undefined,
            });
        }
        try {
            await abortableDelay(plan.waitMs, signal);
        }
        catch (err) {
            // ESC during the wait — drop the banner and let the abort propagate so
            // the request ends immediately.
            stopRateLimitBanner();
            throw err;
        }
        stopRateLimitBanner();
    }

    /**
     * Wrap globalThis.fetch to observe 429s from the configured GWDG endpoint.
     * Idempotent (guarded by a symbol) and defensive: any failure falls through
     * to the original fetch so a bug here can never break requests.
     */
    function installFetchInterceptor(providerBaseUrl: string): void {
        const g = globalThis as unknown as { fetch?: typeof fetch; __gwdgFetchPatched?: boolean };
        if (typeof g.fetch !== "function") {
            debug("installFetchInterceptor: globalThis.fetch unavailable — skipping");
            return;
        }
        if (g.__gwdgFetchPatched) {
            debug("installFetchInterceptor: already patched — skipping");
            return;
        }
        // Host to match against request URLs (e.g. "localhost:8787" or
        // "chat-ai.academiccloud.de"). Falls back to substring match on failure.
        let providerHost = "";
        try {
            providerHost = new URL(providerBaseUrl).host;
        }
        catch {
            providerHost = providerBaseUrl;
        }
        const originalFetch = g.fetch.bind(globalThis);

        const urlOf = (input: unknown): string => {
            if (typeof input === "string") return input;
            if (input && typeof input === "object") {
                const maybe = input as { url?: string };
                if (typeof maybe.url === "string") return maybe.url;
            }
            return String(input);
        };

        g.fetch = async function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
            // Pre-flight, before the request goes out: a peer session may already
            // have hit the shared quota. Host-matched first so this costs nothing
            // for the non-GWDG traffic that also passes through globalThis.fetch.
            const preflightUrl = urlOf(input);
            if (providerHost && preflightUrl.includes(providerHost)) {
                await waitForSharedRateLimit(preflightUrl, init?.signal as AbortSignal | undefined);
            }
            let res = await originalFetch(input as any, init as any);
            try {
                // Loop so repeated 429s are each handled with a fresh abortable
                // wait. The wait itself is done HERE (not delegated to the SDK via
                // Retry-After) so ESC interrupts it immediately — see below.
                while (res.status === 429) {
                    const url = urlOf(input);
                    if (!(providerHost && url.includes(providerHost))) break;
                    trace("fetch interceptor: 429 from %s", url);
                    const windows = extractRateLimitsFromHeaders(res.headers);
                    const ra = extractRetryAfter(res.headers);
                    // True provider reset (uncapped) — used both for the
                    // notification and to decide whether to wait. Prefer an
                    // explicit Retry-After/reset header, else the smallest
                    // exhausted window, else a conservative default.
                    let resetSec = ra?.retryAfter ?? 0;
                    if (!(resetSec > 0)) {
                        const resets: number[] = [];
                        for (const w of [windows.minute, windows.hour, windows.day, windows.month]) {
                            if (w && w.remaining <= 0 && w.reset > 0) resets.push(w.reset);
                        }
                        resetSec = resets.length ? Math.min(...resets) : DEFAULT_RATE_LIMIT_WAIT_SEC;
                    }

                    // Tell peer sessions before deciding what to do ourselves:
                    // they should hold off whether we wait or cancel.
                    if (isSharedRateLimitStateEnabled()) {
                        publishSharedRateLimitState({
                            resetTimestamp: Date.now() + resetSec * 1000,
                            windows,
                        });
                    }

                    const maxWaitSec = getMaxRateLimitWaitSec();
                    // Wait only if the reset is within the configured budget.
                    const willWait = resetSec > 0 && resetSec <= maxWaitSec;

                    // Recorded BEFORE the feedback fires: on the cancel path the
                    // errored assistant message (whose text `message_end` rewrites
                    // into the full explanation) is the user-facing report, so the
                    // feedback must know not to also notify. It also suppresses
                    // pi's agent-session auto-retry — see the message_end handler.
                    pendingRateLimitCancel = !willWait;
                    pendingRateLimitCancelDetail = willWait ? null : { resetSec, maxWaitSec };

                    const ctx = feedbackCtx;
                    if (ctx) {
                        triggerRateLimitFeedback(ctx, resetSec, { willWait, maxWaitSec, windows });
                    }
                    else {
                        trace("fetch interceptor: no feedbackCtx yet — cannot render banner/notification");
                        debug("fetch interceptor: 429 seen but no UI ctx captured yet");
                    }

                    if (!willWait) {
                        // Cancel path: fail immediately instead of blocking on a
                        // far-off reset. `x-should-retry:false` stops the SDK's own
                        // retry.
                        trace("fetch interceptor: cancelling — reset %ds exceeds max wait %ds", resetSec, maxWaitSec);
                        debug("fetch interceptor: reset %ds > max wait %ds — cancelling", resetSec, maxWaitSec);
                        const headers = new Headers(res.headers);
                        headers.delete("retry-after-ms");
                        headers.delete("retry-after");
                        headers.set("x-should-retry", "false");
                        const body = await res.text();
                        return new Response(body, {
                            status: res.status,
                            statusText: res.statusText,
                            headers,
                        });
                    }

                    // Wait path: perform the pause ourselves with an abortable
                    // delay, then retry directly. Delegating the wait to the SDK
                    // (via Retry-After) makes ESC laggy — the SDK's inter-retry
                    // sleep is not abortable, so a cancel is only observed after
                    // the full wait elapses. Doing it here means ESC aborts now.
                    trace("fetch interceptor: waiting — %ds (max wait %ds), abortable", resetSec, maxWaitSec);
                    debug("fetch interceptor: waiting %ds for reset (abortable)", resetSec);
                    // Drain the discarded 429 body so the connection is freed.
                    await res.text().catch(() => {});
                    try {
                        await abortableDelay(resetSec * 1000, init?.signal as AbortSignal | undefined);
                    }
                    catch (err) {
                        // ESC / cancellation during the wait — drop the banner and
                        // propagate the abort so the request ends immediately.
                        stopRateLimitBanner();
                        throw err;
                    }
                    // Reset reached: drop the banner (pi's plain working row is the
                    // truthful display again) and retry the request ourselves.
                    stopRateLimitBanner();
                    res = await originalFetch(input as any, init as any);
                    // Loop: a fresh 429 gets a fresh decision + wait.
                }
            }
            catch (err) {
                // Aborts MUST propagate so ESC actually cancels the request;
                // everything else is swallowed so inspection never breaks a request.
                if (isAbortError(err)) throw err;
                trace("fetch interceptor: error %s", err instanceof Error ? err.message : String(err));
            }
            return res;
        } as typeof fetch;

        g.__gwdgFetchPatched = true;
        debug("installFetchInterceptor: wrapped globalThis.fetch (host=%s)", providerHost);
        trace("installFetchInterceptor: wrapped globalThis.fetch (host=%s)", providerHost);
    }

    // Load config from files (global + project, env overrides)
    const cwd = process.cwd();
    refreshConfig(cwd);
    const { baseUrl } = config;
    const apiKey = cfgApiKey;
    debug("Extension starting (baseUrl: %s)", baseUrl);
    // -----------------------------------------------------------------------
    // Model discovery
    // -----------------------------------------------------------------------
    let models: import("@earendil-works/pi-coding-agent").ProviderModelConfig[];
    // Try cache first
    const cached = await loadModelsFromCache(baseUrl);
    if (cached && cached.length > 0) {
        models = cached;
        debug("Using %d cached models", models.length);
    }
    else if (apiKey) {
        // Fetch from API
        models = await fetchModelsFromApi(baseUrl, apiKey);
        if (models.length > 0) {
            await saveModelsToCache(models, baseUrl);
        }
    }
    else {
        models = [];
        debug("No API key set, registering with empty model list");
    }
    // -----------------------------------------------------------------------
    // Provider registration
    // -----------------------------------------------------------------------
    pi.registerProvider(PROVIDER_NAME, {
        baseUrl,
        apiKey: `$${ENV_VAR_KEY}`,
        api: "openai-completions",
        models,
    });
    recordProviderRegistration(models.length);
    // -----------------------------------------------------------------------
    // Env var registration (guarded by feature detection)
    // -----------------------------------------------------------------------
    if ("registerEnvVar" in pi) {
        try {
            (pi as any).registerEnvVar(ENV_VAR_KEY, {
                description: "GWDG AI services API key",
            });
        }
        catch {
            // registerEnvVar may not be available in all versions
        }
    }
    // -----------------------------------------------------------------------
    // Global fetch wrapper — the only layer that observes in-flight 429s.
    // The OpenAI SDK retries 429s internally (honouring Retry-After) within a
    // single request, so no pi event ever sees them. We wrap globalThis.fetch
    // (which pi points at undici, and which the SDK uses since the client is
    // built with no custom fetch), inspect responses, and drive the rate-limit
    // feedback on a 429 from our endpoint — returning the response untouched so
    // the SDK's own retry proceeds. globalThis is realm-wide, so this sidesteps
    // the module-duplication problem that broke the old OpenAI.prototype patch.
    // -----------------------------------------------------------------------
    installFetchInterceptor(baseUrl);

    // -----------------------------------------------------------------------
    // Event wiring
    // -----------------------------------------------------------------------
    pi.on("after_provider_response", (event: import("@earendil-works/pi-coding-agent").AfterProviderResponseEvent, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
        feedbackCtx = ctx;
        setDebugCtx(ctx);
        trace("after_provider_response: status=%s hasHeaders=%s", event.status, "headers" in event);
        // Only handle GWDG responses
        if (event.status === undefined)
            return;
        if (!("headers" in event))
            return;
        const headers = event.headers;
        // Extract per-window limits
        const windows = extractRateLimitsFromHeaders(headers);
        setRateLimitState({ windows });
        // A successful (non-error) response means the rate limit has recovered:
        // clear any active 429 wait state.
        if (event.status < 400 && getRateLimitState().retryAfter) {
            debug("after_provider_response: status %d — clearing active rate-limit wait", event.status);
            clearRateLimitWait();
        }
        // Publish the recovery (and the fresh window snapshot) so peers stop
        // holding off and get someone else's quota reading for free. Throttled
        // inside publishSharedRateLimitState; `resetTimestamp: 0` means "clear".
        if (event.status < 400 && isSharedRateLimitStateEnabled()) {
            publishSharedRateLimitState({ resetTimestamp: 0, windows });
        }
        // Emit rate-limit event on shared bus (if enabled)
        if (isRateLimitEmitEnabled()) {
            emitRateLimitEvents(event.status, windows);
        }
        // Update status with remaining quota (all windows)
        if (!config.hideFooter) {
            const w = windows;
            const parts = [];
            if (w.minute)
                parts.push(`m ${w.minute.remaining}/${w.minute.limit}  ⏱${formatWindowReset("minute", w.minute.reset)}`);
            if (w.hour)
                parts.push(`h ${w.hour.remaining}/${w.hour.limit}  ⏱${formatWindowReset("hour", w.hour.reset)}`);
            if (w.day)
                parts.push(`d ${w.day.remaining}/${w.day.limit}  ⏱${formatWindowReset("day", w.day.reset)}`);
            if (w.month)
                parts.push(`M ${w.month.remaining}/${w.month.limit}  ⏱${formatWindowReset("month", w.month.reset)}`);
            const footerTimeoutMs = getFooterTimeoutMs();
            if (parts.length > 0) {
                ctx.ui.setStatus("GWDG", ctx.ui.theme.fg("dim", parts.join(" · ")));
                // Auto-clear after configurable timeout (unless set to never).
                // Cancels any previously scheduled clear so a rapid sequence of
                // responses always gives the user a full `footerTimeoutSec` from
                // the most recent one.
                if (Number.isFinite(footerTimeoutMs) && footerTimeoutMs < Infinity) {
                    scheduleFooterClear("GWDG", ctx, footerTimeoutMs);
                }
            }
        }
    });
    // 429s never reach `after_provider_response` (the OpenAI SDK throws before
    // the onResponse callback fires). Pi surfaces the failure as an assistant
    // message with `stopReason: "error"` and an `errorMessage`. We observe that
    // on `message_end` (per-message granularity) and `agent_end` (per-run
    // fallback — covers versions/paths where message_end is not emitted for
    // error outputs). `handleRateLimitError` de-duplicates so at most one
    // notification fires per rate-limit episode.
    //
    // Suppressing pi's auto-retry on the CANCEL path (GWDG only)
    // -----------------------------------------------------------
    // pi has two retry layers. The OpenAI SDK's own retry (governed by
    // `retry.provider.maxRetries`, default 0) is already controlled by the
    // `x-should-retry` header we rewrite in the interceptor. But pi's
    // agent-session auto-retry (`retry.maxRetries`, default 3, 2s/4s/8s backoff)
    // sits ABOVE the SDK and re-runs the whole request. It decides purely from
    // the finalized assistant `errorMessage`: pi-ai's `isRetryableAssistantError`
    // first tests a NON-retryable pattern (quota/billing/usage-limit wording),
    // then a retryable pattern that matches "429"/"rate limit". A cancelled 429
    // therefore looks retryable and pi keeps retrying for ~14s before failing.
    //
    // To stop that WITHOUT touching global retry settings or other providers, we
    // use exactly the provider-scoped `message_end` errorMessage-rewrite pattern
    // the custom-provider docs prescribe (there for overflow normalization):
    // when the interceptor chose to cancel (`pendingRateLimitCancel`) and this
    // errored assistant message belongs to the GWDG provider, we replace pi's raw
    // provider error with prose that contains the NON-retryable phrase "quota
    // exceeded", so pi classifies it as non-retryable and skips its backoff loop.
    // `message_end` runs before pi's retry classification, so the rewrite is what
    // pi sees. The waiting path leaves the message untouched, so pi's retry stays
    // available as a backstop there.
    //
    // That rewritten message is ALSO the user-facing report for the cancel path
    // (`buildCancelErrorMessage`): the live banner only exists while we wait, and
    // a transcript entry cannot tick down, so the explanation — reset time, wait
    // budget, how to change it — belongs in the error the turn ends with.
    pi.on("message_end", (event: import("@earendil-works/pi-coding-agent").MessageEndEvent, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
        setDebugCtx(ctx);
        feedbackCtx = ctx;
        const msg = event.message;
        // Full trace of every message_end (file only, PI_GWDG_TRACE=1) so we
        // can see the exact role/stopReason/errorMessage the extension is given
        // on a 429 — without spamming the TUI.
        trace("message_end: role=%s stopReason=%s errorMessage=%s",
            msg?.role, msg?.stopReason,
            msg?.errorMessage ? JSON.stringify(msg.errorMessage.slice(0, 300)) : "(none)");
        // A finalized assistant turn means no request is in flight, so any banner
        // still up is stale. Widgets persist until cleared (unlike the working
        // row, which disappears on its own), so clear it defensively here.
        if (msg?.role === "assistant") stopRateLimitBanner();
        if (!msg || msg.role !== "assistant" || msg.stopReason !== "error") return;
        handleRateLimitError(msg.errorMessage, ctx);

        // Cancel path only: rewrite the errorMessage so pi does not auto-retry.
        // Scope strictly to GWDG (message provider or the active model's
        // provider) so other providers' rate-limit errors keep pi's retry.
        if (!pendingRateLimitCancel) return;
        pendingRateLimitCancel = false;
        const detail = pendingRateLimitCancelDetail;
        pendingRateLimitCancelDetail = null;
        const msgProvider = (msg as { provider?: string }).provider;
        const modelProvider = (ctx.model as { provider?: string } | undefined)?.provider;
        if (msgProvider !== PROVIDER_NAME && modelProvider !== PROVIDER_NAME) return;
        const original = msg.errorMessage ?? "";
        if (/quota exceeded/i.test(original)) return; // idempotent
        const rewritten = buildCancelErrorMessage(detail, original);
        trace("message_end: rewrote errorMessage to report the cancel + suppress pi auto-retry (gwdg)");
        debug("suppressing pi auto-retry for cancelled GWDG 429");
        return { message: { ...msg, errorMessage: rewritten } };
    });
    pi.on("agent_end", (event: import("@earendil-works/pi-coding-agent").AgentEndEvent, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
        setDebugCtx(ctx);
        feedbackCtx = ctx;
        const messages = Array.isArray(event.messages) ? event.messages : [];
        trace("agent_end: %d message(s): %s", messages.length,
            messages.map((m) => `${m?.role}:${m?.stopReason ?? "-"}`).join(", ") || "(empty)");
        // The run is over — no wait can still be pending, so drop a stale banner
        // (belt-and-braces for paths where message_end did not fire).
        stopRateLimitBanner();
        // Also surface any errorMessage present, regardless of stopReason, so we
        // learn whether the 429 text is here under a different shape.
        for (const m of messages) {
            if (m?.role === "assistant" && m?.errorMessage) {
                trace("agent_end: assistant errorMessage=%s", JSON.stringify(m.errorMessage.slice(0, 300)));
            }
        }
        // Most recent errored assistant message wins.
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && m.role === "assistant" && m.stopReason === "error") {
                handleRateLimitError(m.errorMessage, ctx);
                break;
            }
        }
    });
    pi.on("session_shutdown", (_event: import("@earendil-works/pi-coding-agent").SessionShutdownEvent, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
        clearDebugCtx();
        // Cancel any pending footer auto-clear
        if (footerClearTimer) {
            clearTimeout(footerClearTimer);
            footerClearTimer = null;
        }
        // Clear any active rate-limit wait state (also removes the banner widget)
        clearRateLimitWait();
        try {
            ctx.ui.setStatus("GWDG", undefined);
            // Belt-and-braces: clear the banner key through THIS ctx too, in case
            // the widget was installed via an earlier one.
            ctx.ui.setWidget(RATE_LIMIT_WIDGET_KEY, undefined);
        }
        catch {
            // ctx may be stale during shutdown
        }
    });
    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------
    // Diagnostic: drive the 429 feedback path directly, without needing a real
    // (or proxied) rate-limit response — isolating the UI from event
    // delivery/detection.
    // Simulates a provider reset of N seconds. If N is within the configured
    // maxRateLimitWaitSec it demos the countdown banner (which self-clears when
    // the simulated reset elapses, or on the interrupt key — see `simulated`
    // below, since there is no request whose abort would end the wait); if N
    // exceeds it, the cancel report. Default 30s. Note that on the cancel path a
    // real 429 puts this text on the errored assistant turn instead of in a
    // notification — there is no request here to attach it to, so it is shown as
    // a notification.
    //   /gwdg-simulate-ratelimit          → 30s reset
    //   /gwdg-simulate-ratelimit 600      → 10min reset (demonstrates cancel)
    pi.registerCommand("gwdg-simulate-ratelimit", {
        description: "Simulate a 429 rate-limit response to test the countdown banner / cancel report",
        handler: async (args: string | undefined, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
            setDebugCtx(ctx);
            const parsed = args ? parseInt(args.trim(), 10) : NaN;
            const resetSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
            const maxWaitSec = getMaxRateLimitWaitSec();
            const willWait = resetSec > 0 && resetSec <= maxWaitSec;
            debug("simulate-ratelimit: reset=%ds willWait=%s (maxWait=%ds)", resetSec, willWait, maxWaitSec);
            // Reset any in-flight wait / debounce so the feedback re-fires.
            clearRateLimitWait();
            lastRateLimitNotifyAt = 0;
            triggerRateLimitFeedback(ctx, resetSec, { willWait, maxWaitSec, simulated: true });
        },
    });
    pi.registerCommand("gwdg-status", {
        description: "Show GWDG connection status, current rate limits, and model count",
        handler: async (_args: string | undefined, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
            const rl = getRateLimitState();
            const sharedEnabled = isSharedRateLimitStateEnabled();
            const shared = getSharedStateDiagnostics(sharedEnabled);
            const currentProvider = ctx.model?.provider;
            const lines = [];
            lines.push("GWDG Provider Status");
            lines.push(`├─ Endpoint: ${config.baseUrl}`);
            lines.push(`├─ API key: ${cfgApiKey ? "✅ configured" : "❌ not set"} (env: ${ENV_VAR_KEY})`);
            lines.push(`├─ Active: ${currentProvider === PROVIDER_NAME ? "✅ yes" : "❌ no (select a GWDG model with /model)"}`);
            lines.push(`├─ Models: ${models.length} cached`);
            // Config summary
            lines.push("├─ Config:");
            lines.push(`│  ├─ Cache TTL: ${config.modelCacheTtlDays}d`);
            lines.push(`│  ├─ Footer timeout: ${config.footerTimeoutSec}s`);
            lines.push(`│  ├─ Max rate-limit wait: ${config.maxRateLimitWaitSec === 0 ? "never (fail on 429)" : config.maxRateLimitWaitSec + "s"}`);
            lines.push(`│  ├─ Hide footer: ${config.hideFooter}`);
            lines.push(`│  ├─ Debug: ${config.debug}`);
            lines.push(`│  └─ Shared rate limits: ${sharedEnabled ? `on (jitter ${config.sharedStateJitterMs}ms)` : "off"}`);
            // Cross-session shared state
            if (!sharedEnabled) {
                lines.push("├─ Shared state: disabled");
            }
            else {
                lines.push("├─ Shared state:");
                lines.push(`│  ├─ File: ${shared.path ?? "(unresolved)"}`);
                if (!shared.state) {
                    lines.push("│  └─ (no peer data yet — nothing published to this file)");
                }
                else {
                    const resetIn = Math.ceil((shared.state.resetTimestamp - Date.now()) / 1000);
                    lines.push(`│  ├─ Peer limit: ${resetIn > 0 ? `resets in ${resetIn}s` : "none active"}`);
                    const ageSec = Math.max(0, Math.round((Date.now() - shared.state.writtenAt) / 1000));
                    const byUs = shared.state.pid === process.pid;
                    lines.push(`│  └─ Updated: ${ageSec}s ago (pid ${shared.state.pid}${byUs ? " — this session" : ""})`);
                }
            }
            // Rate limits
            const w = rl.windows;
            lines.push("├─ Rate limits:");
            if (w.minute) {
                lines.push(`│  ├─ Minute: ${w.minute.remaining}/${w.minute.limit} remaining`);
            }
            if (w.hour) {
                lines.push(`│  ├─ Hour:   ${w.hour.remaining}/${w.hour.limit} remaining`);
            }
            if (w.day) {
                lines.push(`│  └─ Day:    ${w.day.remaining}/${w.day.limit} remaining`);
            }
            if (!w.minute && !w.hour && !w.day) {
                lines.push("│  └─ (no rate limit data yet — make a request first)");
            }
            lines.push(`└─ Rate limited? ${rl.retryAfter ? `Yes (resets in ${Math.ceil((rl.retryAfter.resetTimestamp - Date.now()) / 1000)}s)` : "No"}`);
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });
    pi.registerCommand("gwdg-info", {
        description: "Show details for a specific GWDG model",
        handler: async (args: string | undefined, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
            const modelId = args?.trim();
            if (!modelId) {
                ctx.ui.notify("Usage: /gwdg-info <model-id>", "warning");
                return;
            }
            // Find model from currently registered models
            let model = ctx.modelRegistry.find(PROVIDER_NAME, modelId);
            if (!model) {
                ctx.ui.notify(`Model "${modelId}" not found in GWDG provider.`, "error");
                return;
            }
            const lines = [];
            lines.push(`Model: ${model.id}`);
            lines.push(`├─ Capabilities: ${model.input.join(", ")}`);
            lines.push(`├─ Context window: ${model.contextWindow.toLocaleString()} tokens`);
            lines.push(`├─ Max output: ${model.maxTokens.toLocaleString()} tokens`);
            lines.push(`├─ Reasoning: ${model.reasoning}`);
            lines.push(`└─ Cost: free (all zero)`);
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });
    pi.registerCommand("gwdg-models", {
        description: "List all available GWDG models with their capabilities",
        handler: async (_args: string | undefined, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
            // Get all GWDG models from the registry
            const allModels = ctx.modelRegistry.getAll().filter((m: { provider: string }) => m.provider === PROVIDER_NAME);
            if (allModels.length === 0) {
                ctx.ui.notify("No GWDG models available. Run /gwdg-refresh to fetch them.", "warning");
                return;
            }
            const textModels = allModels.filter((m: { input: string[]; id: string }) => m.input.length === 1 && m.input[0] === "text");
            const visionModels = allModels.filter((m: { input: string[]; id: string }) => m.input.includes("image"));
            const embeddingModels = allModels.filter((m: { id: string }) => m.id.toLowerCase().includes("embed") || m.id.toLowerCase().includes("e5-"));
            // Build ordered list of non-empty groups
            const groups = [];
            if (textModels.length > 0)
                groups.push({ label: "Text", models: textModels });
            if (visionModels.length > 0)
                groups.push({ label: "Vision", models: visionModels });
            if (embeddingModels.length > 0)
                groups.push({ label: "Embeddings", models: embeddingModels });
            const lines = [];
            lines.push(`GWDG Models (${allModels.length} total)`);
            for (let gi = 0; gi < groups.length; gi++) {
                const g = groups[gi];
                const isLastGroup = gi === groups.length - 1;
                lines.push(`${isLastGroup ? "└─" : "├─"} ${g.label} models (${g.models.length}):`);
                for (let i = 0; i < g.models.length; i++) {
                    const isLastModel = i === g.models.length - 1;
                    // When this is the last group, no vertical bar is needed (no sibling groups below)
                    const connector = isLastGroup ? "   " : "│  ";
                    const branch = isLastModel ? "└─" : "├─";
                    lines.push(`${connector}${branch} ${g.models[i].id}`);
                }
            }
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });
    pi.registerCommand("gwdg-refresh", {
        description: "Force-fetch models from the GWDG API, update cache, and re-register the provider",
        handler: async (_args: string | undefined, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
            // Re-read config (may have new API key, changed baseUrl, etc.)
            refreshConfig(process.cwd(), true);
            if (!cfgApiKey) {
                ctx.ui.notify("Cannot refresh: GWDG_API_KEY is not set.", "error");
                return;
            }
            ctx.ui.notify(`Fetching models from ${config.baseUrl}...`, "info");
            const freshModels = await fetchModelsFromApi(config.baseUrl, cfgApiKey);
            if (freshModels.length === 0) {
                ctx.ui.notify("Failed to fetch models from API. Check your API key and network.", "error");
                return;
            }
            // Save to cache
            await saveModelsToCache(freshModels, config.baseUrl);
            models = freshModels;
            recordProviderRegistration(freshModels.length);
            // Re-register the provider with fresh models
            pi.registerProvider(PROVIDER_NAME, {
                baseUrl: config.baseUrl,
                apiKey: `$${ENV_VAR_KEY}`,
                api: "openai-completions",
                models: freshModels,
            });
            ctx.ui.notify(`Refreshed: ${freshModels.length} models loaded from GWDG API.`, "info");
        },
    });
    // -----------------------------------------------------------------------
    // Settings command (interactive TUI)
    // -----------------------------------------------------------------------
    pi.registerCommand("gwdg-settings", {
        description: "Interactive settings editor for pi-gwdg (TUI). Pass \"global\" to save to global config (${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg.json), or \"project\" (default) for project-local (.pi/gwdg.json).",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
            const filtered = gwdgSettingsScopeItems().filter((i) => i.value.startsWith(prefix));
            return filtered.length > 0 ? filtered : null;
        },
        handler: async (args: string | undefined, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/gwdg-settings requires TUI mode", "error");
                return;
            }
            // Parse scope argument: "global" or "project" (default)
            const scope = args?.trim() || "project";
            const useGlobal = scope === "global";
            const persistPath = useGlobal
                ? join(getAgentDir(), "extensions", "gwdg.json")
                : join(process.cwd(), ".pi", "gwdg.json");
            await ctx.ui.custom((tui: unknown, theme: import("@earendil-works/pi-coding-agent").Theme, _kb: unknown, done: (result: undefined) => void) => {
                let dirty = false;
                function markDirty() { dirty = true; }

                // Build setting items from current config state (inside callback so theme is available)
                const items = [
                    {
                        id: "hideFooter",
                        label: "Hide status footer",
                        currentValue: config.hideFooter ? "yes" : "no",
                        values: ["no", "yes"],
                    },
                    {
                        id: "debug",
                        label: "Debug logging",
                        currentValue: config.debug ? "yes" : "no",
                        values: ["no", "yes"],
                    },
                    {
                        id: "footerTimeoutSec",
                        label: "Footer timeout",
                        currentValue: toFooterLabel(config.footerTimeoutSec),
                        values: ["5s", "10s", "15s", "30s", "60s", "never"],
                    },
                    {
                        id: "modelCacheTtlDays",
                        label: "Model cache TTL",
                        currentValue: toCacheTtlLabel(config.modelCacheTtlDays),
                        values: ["1d", "7d", "14d", "30d", "60d", "90d", "180d", "365d"],
                    },
                    {
                        id: "emitRateLimitEvents",
                        label: "Emit rate limit events",
                        currentValue: config.emitRateLimitEvents ? "yes" : "no",
                        values: ["no", "yes"],
                    },
                    {
                        id: "maxRateLimitWaitSec",
                        label: "Max rate-limit wait",
                        currentValue: toWaitLabel(config.maxRateLimitWaitSec),
                        values: ["never", "30s", "60s", "120s", "300s", "600s"],
                    },
                    {
                        id: "sharedRateLimitState",
                        label: "Share rate limits across sessions",
                        currentValue: config.sharedRateLimitState ? "yes" : "no",
                        values: ["no", "yes"],
                    },
                    {
                        id: "sharedStateJitterMs",
                        label: "Shared-state wake jitter",
                        currentValue: toJitterLabel(config.sharedStateJitterMs),
                        values: ["0ms", "250ms", "500ms", "1000ms", "2000ms", "5000ms"],
                    },
                    {
                        id: "modelOverrides",
                        label: "Model overrides",
                        currentValue: `${getOverrideModelIds().length} override(s)`,
                        submenu: (currentValue: string, submenuDone: (result: string) => void) =>
                            createOverrideSubmenu(currentValue, submenuDone, ctx, theme, persistPath),
                    },
                ];
                const container = new Container();
                // Top border
                container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
                // Title
                container.addChild(new (class {
                    render(_w: number) {
                        const scopeLabel = useGlobal ? "global" : "project";
                        return ["", theme.fg("accent", theme.bold(`pi-gwdg Settings [${scopeLabel}]`)), ""];
                    }
                    invalidate() { }
                })());
                const settingsList = new SettingsList(items, Math.min(items.length + 2, 15), getSettingsListTheme(), 
                // On toggle: apply live, don't persist yet
                (id: string, newValue: string) => {
                    applySettingChange(id, newValue);
                    markDirty();
                }, 
                // On close: persist all current values to project config file
                () => {
                    // Every toggle the dialog offers must be listed here or the
                    // change is applied live and then silently lost on close.
                    // `sharedStateDir` is deliberately absent: it has no dialog
                    // entry, so writing it would only overwrite a config-file value
                    // with whatever happened to be resolved.
                    const settings: Record<string, import("./config.js").SettingValue | Record<string, unknown>> = {
                        hideFooter: config.hideFooter,
                        debug: config.debug,
                        footerTimeoutSec: config.footerTimeoutSec,
                        modelCacheTtlDays: config.modelCacheTtlDays,
                        emitRateLimitEvents: config.emitRateLimitEvents,
                        maxRateLimitWaitSec: config.maxRateLimitWaitSec,
                        sharedRateLimitState: config.sharedRateLimitState,
                        sharedStateJitterMs: config.sharedStateJitterMs,
                    };
                    // Only persist modelOverrides when non-empty so that an
                    // empty `{}` from a user who never opened the overrides
                    // submenu does NOT wipe the global or project overrides
                    // file on the next load.
                    const overrideKeys = Object.keys(config.modelOverrides ?? {});
                    if (overrideKeys.length > 0) {
                        settings.modelOverrides = config.modelOverrides;
                        markDirty();
                    }
                    if (!dirty) {
                        // Nothing changed — skip writing entirely.
                        // If the file already exists, it's left untouched.
                        done(undefined);
                        return;
                    }
                    persistSettings(settings, persistPath);
                    const scopeLabel = useGlobal ? `${persistPath} (global)` : `.pi/gwdg.json (project)`;
                    ctx.ui.notify(`Settings saved to ${scopeLabel}`, "info");
                    done(undefined);
                });
                container.addChild(settingsList);
                // Help text
                container.addChild(new (class {
                    render(_w: number) {
                        return ["", theme.fg("dim", "↑↓ navigate • space/enter toggle • esc save & close")];
                    }
                    invalidate() { }
                })());
                // Bottom border
                container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
                return {
                    render(w: number) {
                        return container.render(w);
                    },
                    invalidate() {
                        container.invalidate();
                    },
                    handleInput(data: string) {
                        settingsList.handleInput?.(data);
                        (tui as { requestRender: () => void }).requestRender();
                    },
                };
            });
        },
    });
    /**
     * Parse a SettingsList value back to the proper type and apply it live
     * to the module-level config singleton.
     */
    // ========================================================================
    // Model Override Submenu
    // ========================================================================

    /**
     * Build a TUI component for managing per-model overrides.
     *
     * Screens:
     *   "list"   → Show existing overrides + "Add model override" entry
     *   "picker" → SelectList of GWDG models to add a new override for
     *   "editor" → Field editor with ↑↓ navigation, space/enter to toggle
     *   "confirm"→ Delete confirmation
     */
    function createOverrideSubmenu(
        currentValue: string,
        done: (result: string) => void,
        ctxRef: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
        theme: import("@earendil-works/pi-coding-agent").Theme,
        persistPath: string,
    ): import("@earendil-works/pi-tui").Component {
        type SubmenuScreen = "list" | "picker" | "editor" | "customInput" | "confirm" | "thinkingLevelMap";
        let screen: SubmenuScreen = "list";
        let editorModelId: string | null = null;
        let editorFieldIndex = 0;
        let editorCursorIdx = 0;
        let selectedListIndex = 0;
        let confirmAction: { type: string; modelId: string } | null = null;
        let pickerComponent: import("@earendil-works/pi-tui").SelectList | null = null;
        let customInputComponent: import("@earendil-works/pi-tui").Component | null = null;
        let customFieldKey: string | null = null;
        let confirmChoice = 1; // 0 = yes, 1 = no (no selected by default)

        /** Index into the THINKING_LEVELS array for the thinking level map submenu. */
        let tlEditorLevelIndex = 0;
        /**
         * Cursor state for the current thinking level: 0 = level name as value,
         * 1 = "custom" (opens input prompt).
         */
        let tlEditorValueState = 0;

        /** Get all GWDG model IDs from the registry */
        function getAllGwdgModelIds() {
            try {
                const allModels = ctxRef.modelRegistry.getAll();
                return allModels
                    .filter((m: { provider: string }) => m.provider === PROVIDER_NAME)
                    .map((m: { id: string }) => m.id);
            } catch {
                return [];
            }
        }

        /**
         * Build entries for the list screen.
         * Returns { label, description, modelId? } for each entry.
         */
        function getOverrideListEntries() {
            const entries: { label: string; description: string; modelId?: string }[] = [];
            const ids = getOverrideModelIds();
            for (const id of ids) {
                const ov = getModelOverride(id);
                const parts = [];
                if (ov?.maxTokens !== undefined) parts.push(`maxTokens: ${ov.maxTokens}`);
                if (ov?.contextWindow !== undefined) parts.push(`ctx: ${ov.contextWindow}`);
                if (ov?.reasoning !== undefined) parts.push(`reasoning: ${ov.reasoning}`);
                if (ov?.input !== undefined) parts.push(`input: ${ov.input.join("+")}`);
                const desc = parts.length > 0 ? parts.join(", ") : "(empty override)";
                entries.push({ label: id, description: desc, modelId: id });
            }
            // Sort alphabetically
            entries.sort((a, b) => a.label.localeCompare(b.label));
            return entries;
        }

        function buildPickerItems(): import("@earendil-works/pi-tui").SelectItem[] {
            const allGwdgModels = getAllGwdgModelIds();
            const existing = new Set(getOverrideModelIds());
            const available = allGwdgModels.filter((id: string) => !existing.has(id));
            if (available.length === 0) {
                return [{ value: "__no_models", label: "(no more models to add)" }];
            }
            return available.map((id: string) => ({
                value: id,
                label: id,
                description: `Context: ${ctxRef.modelRegistry.find(PROVIDER_NAME, id)?.contextWindow ?? "?"}`,
            }));
        }

        /** Fields for the editor screen. */
        const editorFields: { key: string; label: string; format: (v: unknown) => string; isSubmenu?: boolean }[] = [
            { key: "maxTokens", label: "Max tokens", format: (v: unknown) => `${v}` },
            { key: "contextWindow", label: "Context window", format: (v: unknown) => `${v}` },
            { key: "reasoning", label: "Reasoning", format: (v: unknown) => `${v}` },
            { key: "input", label: "Input", format: (v: unknown) => Array.isArray(v) ? v.join("+") : "" },
            {
                key: "thinkingLevelMap",
                label: "Thinking level map",
                format: (v: unknown) => {
                    if (typeof v !== "object" || v === null) return "—";
                    const entries = Object.entries(v as Record<string, unknown>).filter(([_, val]) => val !== undefined);
                    return entries.length > 0 ? `${entries.length} level(s) mapped` : "—";
                },
                isSubmenu: true,
            },
        ];

        /** The seven pi thinking levels in display order. */
        const THINKING_LEVELS: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"> = [
            "off", "minimal", "low", "medium", "high", "xhigh", "max",
        ];

        /** Cycle values for field types. */
        const cycles: Record<string, number[]> = {
            maxTokens: [4096, 8192, 16384, 32768, 65536, 128000],
            contextWindow: [8000, 16000, 32000, 64000, 128000, 200000],
        };

        /** Get the ordered list of preset options for a field (without "custom"). */
        function getPresetOptions(key: string): unknown[] {
            if (key === "reasoning") return [false, true];
            if (key === "input") return [["text"], ["text", "image"]];
            return cycles[key] || [4096, 8192];
        }

        /** Format a raw value for display. */
        function formatOptionValue(key: string, val: unknown): string {
            if (key === "input") return Array.isArray(val) ? (val as string[]).join(" + ") : String(val);
            return String(val);
        }

        /**
         * Render inline options: value - opt1 - *opt2* - ... - custom
         * The highlighted option (cursor position) gets accent color.
         */
        function renderFieldOptionsLine(key: string, currentVal: unknown, cursorIdx: number): string {
            const presets = getPresetOptions(key);
            const parts: string[] = [];
            for (let i = 0; i < presets.length; i++) {
                const label = formatOptionValue(key, presets[i]);
                if (i === cursorIdx) {
                    parts.push(theme.fg("accent", label));
                } else {
                    parts.push(label);
                }
            }
            // "custom" at the end
            if (cursorIdx === presets.length) {
                parts.push(theme.fg("accent", "custom"));
            } else {
                parts.push("custom");
            }
            return parts.join(" - ");
        }

        /**
         * Get the total option count (presets + "custom").
         */
        function getOptionCount(key: string): number {
            return getPresetOptions(key).length + 1; // +1 for "custom"
        }

        /**
         * Resolve the cursor index for a field given its current value.
         * If value is undefined or not a preset, cursor lands on "custom".
         */
        function cursorIndexForValue(key: string, val: unknown): number {
            if (val === undefined) return getPresetOptions(key).length; // "custom"
            const presets = getPresetOptions(key);
            const idx = presets.findIndex((o: unknown) => String(o) === String(val));
            return idx >= 0 ? idx : presets.length; // "custom" if not found
        }

        /** Sync editorCursorIdx to the currently-selected field's stored value. */
        function syncCursorToField() {
            if (editorModelId === null) return;
            const ov = getModelOverride(editorModelId);
            const key = editorFields[editorFieldIndex]?.key;
            const field = editorFields[editorFieldIndex];
            if (field?.isSubmenu) return; // submenu fields have no inline cursor
            if (key && ov && key in editorFieldKeys()) {
                editorCursorIdx = cursorIndexForValue(key, (ov as any)[key]);
            }
        }
        function editorFieldKeys(): string[] {
            return editorFields.map((f) => f.key);
        }

        return {
            render(w) {
                const lines = [];

                if (screen === "list") {
                    const entries = getOverrideListEntries();
                    const startIndex = Math.max(0, Math.min(selectedListIndex - 4, entries.length - 9));
                    const endIndex = Math.min(startIndex + 10, entries.length);

                    // Title
                    lines.push("  Model Overrides");
                    lines.push("");

                    if (entries.length === 0) {
                        lines.push("    (no overrides configured)");
                        lines.push("");
                    } else {
                        for (let i = startIndex; i < endIndex; i++) {
                            const entry = entries[i];
                            const isSel = i === selectedListIndex;
                            const prefix = isSel ? theme.fg("accent", "→ ") : "  ";
                            const label = isSel ? theme.fg("accent", entry.label) : entry.label;
                            const desc = isSel ? theme.fg("accent", entry.description) : entry.description;
                            lines.push(`${prefix}${label}`);
                            lines.push(`    ${desc}`);
                        }
                        if (startIndex > 0 || endIndex < entries.length) {
                            lines.push(`  (${selectedListIndex + 1}/${entries.length})`);
                        }
                        lines.push("");
                    }

                    // Add override entry
                    const addSel = selectedListIndex === entries.length;
                    const addPrefix = addSel ? theme.fg("accent", "→ ") : "  ";
                    const addLabel = addSel ? theme.fg("accent", "+ Add model override") : "+ Add model override";
                    lines.push(`${addPrefix}${addLabel}`);
                    lines.push("");
                    lines.push("  ↑↓ to navigate • Enter to select • Esc to go back");
                    return lines;
                }

                if (screen === "picker") {
                    if (pickerComponent) {
                        return pickerComponent.render(w);
                    }
                    return ["  (loading picker...)"];
                }

                if (screen === "editor") {
                    if (editorModelId === null) return ["  (no model selected)"];
                    const modelId: string = editorModelId;
                    const ov = getModelOverride(modelId);
                    lines.push(`  Editing: ${modelId}`);
                    lines.push("");
                    for (let i = 0; i < editorFields.length; i++) {
                        const field = editorFields[i];
                        const isSel = i === editorFieldIndex;
                        const prefix = isSel ? theme.fg("accent", "→ ") : "  ";
                        const val = ov ? (ov as Record<string, unknown>)[field.key] : undefined;

                        if (field.isSubmenu) {
                            // Submenu field — show value summary, no inline options
                            const display = field.format(val);
                            const editHint = isSel ? theme.fg("accent", "[Edit]") : "[Edit]";
                            const line = isSel
                                ? theme.fg("accent", `${field.label}: ${display}`)
                                : `${field.label}: ${display}`;
                            lines.push(`${prefix}${line}  ${editHint}`);
                        } else {
                            const display = val !== undefined ? formatOptionValue(field.key, val) : "—";
                            const fieldCursor = isSel ? editorCursorIdx : cursorIndexForValue(field.key, val);
                            const line = isSel
                                ? theme.fg("accent", `${field.label}: ${display}`)
                                : `${field.label}: ${display}`;
                            lines.push(`${prefix}${line}  ${renderFieldOptionsLine(field.key, val, fieldCursor)}`);
                        }
                    }
                    // Delete entry
                    const delSel = editorFieldIndex === editorFields.length;
                    const delPrefix = delSel ? theme.fg("accent", "→ ") : "  ";
                    const delLabel = delSel ? theme.fg("accent", "[Delete this override]") : "[Delete this override]";
                    lines.push(`${delPrefix}${delLabel}`);
                    lines.push("");
                    lines.push("  ↑↓ navigate ←→ select option • Enter custom • Esc back");
                    return lines;
                }

                if (screen === "customInput") {
                    if (customInputComponent) {
                        return customInputComponent.render(w);
                    }
                    return ["  (loading input...)"];
                }

                if (screen === "confirm") {
                    lines.push("  Delete override?");
                    lines.push("");
                    lines.push("    Are you sure you want to delete");
                    lines.push(`    the override for "${confirmAction?.modelId ?? "?"}"?`);
                    lines.push("");
                    const yesLabel = confirmChoice === 0 ? theme.fg("accent", "Yes") : "Yes";
                    const noLabel = confirmChoice === 1 ? theme.fg("accent", "No") : "No";
                    lines.push(`    ${yesLabel}  •  ${noLabel}`);
                    lines.push("");
                    lines.push("  ←→ switch • Enter confirm • Esc back");
                    return lines;
                }

                if (screen === "thinkingLevelMap") {
                    if (editorModelId === null) return ["  (no model selected)"];
                    const modelId: string = editorModelId;
                    const ov = getModelOverride(modelId);
                    const map: Partial<Record<string, string | null>> = ov?.thinkingLevelMap ?? {};
                    lines.push(`  Thinking map for: ${modelId}`);
                    lines.push("");
                    for (let i = 0; i < THINKING_LEVELS.length; i++) {
                        const level = THINKING_LEVELS[i];
                        const isSel = i === tlEditorLevelIndex;
                        const prefix = isSel ? theme.fg("accent", "→ ") : "  ";
                        const val = map[level];
                        let status: string;
                        let indicator: string;
                        if (val === undefined) {
                            status = "—";
                            indicator = "(omitted)";
                        } else if (val === null) {
                            status = "✗";
                            indicator = "null (unsupported)";
                        } else {
                            status = "✓";
                            indicator = `"${val}"`;
                        }
                        const levelLabel = level.padEnd(8);
                        const line = isSel
                            ? theme.fg("accent", `${prefix}${levelLabel} ${status} ${indicator}`)
                            : `${prefix}${levelLabel} ${status} ${indicator}`;
                        lines.push(line);
                    }
                    lines.push("");
                    lines.push("  ↑↓ navigate • Enter toggle • ←→ change value • Esc back");
                    return lines;
                }

                return ["  (unknown screen)"];
            },

            invalidate() {},

            handleInput(data) {
                if (screen === "list") {
                    const entries = getOverrideListEntries();
                    const maxIndex = entries.length; // entries + "Add" entry

                    if (data === "ArrowUp" || data === "\x1b[A") {
                        selectedListIndex = (selectedListIndex - 1 + maxIndex + 1) % (maxIndex + 1);
                        return;
                    }
                    if (data === "ArrowDown" || data === "\x1b[B") {
                        selectedListIndex = (selectedListIndex + 1) % (maxIndex + 1);
                        return;
                    }
                    if (data === "\r" || data === "\n" || data === " ") {
                        if (selectedListIndex === entries.length) {
                            // "Add model override" selected — open picker
                            const allGwdgModels = getAllGwdgModelIds();
                            const existing = new Set(getOverrideModelIds());
                            const available = allGwdgModels.filter((id) => !existing.has(id));
                            if (available.length === 0) {
                                return; // No models to add
                            }
                            const pickerItems = buildPickerItems();
                            pickerComponent = new SelectList(
                                pickerItems,
                                12,
                                getSelectListTheme(),
                            );
                            pickerComponent.onSelect = (item) => {
                                if (item.value === "__no_models") return;
                                pickerComponent = null;
                                editorModelId = item.value;
                                editorFieldIndex = 0;
                                syncCursorToField();
                                screen = "editor";
                            };
                            pickerComponent.onCancel = () => {
                                screen = "list";
                                pickerComponent = null;
                            };
                            screen = "picker";
                        } else {
                            // Edit existing override
                            const entry = entries[selectedListIndex];
                            if (entry.modelId === undefined) return;
                            editorModelId = entry.modelId;
                            editorFieldIndex = 0;
                            syncCursorToField();
                            screen = "editor";
                        }
                        return;
                    }
                    if (data === "\x1b" || data === "Escape") {
                        done(`${getOverrideModelIds().length} override(s)`);
                        return;
                    }
                    return;
                }

                if (screen === "picker") {
                    if (pickerComponent) {
                        pickerComponent.handleInput(data);
                        return;
                    }
                    return;
                }

                if (screen === "editor") {
                    if (data === "\x1b" || data === "Escape") {
                        // Esc: go back to override list
                        screen = "list";
                        editorModelId = null;
                        editorFieldIndex = 0;
                        return;
                    }
                    if (data === "ArrowUp" || data === "\x1b[A") {
                        editorFieldIndex = (editorFieldIndex - 1 + editorFields.length + 1) % (editorFields.length + 1);
                        syncCursorToField();
                        return;
                    }
                    if (data === "ArrowDown" || data === "\x1b[B") {
                        editorFieldIndex = (editorFieldIndex + 1) % (editorFields.length + 1);
                        syncCursorToField();
                        return;
                    }
                    if (data === "ArrowLeft" || data === "\x1b[D") {
                        if (editorFieldIndex === editorFields.length) return; // delete entry, no options
                        const field = editorFields[editorFieldIndex];
                        if (field.isSubmenu) return; // submenu field — no inline options
                        const count = getOptionCount(field.key);
                        editorCursorIdx = (editorCursorIdx - 1 + count) % count;
                        return;
                    }
                    if (data === "ArrowRight" || data === "\x1b[C") {
                        if (editorFieldIndex === editorFields.length) return; // delete entry, no options
                        const field = editorFields[editorFieldIndex];
                        if (field.isSubmenu) return; // submenu field — no inline options
                        const count = getOptionCount(field.key);
                        editorCursorIdx = (editorCursorIdx + 1) % count;
                        return;
                    }
                    if (data === "\r" || data === "\n" || data === " ") {
                        if (editorFieldIndex === editorFields.length) {
                            // Delete entry selected
                            if (editorModelId === null) return;
                            confirmAction = { type: "delete", modelId: editorModelId };
                            confirmChoice = 1; // "No" by default
                            screen = "confirm";
                            return;
                        }
                        const field = editorFields[editorFieldIndex];
                        if (editorModelId === null) return;

                        if (field.isSubmenu) {
                            // Open submenu (thinkingLevelMap editor)
                            tlEditorLevelIndex = 0;
                            tlEditorValueState = 0;
                            screen = "thinkingLevelMap";
                            return;
                        }

                        const ov = getModelOverride(editorModelId) || {};
                        const presets = getPresetOptions(field.key);
                        if (editorCursorIdx < presets.length) {
                            // Select a preset option
                            setModelOverride(editorModelId, { ...ov, [field.key]: presets[editorCursorIdx] }, persistPath);
                        } else {
                            // "custom" — open input dialog
                            customFieldKey = field.key;
                            customInputComponent = new ExtensionInputComponent(
                                `Enter custom ${field.label}`,
                                "",
                                (value: string) => {
                                    if (editorModelId === null) return;
                                    const parsed: unknown = field.key === "input"
                                        ? value.split(/\s*\+\s*/).map((s: string) => s.trim()).filter(Boolean)
                                        : parseInt(value, 10);
                                    const ov2 = getModelOverride(editorModelId) || {};
                                    setModelOverride(editorModelId, { ...ov2, [field.key]: parsed }, persistPath);
                                    syncCursorToField();
                                    customInputComponent = null;
                                    customFieldKey = null;
                                    screen = "editor";
                                },
                                () => {
                                    customInputComponent = null;
                                    customFieldKey = null;
                                    screen = "editor";
                                },
                            );
                            screen = "customInput";
                            return;
                        }
                        return;
                    }
                    return;
                }

                if (screen === "customInput") {
                    if (customInputComponent?.handleInput) {
                        customInputComponent.handleInput(data);
                        return;
                    }
                    return;
                }

                if (screen === "thinkingLevelMap") {
                    if (editorModelId === null) return;
                    const modelId: string = editorModelId;

                    if (data === "\x1b" || data === "Escape") {
                        // Esc: go back to editor
                        screen = "editor";
                        editorFieldIndex = 4; // focus back on thinkingLevelMap field
                        return;
                    }
                    if (data === "ArrowUp" || data === "\x1b[A") {
                        tlEditorLevelIndex = (tlEditorLevelIndex - 1 + THINKING_LEVELS.length) % THINKING_LEVELS.length;
                        tlEditorValueState = 0;
                        return;
                    }
                    if (data === "ArrowDown" || data === "\x1b[B") {
                        tlEditorLevelIndex = (tlEditorLevelIndex + 1) % THINKING_LEVELS.length;
                        tlEditorValueState = 0;
                        return;
                    }
                    if (data === "ArrowLeft" || data === "\x1b[D") {
                        if (editorModelId === null) return;
                        const ov = getModelOverride(modelId);
                        const map = { ...(ov?.thinkingLevelMap ?? {}) } as Record<string, string | null | undefined>;
                        const level = THINKING_LEVELS[tlEditorLevelIndex];
                        const val = map[level];
                        // Only meaningful when in "supported" state: cycle value between level name and custom
                        if (val !== undefined && val !== null) {
                            tlEditorValueState = (tlEditorValueState - 1 + 2) % 2;
                        }
                        return;
                    }
                    if (data === "ArrowRight" || data === "\x1b[C") {
                        if (editorModelId === null) return;
                        const ov = getModelOverride(modelId);
                        const map = { ...(ov?.thinkingLevelMap ?? {}) } as Record<string, string | null | undefined>;
                        const level = THINKING_LEVELS[tlEditorLevelIndex];
                        const val = map[level];
                        // Only meaningful when in "supported" state: cycle value
                        if (val !== undefined && val !== null) {
                            tlEditorValueState = (tlEditorValueState + 1) % 2;
                        }
                        return;
                    }
                    if (data === "\r" || data === "\n" || data === " ") {
                        // Toggle this level's state: omitted → supported → null → omitted → ...
                        const ov = getModelOverride(modelId);
                        const map = { ...(ov?.thinkingLevelMap ?? {}) } as Record<string, string | null | undefined>;
                        const level = THINKING_LEVELS[tlEditorLevelIndex];
                        const val = map[level];

                        let newMap: Record<string, string | null | undefined>;
                        if (val === undefined) {
                            // omitted → supported (level name)
                            newMap = { ...map, [level]: level };
                            tlEditorValueState = 0;
                        } else if (val !== null) {
                            // supported → null (unsupported)
                            newMap = { ...map, [level]: null };
                            tlEditorValueState = 0;
                        } else {
                            // null → removed (omitted)
                            newMap = { ...map };
                            delete newMap[level];
                            tlEditorValueState = 0;
                        }

                        // Clean up empty map
                        const cleanMap: Record<string, string | null> = {};
                        for (const [k, v] of Object.entries(newMap)) {
                            if (v !== undefined) cleanMap[k] = v;
                        }
                        const finalMap = Object.keys(cleanMap).length > 0 ? cleanMap : undefined;

                        if (finalMap) {
                            setModelOverride(modelId, { thinkingLevelMap: finalMap as any }, persistPath);
                        } else {
                            // Remove the thinkingLevelMap field entirely
                            const currentOv = getModelOverride(modelId) || {};
                            const { thinkingLevelMap: _, ...rest } = currentOv as any;
                            setModelOverride(modelId, rest, persistPath);
                        }
                        return;
                    }
                    // Handle custom value input when in supported state and value state is "custom"
                    if (data === "Tab" && tlEditorValueState === 1) {
                        // Open custom input for the string value
                        customFieldKey = "thinkingLevelMap_value";
                        const ov = getModelOverride(modelId);
                        const map = (ov?.thinkingLevelMap ?? {}) as Record<string, string | null | undefined>;
                        const level = THINKING_LEVELS[tlEditorLevelIndex];
                        const currentVal = map[level] && typeof map[level] === "string" ? map[level] as string : level;
                        customInputComponent = new ExtensionInputComponent(
                            `Enter value for level "${level}"`,
                            currentVal,
                            (value: string) => {
                                if (editorModelId === null) return;
                                const ov2 = getModelOverride(editorModelId) || {};
                                const map2 = { ...(ov2.thinkingLevelMap ?? {}) } as Record<string, string | null>;
                                map2[level] = value;
                                setModelOverride(editorModelId, { ...ov2, thinkingLevelMap: map2 }, persistPath);
                                customInputComponent = null;
                                customFieldKey = null;
                                tlEditorValueState = 0;
                                screen = "thinkingLevelMap";
                            },
                            () => {
                                customInputComponent = null;
                                customFieldKey = null;
                                tlEditorValueState = 0;
                                screen = "thinkingLevelMap";
                            },
                        );
                        screen = "customInput";
                        return;
                    }
                    return;
                }

                if (screen === "confirm") {
                    if (data === "ArrowLeft" || data === "\x1b[D") {
                        confirmChoice = (confirmChoice - 1 + 2) % 2;
                        return;
                    }
                    if (data === "ArrowRight" || data === "\x1b[C") {
                        confirmChoice = (confirmChoice + 1) % 2;
                        return;
                    }
                    if (data === "\r" || data === "\n" || data === " ") {
                        if (confirmChoice === 0) {
                            // Yes — delete
                            if (confirmAction?.type === "delete" && confirmAction.modelId) {
                                removeModelOverride(confirmAction.modelId, persistPath);
                            }
                        }
                        // No — just go back
                        confirmAction = null;
                        confirmChoice = 1;
                        screen = "list";
                        editorModelId = null;
                        editorFieldIndex = 0;
                        return;
                    }
                    if (data === "\x1b" || data === "Escape") {
                        confirmAction = null;
                        confirmChoice = 1;
                        screen = "list";
                        editorModelId = null;
                        editorFieldIndex = 0;
                        return;
                    }
                    return;
                }
            },
        };
    }

    // -----------------------------------------------------------------------
    // Autocomplete provider for Tab-after-space in /gwdg-settings
    // -----------------------------------------------------------------------
    // pi's handleTabCompletion uses forceFileAutocomplete(true) when there's
    // already a space after the command name, which passes force:true to the
    // combined built-in provider. With force:true, the combined provider skips
    // slash-command and getArgumentCompletions handling, going straight to file
    // completion.
    //
    // Worse, CombinedAutocompleteProvider.shouldTriggerFileCompletion does:
    //   if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" "))
    //     return false;
    //
    // For "/gwdg-settings " (trailing space), trim() strips the space, making it
    // look like there's no argument. It returns false, and when force:true and
    // shouldTriggerFileCompletion returns false, the editor cancels autocomplete
    // entirely before getSuggestions is ever called.
    //
    // We install a custom autocomplete provider that:
    //   1. Overrides shouldTriggerFileCompletion to return true when we're in
    //      a /gwdg-settings <arg> context (so the editor proceeds to call
    //      getSuggestions).
    //   2. Intercepts getSuggestions to return our scope items (project/global)
    //      before the combined provider runs its file-completion logic.
    pi.on("session_start", async (_event, ctx) => {
        // Capture a UI ctx early so the fetch interceptor can render feedback
        // even for a 429 on the very first request of the session.
        feedbackCtx = ctx;
        ctx.ui.addAutocompleteProvider((current) => ({
            async getSuggestions(lines, cursorLine, cursorCol, options) {
                const line = lines[cursorLine] || "";
                const textBeforeCursor = line.slice(0, cursorCol);

                if (textBeforeCursor.startsWith("/")) {
                    const spaceIndex = textBeforeCursor.indexOf(" ");
                    if (spaceIndex !== -1) {
                        const cmdName = textBeforeCursor.slice(1, spaceIndex);
                        if (cmdName === "gwdg-settings") {
                            const argPrefix = textBeforeCursor.slice(spaceIndex + 1);
                            const filtered = gwdgSettingsScopeItems().filter((i) => i.value.startsWith(argPrefix));
                            if (filtered.length > 0) {
                                return { items: filtered, prefix: argPrefix };
                            }
                        }
                    }
                }

                return current.getSuggestions(lines, cursorLine, cursorCol, options);
            },
            applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
                // Guard: validate that our prefix is still meaningful for the
                // current cursor context.  The async updateAutocomplete may not
                // have resolved yet, leaving a stale prefix from a previous
                // argument-completion prompt (e.g. prefix="" when the user has
                // already Backspaced past the space into the command name).
                // Applying a stale prefix concatenates "project" directly onto
                // a partial command, yielding "/gwdg-settproject".
                const currentLine = lines[cursorLine] || "";
                const textBeforeCursor = currentLine.slice(0, cursorCol);
                const stillInArgContext =
                    textBeforeCursor.startsWith("/") &&
                    textBeforeCursor.indexOf(" ") !== -1 &&
                    textBeforeCursor.slice(1, textBeforeCursor.indexOf(" ")) === "gwdg-settings";
                if (!stillInArgContext && gwdgSettingsScopeItems().some((i) => i.value === item.value)) {
                    // Stale argument completion — prefix is from a previous
                    // argument-completion context but the cursor is no longer in
                    // a /gwdg-settings <arg> position. Return text unchanged so
                    // the editor handles Tab via normal handleTabCompletion flow.
                    return [...lines];
                }
                return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
            },
            shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
                const line = lines[cursorLine] || "";
                const textBeforeCursor = line.slice(0, cursorCol);

                // When we're in a /gwdg-settings <arg> context, tell the editor
                // to proceed so our getSuggestions has a chance to run.
                // The combined provider's shouldTriggerFileCompletion uses trim()
                // which strips trailing spaces, making it think there's no argument
                // even when the user has typed "/gwdg-settings " + space + Tab.
                if (textBeforeCursor.startsWith("/")) {
                    const spaceIndex = textBeforeCursor.indexOf(" ");
                    if (spaceIndex !== -1) {
                        const cmdName = textBeforeCursor.slice(1, spaceIndex);
                        if (cmdName === "gwdg-settings") {
                            return true;
                        }
                    }
                }

                return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
            },
        }));
    });

    // --- Shared helpers ---

    /** Build the argument-completion items for /gwdg-settings scope. */
    function gwdgSettingsScopeItems(): AutocompleteItem[] {
        const globalPath = join(getAgentDir(), "extensions", "gwdg.json");
        return [
            { value: "project", label: "project", description: "Save to .pi/gwdg.json (default)" },
            { value: "global", label: "global", description: `Save to ${globalPath}` },
        ];
    }

    // --- Setting value helpers ---
    /** Format a footer timeout value into a display label. */
    function toFooterLabel(sec: number): string {
        return sec === 0 ? "never" : `${sec}s`;
    }
    /** Format a cache TTL value into a display label. */
    function toCacheTtlLabel(days: number): string {
        return `${days}d`;
    }
    /** Parse a footer timeout label back to a numeric value. */
    function parseFooterTimeout(label: string): number {
        if (label === "never")
            return 0;
        const n = parseInt(label, 10);
        return Number.isFinite(n) ? n : 0;
    }
    /** Parse a cache TTL label back to a numeric value. */
    function parseCacheTtl(label: string): number {
        const n = parseInt(label, 10);
        return Number.isFinite(n) ? n : 30;
    }
    /** Format a max-wait value into a display label ("never" when 0). */
    function toWaitLabel(sec: number): string {
        return sec === 0 ? "never" : `${sec}s`;
    }
    /** Parse a max-wait label back to a numeric value (seconds; 0 = never). */
    function parseWait(label: string): number {
        if (label === "never")
            return 0;
        const n = parseInt(label, 10);
        return Number.isFinite(n) ? n : 120;
    }
    /** Format a shared-state jitter value into a display label. */
    function toJitterLabel(ms: number): string {
        return `${ms}ms`;
    }
    /** Parse a shared-state jitter label back to milliseconds. */
    function parseJitter(label: string): number {
        const n = parseInt(label, 10);
        return Number.isFinite(n) ? n : 1000;
    }
        function applySettingChange(id: string, rawValue: string) {
        switch (id) {
            case "hideFooter":
            case "debug":
                setSetting(id, rawValue === "yes");
                break;
            case "footerTimeoutSec":
                setSetting(id, parseFooterTimeout(rawValue));
                break;
            case "modelCacheTtlDays":
                setSetting(id, parseCacheTtl(rawValue));
                break;
            case "emitRateLimitEvents":
                setSetting(id, rawValue === "yes");
                break;
            case "maxRateLimitWaitSec":
                setSetting(id, parseWait(rawValue));
                break;
            case "sharedRateLimitState":
                setSetting(id, rawValue === "yes");
                break;
            case "sharedStateJitterMs":
                setSetting(id, parseJitter(rawValue));
                break;
        }
    }
}
