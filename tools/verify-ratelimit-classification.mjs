#!/usr/bin/env node
/**
 * Verify how the fetch interceptor classifies responses — 429 vs. throttled 5xx
 * vs. genuine 5xx vs. other 4xx — against a stub HTTP server. No quota spent, no
 * network.
 *
 *   npx tsc && node tools/verify-ratelimit-classification.mjs
 *
 * Why a stub server and not unit tests: the classification only exists inside the
 * `globalThis.fetch` wrapper, and the wrapper is installed as a side effect of
 * loading the extension. So the honest way to test it is to load the real
 * extension and make real requests at it.
 *
 * Two traps this harness is built to avoid (see docs/rate-limit-internals.md):
 *   - There is no `PI_GWDG_BASE_URL`. `baseUrl` must come from a project config
 *     file, or the extension quietly targets the real GWDG host, `providerHost`
 *     never matches, everything passes through, and the passthrough assertions
 *     all pass for the wrong reason. Hence `assert(globalThis.__gwdgFetchPatched)`
 *     plus a request count on every case: a passthrough and a retried-to-failure
 *     end in the same status.
 *   - `npx tsc --noEmit` does not rebuild `dist/`. This script imports `dist/`,
 *     so run a real `npx tsc` first.
 */

import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Header fixtures — shaped after live probing of the real API (2026-08-03).
// The generic `ratelimit-*` aliases mirror the undocumented per-second window,
// NOT the minute window; that is why a throttled 5xx shows quota left in every
// named window and `ratelimit-remaining: 0` is the only exhaustion signal.
// ---------------------------------------------------------------------------

const QUOTA_LEFT = {
    "x-ratelimit-limit-minute": "15",
    "x-ratelimit-remaining-minute": "7",
    "x-ratelimit-limit-hour": "900",
    "x-ratelimit-remaining-hour": "870",
    "x-ratelimit-limit-day": "21600",
    "x-ratelimit-remaining-day": "21000",
    "ratelimit-limit": "2",
    "ratelimit-remaining": "1",
};

/** Per-second window exhausted, every named window still fine. */
const SECOND_WINDOW_EXHAUSTED = { ...QUOTA_LEFT, "ratelimit-remaining": "0" };

/** Day quota genuinely gone — a reset far beyond any sane wait budget. */
const DAY_WINDOW_EXHAUSTED = {
    ...QUOTA_LEFT,
    "x-ratelimit-remaining-day": "0",
    "ratelimit-remaining": "0",
};

const MAX_WAIT_SEC = 5;

// ---------------------------------------------------------------------------
// Stub server
// ---------------------------------------------------------------------------

/** @type {Array<[number, Record<string,string>]>} */
let queue = [];
let requestCount = 0;

const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "stub-model", name: "Stub Model" }] }));
        return;
    }
    requestCount++;
    const [status, headers] = queue.shift() ?? [200, QUOTA_LEFT];
    res.writeHead(status, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify({ stub: true, status }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// Isolated environment: project config carries baseUrl (no env var exists),
// PI_CODING_AGENT_DIR keeps the real ~/.pi out of it, and the shared state dir
// is redirected — but shared state stays ENABLED, because two cases assert on
// whether a reset was published to peers.
// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), "pi-gwdg-verify-"));
const stateDir = join(root, "state");
await mkdir(join(root, ".pi"), { recursive: true });
await mkdir(stateDir, { recursive: true });
await writeFile(
    join(root, ".pi", "gwdg.json"),
    JSON.stringify({ baseUrl, maxRateLimitWaitSec: MAX_WAIT_SEC, sharedRateLimitState: true }, null, 2),
);

process.env.GWDG_API_KEY = "stub-key";
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_GWDG_SHARED_STATE_DIR = stateDir;
process.env.PI_GWDG_SHARED_STATE_JITTER_MS = "0";
delete process.env.PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC;
delete process.env.PI_GWDG_SHARED_STATE;
process.chdir(root);

// ---------------------------------------------------------------------------
// Stub `pi` + UI context
// ---------------------------------------------------------------------------

/** @type {Record<string, Function>} */
const handlers = {};
/** @type {Array<string|undefined>} */
const statusWrites = [];

const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: () => {},
    registerProvider: () => {},
};

const ctx = {
    // "rpc" keeps the banner on the plain string-widget path — no pi-tui
    // components to satisfy, and the interceptor logic is identical.
    mode: "rpc",
    model: { provider: "gwdg" },
    isIdle: () => true,
    ui: {
        setStatus: (_key, value) => { statusWrites.push(value); },
        setWidget: () => {},
        notify: () => {},
        theme: { fg: (_style, text) => text },
    },
};

const extension = (await import(pathToFileURL(join(import.meta.dirname, "..", "dist", "index.js")).href)).default;
await extension(pi);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;
function check(label, ok, detail = "") {
    if (ok) {
        console.log(`  ✓ ${label}`);
    } else {
        failures++;
        console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    }
}

// Before anything else: if the interceptor is not installed, every passthrough
// assertion below would pass vacuously.
check("interceptor installed (globalThis.__gwdgFetchPatched)", globalThis.__gwdgFetchPatched === true);
if (globalThis.__gwdgFetchPatched !== true) {
    console.error("\nbaseUrl injection failed — refusing to report vacuous passes.");
    await shutdown(1);
}

// The interceptor borrows the most recently captured UI context, which only
// exists once an event has fired. Seed it with a header-less 200 (parses to zero
// windows, so it cannot itself write a footer).
handlers["after_provider_response"]?.({ status: 200, headers: {} }, ctx);

/** Clear peer state so one case's publish cannot leak into the next one's pre-flight. */
async function clearSharedState() {
    for (const f of await readdir(stateDir)) await rm(join(stateDir, f), { force: true });
}

async function sharedStateFiles() {
    return (await readdir(stateDir)).length;
}

/**
 * Drive one scripted exchange through the real interceptor.
 * @param {Array<[number, Record<string,string>]>} script
 */
async function run(script) {
    queue = script;
    requestCount = 0;
    statusWrites.length = 0;
    await clearSharedState();
    const startedAt = Date.now();
    const res = await globalThis.fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
    return { res, requests: requestCount, elapsedMs: Date.now() - startedAt };
}

console.log("\n429 — waited out, then succeeds");
{
    const { res, requests, elapsedMs } = await run([
        [429, { ...SECOND_WINDOW_EXHAUSTED, "retry-after": "1" }],
        [200, QUOTA_LEFT],
    ]);
    check("retried after the wait (2 requests)", requests === 2, `saw ${requests}`);
    check("final status 200", res.status === 200, `saw ${res.status}`);
    check("actually waited ~1s", elapsedMs >= 900, `${elapsedMs}ms`);
    check("published the reset to peers", (await sharedStateFiles()) === 1);
}

console.log("\nThrottled 5xx (per-second window exhausted, no retry-after) — capped retries");
{
    const script = Array.from({ length: 6 }, () => [500, SECOND_WINDOW_EXHAUSTED]);
    const { res, requests, elapsedMs } = await run(script);
    check("1 initial + 3 capped retries = 4 requests", requests === 4, `saw ${requests}`);
    check("surfaced as a server error", res.status === 500, `saw ${res.status}`);
    check("not marked non-retryable (pi's retry stays a backstop)",
        res.headers.get("x-should-retry") === null, `saw ${res.headers.get("x-should-retry")}`);
    // 3 waits at THROTTLED_SECOND_WINDOW_WAIT_SEC (2s). The point of the range is
    // the upper bound: DEFAULT_RATE_LIMIT_WAIT_SEC (60s) would land at ~180s.
    check("waited seconds, not minutes (per-second fallback, not the 60s default)",
        elapsedMs >= 4000 && elapsedMs < 20000, `${elapsedMs}ms`);
    check("did NOT publish an inferred throttle to peers", (await sharedStateFiles()) === 0);
}

console.log("\n5xx with quota remaining — untouched");
{
    const { res, requests } = await run([[503, QUOTA_LEFT], [200, QUOTA_LEFT]]);
    check("passed straight through (1 request)", requests === 1, `saw ${requests}`);
    check("final status 503", res.status === 503, `saw ${res.status}`);
    check("nothing published to peers", (await sharedStateFiles()) === 0);
}

console.log("\n404 — untouched, but its quota snapshot is harvested");
{
    const { res, requests } = await run([[404, QUOTA_LEFT], [200, QUOTA_LEFT]]);
    check("no retry (1 request)", requests === 1, `saw ${requests}`);
    check("final status 404", res.status === 404, `saw ${res.status}`);
    check("footer rendered from the error response",
        statusWrites.some((s) => typeof s === "string" && s.includes("m 7/15")),
        JSON.stringify(statusWrites));
}

console.log("\n401 — no headers at all, must not blank the snapshot");
{
    const { res, requests } = await run([[401, {}], [200, QUOTA_LEFT]]);
    check("no retry (1 request)", requests === 1, `saw ${requests}`);
    check("final status 401", res.status === 401, `saw ${res.status}`);
    check("no footer write from a header-less response", statusWrites.length === 0,
        JSON.stringify(statusWrites));
}

console.log(`\n429 with a reset beyond the ${MAX_WAIT_SEC}s budget — cancelled`);
{
    const { res, requests } = await run([[429, { ...DAY_WINDOW_EXHAUSTED, "retry-after": "600" }]]);
    check("no wait, no retry (1 request)", requests === 1, `saw ${requests}`);
    check("SDK retry suppressed (x-should-retry: false)",
        res.headers.get("x-should-retry") === "false", `saw ${res.headers.get("x-should-retry")}`);
    check("retry-after stripped", res.headers.get("retry-after") === null);
    check("published the reset to peers", (await sharedStateFiles()) === 1);
}

console.log(`\nThrottled 5xx with a reset beyond the ${MAX_WAIT_SEC}s budget — surfaced, NOT cancelled`);
{
    const { res, requests } = await run([[500, { ...DAY_WINDOW_EXHAUSTED, "retry-after": "600" }]]);
    check("no wait, no retry (1 request)", requests === 1, `saw ${requests}`);
    check("still a 500", res.status === 500, `saw ${res.status}`);
    check("NOT marked non-retryable — the throttle was only inferred",
        res.headers.get("x-should-retry") === null, `saw ${res.headers.get("x-should-retry")}`);
    check("did NOT publish an inferred throttle to peers", (await sharedStateFiles()) === 0);
}

await shutdown(failures === 0 ? 0 : 1);

async function shutdown(code) {
    server.close();
    process.chdir(tmpdir());
    await rm(root, { recursive: true, force: true }).catch(() => {});
    console.log(code === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
    process.exit(code);
}
