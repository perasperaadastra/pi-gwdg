/**
 * Rate limit tracking for GWDG provider.
 *
 * Extracts rate limit info from response headers and maintains
 * a module-level singleton tracking the most recent rate limit state.
 *
 * Debug logging is gated through config's isDebugEnabled() so it
 * respects both config file and PI_GWDG_DEBUG env var.
 */

import { debug as dbg } from "./debug.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitState {
  /** Unix ms when the rate limit resets */
  resetTimestamp: number;
  /** Seconds until reset (from retry-after header) */
  retryAfter: number;
}

/** Emitted on every provider response */
export interface ProviderRateLimitEvent {
  /** Provider name, e.g. "gwdg" */
  provider: string;
  /** HTTP status code from the response */
  status: number;
  /** When this event was emitted (Date.now()) */
  timestamp: number;
  /** Per-window quota snapshot */
  windows: RateLimitWindows;
  /** Active rate limit state, or null if not rate limited */
  retryAfter: RateLimitState | null;
}

/** Emitted on 429 (non-null retryAfter guaranteed) */
export interface ProviderRateLimitedEvent extends ProviderRateLimitEvent {
  /** Non-null — rate limit is active */
  retryAfter: RateLimitState;
  /** True if retry-after was from an explicit header, false if backfilled */
  isRetryAfter: boolean;
}

/** Per-window quota snapshot (optional, for /gwdg-status display) */
export interface RateLimitWindows {
  /** Reset is seconds until the next window boundary */
  minute?: { limit: number; remaining: number; reset: number };
  hour?: { limit: number; remaining: number; reset: number };
  day?: { limit: number; remaining: number; reset: number };
  month?: { limit: number; remaining: number; reset: number };
}

export interface ProviderRateLimit {
  /** Active rate limit, or null if not rate limited */
  retryAfter: RateLimitState | null;
  /** Latest known quota snapshot */
  windows: RateLimitWindows;
}

// ---------------------------------------------------------------------------
// Module-level state (singleton)
// ---------------------------------------------------------------------------

let currentRateLimit: ProviderRateLimit = { retryAfter: null, windows: {} };

export function getRateLimitState(): ProviderRateLimit {
  return currentRateLimit;
}

export function setRateLimitState(state: Partial<ProviderRateLimit>): void {
  if (state.retryAfter !== undefined) {
    dbg("setRateLimitState: setting retryAfter=%j", state.retryAfter);
    currentRateLimit.retryAfter = state.retryAfter;
  }
  if (state.windows !== undefined) {
    dbg("setRateLimitState: setting windows=%j", state.windows);
    currentRateLimit.windows = state.windows;
  }
}

/** Clear retry-after state (rate limit expired) */
export function clearRetryAfter(): void {
  dbg("clearRetryAfter: clearing active rate limit state");
  currentRateLimit.retryAfter = null;
}

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------

const WINDOW_PATTERNS = ["minute", "hour", "day", "month"] as const;

/**
 * Extract per-window rate limit info from response headers.
 *
 * GWDG returns headers like:
 *   x-ratelimit-limit-minute: 30
 *   x-ratelimit-remaining-minute: 29
 *   x-ratelimit-limit-hour: 200
 *   x-ratelimit-remaining-hour: 198
 *   ...
 *   ratelimit-limit: 30
 *   ratelimit-remaining: 29
 *   ratelimit-reset: 38
 *
 * The `ratelimit-reset` header is a single delta in seconds, representing
 * the reset for the minute window. There are no per-window reset headers.
 * For hour/day/month windows, the reset is calculated as seconds until
 * the next calendar boundary (start of next hour, midnight UTC, 1st of month).
 */
export function extractRateLimitsFromHeaders(headers: Headers | Record<string, string | string[] | undefined>): RateLimitWindows {
  const windows: RateLimitWindows = {};
  dbg("extractRateLimitsFromHeaders: parsing headers");

  // Helper: get a header value as a number (case-insensitive)
  const getHeader = (name: string): number | undefined => {
    let val: string | string[] | undefined;

    if (typeof (headers as any).get === "function") {
      val = (headers as Headers).get(name) ?? undefined;
    } else {
      val = (headers as Record<string, string | string[] | undefined>)[name];
    }

    if (val === undefined || val === null) return undefined;
    const str = Array.isArray(val) ? val[0] : val;
    const n = Number(str);
    return Number.isFinite(n) ? n : undefined;
  };

  // Current time for boundary calculations
  const now = Date.now();

  // Extract per-window limits
  for (const window of WINDOW_PATTERNS) {
    const limit = getHeader(`x-ratelimit-limit-${window}`)
      ?? getHeader(`X-Ratelimit-Limit-${window.charAt(0).toUpperCase() + window.slice(1)}`);
    const remaining = getHeader(`x-ratelimit-remaining-${window}`)
      ?? getHeader(`X-Ratelimit-Remaining-${window.charAt(0).toUpperCase() + window.slice(1)}`);

    if (limit === undefined || remaining === undefined) continue;

    // Prefer an explicit per-window reset header if the API ever adds one
    const perWindowReset = getHeader(`x-ratelimit-reset-${window}`)
      ?? getHeader(`X-Ratelimit-Reset-${window.charAt(0).toUpperCase() + window.slice(1)}`);

    let reset: number;
    if (perWindowReset !== undefined) {
      reset = perWindowReset;
    } else {
      // Calculate seconds until the next calendar boundary.
      // For the minute window this is the same as the global ratelimit-reset
      // header, but computing it ourselves is more consistent with how
      // hour/day/month windows are handled.
      reset = secondsUntilBoundary(now, window);
    }

    (windows as any)[window] = { limit, remaining, reset };
  }

  return windows;
}

/**
 * Calculate the number of seconds from now until the next calendar boundary
 * for the given window type.
 */
function secondsUntilBoundary(nowMs: number, window: string): number {
  const now = new Date(nowMs);

  switch (window) {
    case "hour": {
      // Next :00 of the current hour
      const next = new Date(now);
      next.setUTCMinutes(0, 0, 0);
      next.setUTCHours(next.getUTCHours() + 1);
      return Math.ceil((next.getTime() - nowMs) / 1000);
    }
    case "day": {
      // Next midnight UTC
      const next = new Date(now);
      next.setUTCHours(0, 0, 0, 0);
      next.setUTCDate(next.getUTCDate() + 1);
      return Math.ceil((next.getTime() - nowMs) / 1000);
    }
    case "month": {
      // 1st of next month, midnight UTC
      const next = new Date(now);
      next.setUTCHours(0, 0, 0, 0);
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + 1);
      return Math.ceil((next.getTime() - nowMs) / 1000);
    }
    case "minute": {
      // Next :00 seconds of the current minute
      const next = new Date(now);
      next.setUTCSeconds(0, 0);
      next.setUTCMinutes(next.getUTCMinutes() + 1);
      return Math.ceil((next.getTime() - nowMs) / 1000);
    }
    default:
      return 0;
  }
}

/**
 * Extract retry-after info from response headers.
 *
 * Checks `retry-after` header first (seconds), falling back to `ratelimit-reset` (seconds).
 * Returns null if neither header is present or parseable.
 */
export function extractRetryAfter(headers: Headers | Record<string, string | string[] | undefined>): RateLimitState | null {
  dbg("extractRetryAfter: searching for retry-after or ratelimit-reset headers");
  const getHeader = (name: string): number | undefined => {
    let val: string | string[] | undefined;

    if (typeof (headers as any).get === "function") {
      val = (headers as Headers).get(name) ?? undefined;
    } else {
      val = (headers as Record<string, string | string[] | undefined>)[name];
    }

    if (val === undefined || val === null) return undefined;
    const str = Array.isArray(val) ? val[0] : val;
    const n = Number(str);
    return Number.isFinite(n) ? n : undefined;
  };

  // Try retry-after first
  const retryAfterSec = getHeader("retry-after") ?? getHeader("Retry-After");
  if (retryAfterSec !== undefined && retryAfterSec > 0) {
    dbg("extractRetryAfter: found retry-after=%ds", retryAfterSec);
    return {
      retryAfter: retryAfterSec,
      resetTimestamp: Date.now() + retryAfterSec * 1000,
    };
  }

  // Fallback to ratelimit-reset
  const resetSec = getHeader("ratelimit-reset");
  if (resetSec !== undefined && resetSec > 0) {
    dbg("extractRetryAfter: fallback ratelimit-reset=%ds", resetSec);
    return {
      retryAfter: resetSec,
      resetTimestamp: Date.now() + resetSec * 1000,
    };
  }

  dbg("extractRetryAfter: no retry-after or ratelimit-reset header found, returning null");
  return null;
}
