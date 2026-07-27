/**
 * Cross-session rate-limit state sharing for the GWDG provider.
 *
 * The problem
 * -----------
 * `rate-limits.ts` keeps its state in a module-level singleton, which is
 * per-OS-process. GWDG quota, by contrast, is per API key. Run three pi
 * sessions against the same key and each one believes it owns the full
 * `x-ratelimit-remaining-minute` allowance — each learns otherwise only by
 * burning its own request on a 429.
 *
 * The transport
 * -------------
 * A single small JSON file, written by whichever session most recently learned
 * something about the shared quota and read by every session just before it
 * sends a request. It lives on tmpfs (`$XDG_RUNTIME_DIR`, mode 0700, per-user,
 * cleared on reboot) so the coordination costs no disk I/O and leaves nothing
 * behind. `/dev/shm` is deliberately NOT used: it is mode 1777, so a predictable
 * path there lets another local user pre-create the file and have our writes
 * flow into it.
 *
 * This module is the transport only. `pi.events` remains the local interface —
 * `index.ts` feeds what it reads here into the same `pi:rate-limits` emission
 * that in-process state uses, so consumers cannot tell local from remote and
 * this file can be swapped for a socket or daemon later.
 *
 * Scoping
 * -------
 * The filename is `sha256(host + NUL + apiKey)` truncated to 16 hex chars.
 * Keying on the credential means two projects using different keys never
 * suppress each other, and the raw key never appears in a path or a payload.
 *
 * Failure policy
 * --------------
 * Every export is fail-open: any error — unreadable directory, malformed JSON,
 * full tmpfs, a clock that jumped — degrades to exactly today's per-process
 * behaviour rather than propagating. A bug in here must never break a request.
 *
 * @module
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { debug, trace } from "./debug.js";
import { apiKey, config, getConfiguredSharedStateDir } from "./config.js";
import type { RateLimitWindows } from "./rate-limits.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** On-disk payload. `v` is bumped if the shape ever changes incompatibly. */
export interface SharedRateLimitState {
  /** Schema version */
  v: 1;
  /** Unix ms at which the provider quota resets; 0 = not currently limited */
  resetTimestamp: number;
  /** Most recent per-window quota snapshot seen by any session */
  windows: RateLimitWindows;
  /** Unix ms of the write (staleness / diagnostics) */
  writtenAt: number;
  /** Writing process id — diagnostics only, never used for decisions */
  pid: number;
}

/** What `/gwdg-status` needs to describe the shared-state layer. */
export interface SharedStateDiagnostics {
  /** Whether sharing is switched on */
  enabled: boolean;
  /** Resolved state file path, or null if it could not be resolved */
  path: string | null;
  /** Last published state, or null if absent/unreadable/invalid */
  state: SharedRateLimitState | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory created under the resolved runtime dir. */
const STATE_SUBDIR = "pi-gwdg";
/** Directory name used under the agent dir when XDG_RUNTIME_DIR is unset. */
const FALLBACK_SUBDIR = "gwdg-state";
/**
 * Reject an entry claiming a reset further out than this. GWDG's longest window
 * is monthly, but a month-away reset in the shared file is far more likely to be
 * corruption or a clock jump than something worth blocking a request on.
 */
const MAX_TRUSTED_RESET_MS = 24 * 60 * 60 * 1000;
/** Tolerance for peers whose clock runs ahead of ours before we distrust a write. */
const MAX_CLOCK_SKEW_MS = 60_000;
/** Don't re-attempt a failed mkdir more than once per this interval. */
const DIR_RETRY_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Expand a leading `~` so hand-written config paths behave as users expect. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Directory to hold the state file, in preference order:
 *   1. `sharedStateDir` config / `PI_GWDG_SHARED_STATE_DIR` env
 *   2. `$XDG_RUNTIME_DIR/pi-gwdg` — tmpfs, mode 0700, user-owned
 *   3. `<agentDir>/extensions/gwdg-state` — for non-systemd hosts, some
 *      containers, and ssh sessions without pam_systemd, where XDG_RUNTIME_DIR
 *      is simply absent. On-disk, but correctness matters more than tmpfs here.
 */
function resolveStateDir(): string {
  const configured = getConfiguredSharedStateDir();
  if (configured) return expandHome(configured);

  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, STATE_SUBDIR);

  return join(getAgentDir(), "extensions", FALLBACK_SUBDIR);
}

/**
 * Filename component identifying the credential this state belongs to.
 *
 * Hashed, never the key itself: the path is world-visible metadata on some
 * systems (process listings, strace, backups of the fallback dir), and two
 * sessions on different keys must not share a file.
 */
function stateFileName(): string {
  let host = config.baseUrl;
  try {
    host = new URL(config.baseUrl).host;
  } catch {
    // Unparseable baseUrl — the raw string still partitions correctly.
  }
  const digest = createHash("sha256")
    .update(host)
    .update("\0")
    .update(apiKey)
    .digest("hex")
    .slice(0, 16);
  return `${digest}.json`;
}

/**
 * Full path to the state file, or null if it cannot be resolved.
 *
 * Recomputed per call (pure string work, no syscalls) so a mid-session
 * `GWDG_API_KEY` or config change is picked up — `refreshConfig` supports both.
 */
export function getSharedStatePath(): string | null {
  try {
    return join(resolveStateDir(), stateFileName());
  } catch (err) {
    trace("shared-state: path resolution failed (%s)", errText(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Directory creation (write path only)
// ---------------------------------------------------------------------------

/** Dirs known to exist, so the common case costs no syscall. */
const ensuredDirs = new Set<string>();
/** Last mkdir failure per dir, to avoid retrying on every single request. */
const dirFailures = new Map<string, number>();

/**
 * Ensure `dir` exists with mode 0700. Returns false if it could not be created,
 * in which case publishing is skipped — reads are unaffected, since a missing
 * directory reads the same as a missing file.
 */
function ensureDir(dir: string): boolean {
  if (ensuredDirs.has(dir)) return true;

  const lastFailure = dirFailures.get(dir);
  if (lastFailure !== undefined && Date.now() - lastFailure < DIR_RETRY_INTERVAL_MS) {
    return false;
  }

  try {
    // 0700 matches XDG_RUNTIME_DIR's own permissions: this state is per-user and
    // no other account has any business reading or writing it.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensuredDirs.add(dir);
    dirFailures.delete(dir);
    return true;
  } catch (err) {
    dirFailures.set(dir, Date.now());
    debug("shared-state: cannot create %s (%s) — publishing disabled", dir, errText(err));
    trace("shared-state: mkdir failed for %s (%s)", dir, errText(err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the shared state, or null when there is nothing trustworthy to read
 * (no file yet, unreadable, malformed, or failing the sanity checks below).
 *
 * Never throws.
 */
export function readSharedRateLimitState(): SharedRateLimitState | null {
  const path = getSharedStatePath();
  if (!path) return null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // Overwhelmingly ENOENT: no peer has published yet. Not worth a log line on
    // every request.
    return null;
  }

  try {
    return validate(JSON.parse(raw));
  } catch (err) {
    trace("shared-state: unparseable state at %s (%s)", path, errText(err));
    return null;
  }
}

/**
 * Reject anything we would not want to act on. The file is trusted only as far
 * as it is well-formed: it is written by peer processes that may have crashed
 * mid-write (mitigated by atomic rename), run an older version, or have a clock
 * that disagrees with ours.
 */
function validate(parsed: unknown): SharedRateLimitState | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;

  if (o.v !== 1) {
    trace("shared-state: ignoring entry with version %j", o.v);
    return null;
  }

  const resetTimestamp = Number(o.resetTimestamp);
  const writtenAt = Number(o.writtenAt);
  if (!Number.isFinite(resetTimestamp) || !Number.isFinite(writtenAt)) return null;
  if (resetTimestamp < 0 || writtenAt < 0) return null;

  const now = Date.now();
  // A write timestamped in our future means our clock and the writer's disagree
  // (or the file was hand-edited); the reset it carries is not something to
  // block a request on.
  if (writtenAt > now + MAX_CLOCK_SKEW_MS) {
    trace("shared-state: ignoring entry written %dms in the future", writtenAt - now);
    return null;
  }
  if (resetTimestamp - now > MAX_TRUSTED_RESET_MS) {
    trace("shared-state: ignoring implausible reset %dms away", resetTimestamp - now);
    return null;
  }

  return {
    v: 1,
    resetTimestamp,
    writtenAt,
    windows: isWindows(o.windows) ? o.windows : {},
    pid: Number.isFinite(Number(o.pid)) ? Number(o.pid) : 0,
  };
}

/** Shallow shape check — the windows are display data, not decision inputs. */
function isWindows(value: unknown): value is RateLimitWindows {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Unix ms of our last successful publish, for the throttle below. */
let lastPublishAt = 0;
/** Whether our last publish announced an active limit (governs throttle bypass). */
let lastPublishHadLimit = false;
/** Disambiguates temp files when a pid is reused after a crash. */
let tmpCounter = 0;

/**
 * Minimum gap between routine (nothing-changed) publishes. Successful responses
 * arrive often enough that refreshing the window snapshot on every one is pure
 * write amplification; anything that materially changes the shared picture
 * bypasses this.
 */
const PUBLISH_THROTTLE_MS = 2_000;

/**
 * Publish what this session now knows about the shared quota.
 *
 * @param state.resetTimestamp Unix ms the quota resets; 0 to announce recovery
 * @param state.windows Latest per-window snapshot (optional)
 *
 * Never throws. A failed write means peers keep using their previous picture,
 * which is the pre-feature behaviour.
 */
export function publishSharedRateLimitState(state: {
  resetTimestamp: number;
  windows?: RateLimitWindows;
}): void {
  try {
    const hasLimit = state.resetTimestamp > Date.now();
    // Always let through anything that changes whether peers should hold off;
    // throttle only the routine snapshot refreshes.
    const material = hasLimit || lastPublishHadLimit;
    if (!material && Date.now() - lastPublishAt < PUBLISH_THROTTLE_MS) return;

    const path = getSharedStatePath();
    if (!path) return;
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!ensureDir(dir)) return;

    const payload: SharedRateLimitState = {
      v: 1,
      resetTimestamp: state.resetTimestamp > 0 ? state.resetTimestamp : 0,
      windows: state.windows ?? {},
      writtenAt: Date.now(),
      pid: process.pid,
    };

    // Atomic publish: a peer reading concurrently sees either the whole old file
    // or the whole new one, never a half-written one. Temp file must be in the
    // same directory so the rename stays within one filesystem.
    const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, path);

    lastPublishAt = payload.writtenAt;
    lastPublishHadLimit = hasLimit;
    trace("shared-state: published reset=%d (limit=%s) to %s",
      payload.resetTimestamp, hasLimit, path);
  } catch (err) {
    // Full tmpfs, revoked permissions, read-only mount — all non-fatal.
    trace("shared-state: publish failed (%s)", errText(err));
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Snapshot of the shared-state layer for `/gwdg-status`. Never throws. */
export function getSharedStateDiagnostics(enabled: boolean): SharedStateDiagnostics {
  return {
    enabled,
    path: getSharedStatePath(),
    state: enabled ? readSharedRateLimitState() : null,
  };
}

/** Uniform error text for the trace log. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
