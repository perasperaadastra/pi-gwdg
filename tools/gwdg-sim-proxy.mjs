#!/usr/bin/env node
/**
 * gwdg-sim-proxy — a zero-dependency relay proxy for testing the pi-gwdg
 * rate-limit / 429 handling without actually exhausting your real quota.
 *
 * What it does
 * ------------
 * - Transparently forwards every request (including streaming SSE chat
 *   completions and the Authorization header) to the real GWDG endpoint.
 * - Rewrites the rate-limit headers on *successful* responses so the numbers
 *   look scarier than reality: `x-ratelimit-limit-*` and `x-ratelimit-remaining-*`
 *   (and the bare `ratelimit-limit` / `ratelimit-remaining`) are divided by
 *   RATELIMIT_DIVISOR (default 2 = "cut in half").
 * - Injects synthetic HTTP 429 responses on demand, shaped like a real GWDG
 *   rate-limit error (status 429, `retry-after` / `ratelimit-reset` headers,
 *   `x-ratelimit-remaining-*: 0`, and a JSON body containing `retry_after`).
 *   The body carries the reset value so the extension's `estimateResetSeconds`
 *   can parse an exact countdown even though the SDK hides the headers.
 *
 * 429 injection modes (env SIM_MODE):
 *   off      (default) — pure relay, only header halving. Trigger 429s manually
 *                        via the control endpoint (see below).
 *   firstN   — the first SIM_FIRST chat requests of the session return a 429
 *              (default 1), then everything succeeds. Deterministic: the first
 *              prompt's request 429s, pi retries, retry passes. No timing race.
 *   everyN   — every SIM_EVERY-th chat request returns a 429 (default N=3).
 *   bucket   — a token bucket of SIM_LIMIT tokens (default 3). Each chat request
 *              spends one; when empty, returns 429 until SIM_RESET_SEC seconds
 *              (default 30) have passed, then refills.
 *
 * Manual control (works in any mode, great for triggering mid-session):
 *   curl -X POST localhost:$PORT/__sim/429     # arm a one-shot 429 for the next request
 *   curl -X POST localhost:$PORT/__sim/reset   # reset counters / disarm
 *   curl        localhost:$PORT/__sim/status   # inspect current state
 *
 * Env vars:
 *   PORT               (default 8787)
 *   UPSTREAM           (default https://chat-ai.academiccloud.de)
 *   RATELIMIT_DIVISOR  (default 2)
 *   SIM_MODE           off | firstN | everyN | bucket   (default off)
 *   SIM_FIRST          (firstN mode, default 1)
 *   SIM_EVERY          (everyN mode, default 3)
 *   SIM_LIMIT          (bucket mode, default 3)
 *   SIM_RESET_SEC      (429 retry-after / reset seconds, default 30)
 *
 * Point pi at it by adding to `.pi/gwdg.json` in your project:
 *   { "baseUrl": "http://localhost:8787/v1" }
 * (then restart pi, or /gwdg-refresh). Your real GWDG_API_KEY is forwarded
 * upstream unchanged.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = new URL(process.env.UPSTREAM ?? "https://chat-ai.academiccloud.de");
const DIVISOR = Math.max(1, Number(process.env.RATELIMIT_DIVISOR ?? 2));
const SIM_MODE = process.env.SIM_MODE ?? "off";
const SIM_EVERY = Math.max(1, Number(process.env.SIM_EVERY ?? 3));
const SIM_LIMIT = Math.max(0, Number(process.env.SIM_LIMIT ?? 3));
const SIM_FIRST = Math.max(1, Number(process.env.SIM_FIRST ?? 1));
const SIM_RESET_SEC = Math.max(1, Number(process.env.SIM_RESET_SEC ?? 30));

// --- Simulation state -------------------------------------------------------
let requestCount = 0;          // counts chat/completions requests
let firstNServed = 0;          // firstN mode: how many 429s served so far
let armedOneShot = false;      // manual one-shot 429
let bucketTokens = SIM_LIMIT;  // bucket mode
let bucketResetAt = 0;         // ms timestamp when bucket refills

function log(...args) {
  console.error(`[sim-proxy]`, ...args);
}

function isChatRequest(reqUrl) {
  return /\/chat\/completions\/?$/.test(reqUrl.split("?")[0]);
}

/** Decide whether this request should be answered with a synthetic 429. */
function shouldInject429(reqUrl) {
  // Only ever inject on chat requests — never on model-list / warmup calls, so
  // a one-shot reliably lands on your prompt's request (not pi's startup calls).
  if (!isChatRequest(reqUrl)) return { hit: false };

  if (armedOneShot) {
    armedOneShot = false;
    return { hit: true, reason: "one-shot" };
  }

  // Deterministic: the first SIM_FIRST chat requests of the session get a 429,
  // then everything succeeds. Retries land on request #2+, which pass — so the
  // turn completes after pi's built-in backoff. Zero timing ambiguity.
  if (SIM_MODE === "firstN") {
    if (firstNServed < SIM_FIRST) {
      firstNServed += 1;
      return { hit: true, reason: `firstN (${firstNServed}/${SIM_FIRST})` };
    }
    return { hit: false };
  }

  if (SIM_MODE === "everyN") {
    requestCount += 1;
    if (requestCount % SIM_EVERY === 0) return { hit: true, reason: `everyN (#${requestCount})` };
    return { hit: false };
  }

  if (SIM_MODE === "bucket") {
    const now = Date.now();
    if (bucketTokens <= 0 && now < bucketResetAt) {
      return { hit: true, reason: "bucket empty" };
    }
    if (bucketTokens <= 0 && now >= bucketResetAt) {
      bucketTokens = SIM_LIMIT; // refill
      log(`bucket refilled to ${SIM_LIMIT}`);
    }
    bucketTokens -= 1;
    if (bucketTokens < 0) {
      bucketTokens = 0;
      bucketResetAt = now + SIM_RESET_SEC * 1000;
      return { hit: true, reason: "bucket drained" };
    }
    return { hit: false };
  }

  return { hit: false };
}

/** Write a synthetic 429 that mimics a real GWDG rate-limit response. */
function send429(res, resetSec) {
  const body = JSON.stringify({
    error: {
      message: `Rate limit exceeded. Please retry after ${resetSec} seconds.`,
      type: "rate_limit_exceeded",
      code: "rate_limit_exceeded",
      // Embedded so the extension can parse an exact countdown from the body,
      // since the SDK hides response headers on the throw path.
      retry_after: resetSec,
    },
  });
  const headers = {
    "content-type": "application/json",
    "ratelimit-reset": String(resetSec),
    "ratelimit-limit": "30",
    "ratelimit-remaining": "0",
    // Full per-window headers (limit + remaining) so the extension can build
    // proper RateLimitWindows, matching a real GWDG 429.
    "x-ratelimit-limit-minute": "30",
    "x-ratelimit-remaining-minute": "0",
    "x-ratelimit-reset-minute": String(resetSec),
    "x-ratelimit-limit-hour": "450",
    "x-ratelimit-remaining-hour": "0",
    "x-ratelimit-limit-day": "10800",
    "x-ratelimit-remaining-day": "120",
    "content-length": Buffer.byteLength(body),
  };
  // The standard `Retry-After` header is what the OpenAI SDK honours for its
  // retry delay. Set SIM_NO_RETRY_AFTER=1 to omit it and emit only the
  // ratelimit-* headers (as some providers do) — this exercises the extension's
  // Retry-After synthesis / SDK-timing alignment. Default: include it.
  if (process.env.SIM_NO_RETRY_AFTER !== "1") {
    headers["retry-after"] = String(resetSec);
  }
  res.writeHead(429, headers);
  res.end(body);
}

/** Halve (divide by DIVISOR) the numeric rate-limit headers on a real response. */
function rewriteHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    const isCount =
      /^(x-)?ratelimit-(limit|remaining)(-(minute|hour|day|month))?$/.test(k);
    if (isCount && value !== undefined) {
      const raw = Array.isArray(value) ? value[0] : value;
      const n = Number(raw);
      if (Number.isFinite(n)) {
        out[key] = String(Math.floor(n / DIVISOR));
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

// --- Control endpoints ------------------------------------------------------
function handleControl(req, res) {
  const path = req.url.replace(/\?.*$/, "");
  if (path === "/__sim/429" && req.method === "POST") {
    armedOneShot = true;
    log("armed one-shot 429 for the next request");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, armed: true }));
    return true;
  }
  if (path === "/__sim/reset" && req.method === "POST") {
    armedOneShot = false;
    requestCount = 0;
    firstNServed = 0;
    bucketTokens = SIM_LIMIT;
    bucketResetAt = 0;
    log("state reset");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (path === "/__sim/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        mode: SIM_MODE,
        divisor: DIVISOR,
        requestCount,
        firstNServed,
        armedOneShot,
        bucketTokens,
        bucketResetInSec: bucketResetAt ? Math.max(0, Math.ceil((bucketResetAt - Date.now()) / 1000)) : 0,
        upstream: UPSTREAM.origin,
      }, null, 2),
    );
    return true;
  }
  return false;
}

// --- Proxy ------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/__sim")) {
    if (handleControl(req, res)) return;
  }

  const inject = shouldInject429(req.url);
  if (inject.hit) {
    log(`→ 429 (${inject.reason}) ${req.method} ${req.url}`);
    // Drain the request body so the client's write side closes cleanly.
    req.resume();
    send429(res, SIM_RESET_SEC);
    return;
  }

  // Forward upstream, preserving method/path/headers/body.
  const upstreamHeaders = { ...req.headers };
  upstreamHeaders.host = UPSTREAM.host; // vhost must match the real endpoint

  const upstreamReq = https.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 443,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders,
      servername: UPSTREAM.hostname, // SNI
    },
    (upstreamRes) => {
      const rewritten = rewriteHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode ?? 502, rewritten);
      upstreamRes.pipe(res); // stream SSE/body straight through
    },
  );

  upstreamReq.on("error", (err) => {
    log("upstream error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: `proxy upstream error: ${err.message}` } }));
  });

  req.pipe(upstreamReq); // stream request body upstream
});

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}  →  ${UPSTREAM.origin}`);
  log(`mode=${SIM_MODE} divisor=${DIVISOR} resetSec=${SIM_RESET_SEC}` +
    (SIM_MODE === "everyN" ? ` every=${SIM_EVERY}` : "") +
    (SIM_MODE === "bucket" ? ` limit=${SIM_LIMIT}` : ""));
  log(`point pi at:  "baseUrl": "http://localhost:${PORT}/v1"  (in .pi/gwdg.json)`);
});
