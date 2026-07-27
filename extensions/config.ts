/**
 * Config loading and module-level mutable state for pi-gwdg extension.
 *
 * Follows the same pattern as pi-search-hub/extensions/config.ts:
 * global + project JSON config merging, module-level state singletons,
 * TTL-guarded refresh, and state-inspection helpers.
 *
 * Config file: `gwdg.json` (not `search.json`) to avoid confusion.
 *
 * @module
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { debug } from "./debug.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-facing config shape. All fields optional — defaults fill the gaps. */
export interface GwdgConfig {
  /** API base URL (default: https://chat-ai.academiccloud.de/v1) */
  baseUrl?: string;
  /** Model cache TTL in days (default: 30) */
  modelCacheTtlDays?: number;
  /** Footer status auto-clear timeout in seconds (default: 10, 0 = never) */
  footerTimeoutSec?: number;
  /** Hide footer status entirely (env: PI_GWDG_HIDE_FOOTER, default: false) */
  hideFooter?: boolean;
  /** Enable debug logging (env: PI_GWDG_DEBUG, default: false) */
  debug?: boolean;
  /** Per-model overrides (id → overrides) */
  modelOverrides?: Record<string, GwdgModelOverride>;
  /** Model cache TTL override in milliseconds (computed from modelCacheTtlDays) */
  modelCacheTtlMs?: number;
  /**
   * Whether to emit rate limit data on the shared pi event bus.
   * When true, `after_provider_response` emits `pi:rate-limits` and
   * `pi:rate-limited` events. Other extensions can subscribe via
   * `eventBus.on("pi:rate-limits", ...)`.
   *
   * Env var: PI_GWDG_EMIT_RATE_LIMIT_EVENTS ("1" = enable)
   * Default: false
   */
  emitRateLimitEvents?: boolean;
  /**
   * Maximum time (seconds) to wait for a rate-limit (429) reset before giving
   * up. On a 429, if the provider's reset is within this budget the request is
   * allowed to wait and retry; if the reset is further away than this, the
   * request is failed immediately instead of blocking until quota resets.
   *
   * Env var: PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC
   * Default: 3600 (0 = never wait — fail on the first 429)
   */
  maxRateLimitWaitSec?: number;
  /**
   * Share rate-limit state between concurrent pi sessions through a small JSON
   * file on tmpfs (see shared-state.ts). GWDG quota is per API key but pi's
   * rate-limit state is per process, so without this each session discovers an
   * exhausted quota by burning its own request on a 429. With it, one session's
   * 429 makes its peers wait instead.
   *
   * Env var: PI_GWDG_SHARED_STATE ("1"/"true" = enable, "0"/"false" = disable)
   * Default: true
   */
  sharedRateLimitState?: boolean;
  /**
   * Directory holding the shared rate-limit state file. Empty means auto:
   * `$XDG_RUNTIME_DIR/pi-gwdg` (tmpfs, mode 0700), falling back to
   * `<agentDir>/extensions/gwdg-state` when XDG_RUNTIME_DIR is unset.
   * A leading `~` is expanded.
   *
   * Env var: PI_GWDG_SHARED_STATE_DIR
   * Default: "" (auto)
   */
  sharedStateDir?: string;
  /**
   * Random extra delay (0..N ms) added to a wait triggered by shared state, so
   * peers released by the same quota reset do not all fire at the identical
   * instant and immediately re-exhaust the window.
   *
   * Env var: PI_GWDG_SHARED_STATE_JITTER_MS
   * Default: 1000 (0 = no jitter)
   */
  sharedStateJitterMs?: number;
}

/** Per-model config overrides (optional fields merged on top of API data). */
export interface GwdgModelOverride {
  /** Override context window size */
  contextWindow?: number;
  /** Override max output tokens */
  maxTokens?: number;
  /** Override reasoning flag */
  reasoning?: boolean;
  /** Override input capabilities (e.g. ["text"] or ["text", "image"]) */
  input?: ("text" | "image")[];
  /**
   * Maps pi thinking levels to provider-specific values.
   * Keys: pi thinking levels (off, minimal, low, medium, high, xhigh, max).
   * Values: string to send to the provider, or null to mark the level unsupported.
   * Omitted keys use the default mapping (off through high as-is, xhigh/max unsupported).
   *
   * Example for openai-completions with reasoning_effort:
   *   { "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max", "minimal": null, "off": null }
   */
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default footer timeout in seconds (also used as fallback in getFooterTimeoutMs). */
const DEFAULT_FOOTER_TIMEOUT_SEC = 60;
/** Default max rate-limit wait in seconds (also used as fallback in getMaxRateLimitWaitSec). */
const DEFAULT_MAX_RATE_LIMIT_WAIT_SEC = 3600;
/** Default shared-state wake jitter in ms (also used as fallback in getSharedStateJitterMs). */
const DEFAULT_SHARED_STATE_JITTER_MS = 1000;

function getDefaultConfig(): Required<GwdgConfig> {
  return {
    baseUrl: "https://chat-ai.academiccloud.de/v1",
    modelCacheTtlDays: 30,
    modelCacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    footerTimeoutSec: DEFAULT_FOOTER_TIMEOUT_SEC,
    hideFooter: false,
    debug: false,
    modelOverrides: {},
    emitRateLimitEvents: false,
    maxRateLimitWaitSec: DEFAULT_MAX_RATE_LIMIT_WAIT_SEC,
    // On by default: it is fail-open, and every failure mode degrades to the
    // per-process behaviour it replaces.
    sharedRateLimitState: true,
    sharedStateDir: "",
    sharedStateJitterMs: DEFAULT_SHARED_STATE_JITTER_MS,
  };
}

// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------

/** Resolved config with all defaults applied. */
export let config: Required<GwdgConfig> = getDefaultConfig();

/** Current API key value (read from env at refresh time). */
export let apiKey: string = "";

/** File-backed model cache age in ms (set on each cache load). */
export let modelCacheAge: number = 0;

/** Timestamp of the most recent provider registration (for diagnostics). */
export let providerRegisteredAt: number = 0;

/** Model count at last registration. */
export let lastModelCount: number = 0;

// ---------------------------------------------------------------------------
// Config loading — same global+project merge as search-hub
// ---------------------------------------------------------------------------

const CONFIG_FILE = "gwdg.json";

/**
 * Load config from global (${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg.json) and project
 * (.pi/gwdg.json) paths, deep-merging project on top of global.
 *
 * For `modelOverrides`, the merge is additive at both levels:
 *   global overrides are base, project overrides are layered on top.
 * An empty `modelOverrides: {}` from either level is treated as "no overrides"
 * and will NOT wipe overrides from the other level.
 *
 * Returns a resolved config with all defaults applied.
 */
export function loadConfig(cwd: string): Required<GwdgConfig> {
  const globalPath = join(getAgentDir(), "extensions", CONFIG_FILE);
  const projectPath = join(cwd, ".pi", CONFIG_FILE);

  // Track modelOverrides separately to preserve non-empty overrides at each
  // level: spread operator on the flat object would let a project-level
  // empty `{}` wipe global overrides.
  let globalOverrides: Record<string, GwdgModelOverride> | undefined;
  let projectOverrides: Record<string, GwdgModelOverride> | undefined;

  let cfg: GwdgConfig = {};

  // Global first
  if (existsSync(globalPath)) {
    try {
      const globalRaw = JSON.parse(readFileSync(globalPath, "utf-8"));
      // Preserve modelOverrides before the flat spread
      if (globalRaw.modelOverrides && typeof globalRaw.modelOverrides === "object") {
        const keys = Object.keys(globalRaw.modelOverrides);
        if (keys.length > 0) {
          globalOverrides = { ...globalRaw.modelOverrides };
        }
      }
      cfg = { ...cfg, ...globalRaw };
    } catch {
      // Silently ignore malformed global config
    }
  }

  // Project overrides global
  if (existsSync(projectPath)) {
    try {
      const project = JSON.parse(readFileSync(projectPath, "utf-8"));
      // Preserve project modelOverrides before the flat spread
      if (project.modelOverrides && typeof project.modelOverrides === "object") {
        const keys = Object.keys(project.modelOverrides);
        if (keys.length > 0) {
          projectOverrides = { ...project.modelOverrides };
        }
      }
      cfg = { ...cfg, ...project };
    } catch {
      // Silently ignore malformed project config
    }
  }

  // Deep-merge modelOverrides: global base + project additions
  const mergedOverrides: Record<string, GwdgModelOverride> = {
    ...(globalOverrides ?? {}),
    ...(projectOverrides ?? {}),
  };
  cfg.modelOverrides = mergedOverrides;

  return resolveConfig(cfg);
}

/**
 * Apply defaults on top of a partial config.
 */
function resolveConfig(partial: GwdgConfig): Required<GwdgConfig> {
  const defaults = getDefaultConfig();

  const resolved: Required<GwdgConfig> = {
    ...defaults,
    ...partial,
  };

  // Ensure consistency: if modelCacheTtlDays is explicitly set, recompute ms
  if (partial.modelCacheTtlDays !== undefined) {
    resolved.modelCacheTtlMs = partial.modelCacheTtlDays * 24 * 60 * 60 * 1000;
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Refresh — TTL-guarded, env-aware, updates module-level singletons
// ---------------------------------------------------------------------------

let configCacheTime = 0;
const CONFIG_TTL_MS = 10_000; // re-read files at most every 10s

/**
 * Read a tri-state boolean env var.
 *
 * The older flags here are all opt-in, so `=== "1"` was enough. A setting that
 * defaults to ON needs the off direction too, hence the explicit undefined for
 * "unset — leave the config value alone".
 */
function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

/**
 * Re-read config files (if TTL expired) and update all module-level state.
 *
 * Also reads the API key from the environment each time so that setting
 * GWDG_API_KEY mid-session has effect.
 *
 * @param cwd - Working directory for project-level config lookup
 * @param force - Bypass TTL and force re-read
 */
export function refreshConfig(cwd: string, force = false): Required<GwdgConfig> {
  const now = Date.now();
  if (!force && now - configCacheTime < CONFIG_TTL_MS) return config;

  // Load fresh config
  const fresh = loadConfig(cwd);
  config = fresh;
  configCacheTime = now;

  // Read env vars (override config file where present)
  const envKey = process.env.GWDG_API_KEY ?? "";
  apiKey = envKey;

  if (process.env.PI_GWDG_DEBUG === "1") {
    config.debug = true;
  }
  if (process.env.PI_GWDG_HIDE_FOOTER === "1") {
    config.hideFooter = true;
  }
  const footerTimeoutRaw = process.env.PI_GWDG_FOOTER_TIMEOUT;
  if (footerTimeoutRaw !== undefined && footerTimeoutRaw !== "") {
    const n = Number(footerTimeoutRaw);
    if (Number.isFinite(n) && n >= 0) {
      config.footerTimeoutSec = n;
    }
  }
  if (process.env.PI_GWDG_EMIT_RATE_LIMIT_EVENTS === "1") {
    config.emitRateLimitEvents = true;
  }
  const maxWaitRaw = process.env.PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC;
  if (maxWaitRaw !== undefined && maxWaitRaw !== "") {
    const n = Number(maxWaitRaw);
    if (Number.isFinite(n) && n >= 0) {
      config.maxRateLimitWaitSec = n;
    }
  }
  const sharedStateEnv = envBool("PI_GWDG_SHARED_STATE");
  if (sharedStateEnv !== undefined) {
    config.sharedRateLimitState = sharedStateEnv;
  }
  const sharedDirRaw = process.env.PI_GWDG_SHARED_STATE_DIR;
  if (sharedDirRaw !== undefined && sharedDirRaw !== "") {
    config.sharedStateDir = sharedDirRaw;
  }
  const jitterRaw = process.env.PI_GWDG_SHARED_STATE_JITTER_MS;
  if (jitterRaw !== undefined && jitterRaw !== "") {
    const n = Number(jitterRaw);
    if (Number.isFinite(n) && n >= 0) {
      config.sharedStateJitterMs = n;
    }
  }

  // Log on first load if debug enabled
  if (config.debug && force) {
    debug("Config refreshed:");
    debug("  baseUrl: %s", config.baseUrl);
    debug("  modelCacheTtlMs: %d", config.modelCacheTtlMs);
    debug("  footerTimeoutSec: %d", config.footerTimeoutSec);
    debug("  hideFooter: %s", config.hideFooter);
    debug("  emitRateLimitEvents: %s", config.emitRateLimitEvents);
    debug("  sharedRateLimitState: %s", config.sharedRateLimitState);
    debug("  sharedStateDir: %s", config.sharedStateDir || "(auto)");
    debug("  sharedStateJitterMs: %d", config.sharedStateJitterMs);
    debug("  modelOverrides: %d entries", Object.keys(config.modelOverrides ?? {}).length);
  }

  return config;
}

/**
 * Record that the provider was registered with N models.
 */
export function recordProviderRegistration(modelCount: number): void {
  providerRegisteredAt = Date.now();
  lastModelCount = modelCount;
}

/**
 * Record model cache age (time since cache was written).
 */
export function recordModelCacheAge(ageMs: number): void {
  modelCacheAge = ageMs;
}

// ---------------------------------------------------------------------------
// Setting mutation — live apply + optional persist to project file
// ---------------------------------------------------------------------------

export type SettingValue = string | number | boolean | undefined;

/**
 * Update a single config setting in the module-level `config` singleton.
 *
 * If `persistPath` is provided, writes the update to that JSON file
 * (creating parent directories as needed), merging with existing content.
 *
 * Supported settings and their types:
 *
 * | Setting              | Type    | Values                  |
 * |----------------------|---------|-------------------------|
 * | hideFooter           | boolean | true / false            |
 * | debug                | boolean | true / false            |
 * | footerTimeoutSec     | number  | 0-300                   |
 * | modelCacheTtlDays    | number  | 1-365                   |
 * | emitRateLimitEvents  | boolean | true / false            |
 * | maxRateLimitWaitSec  | number  | 0-86400                 |
 * | sharedRateLimitState | boolean | true / false            |
 * | sharedStateDir       | string  | any path ("" = auto)    |
 * | sharedStateJitterMs  | number  | 0-60000                 |
 * | baseUrl              | string  | any URL                 |
 */
export function setSetting(
  key: string,
  value: SettingValue,
  persistPath?: string,
): void {
  // Update module-level config
  if (key === "hideFooter" && typeof value === "boolean") {
    config.hideFooter = value;
  } else if (key === "debug" && typeof value === "boolean") {
    config.debug = value;
  } else if (key === "footerTimeoutSec" && typeof value === "number") {
    config.footerTimeoutSec = Math.max(0, Math.min(300, value));
  } else if (key === "modelCacheTtlDays" && typeof value === "number") {
    const days = Math.max(1, Math.min(365, value));
    config.modelCacheTtlDays = days;
    config.modelCacheTtlMs = days * 24 * 60 * 60 * 1000;
  } else if (key === "emitRateLimitEvents" && typeof value === "boolean") {
    config.emitRateLimitEvents = value;
  } else if (key === "maxRateLimitWaitSec" && typeof value === "number") {
    config.maxRateLimitWaitSec = Math.max(0, Math.min(86400, value));
  } else if (key === "sharedRateLimitState" && typeof value === "boolean") {
    config.sharedRateLimitState = value;
  } else if (key === "sharedStateDir" && typeof value === "string") {
    config.sharedStateDir = value;
  } else if (key === "sharedStateJitterMs" && typeof value === "number") {
    // Capped at a minute: jitter exists to spread a wake-up, not to add a wait.
    config.sharedStateJitterMs = Math.max(0, Math.min(60_000, value));
  } else if (key === "baseUrl" && typeof value === "string") {
    config.baseUrl = value;
  }

  // Persist to project config file if requested
  if (persistPath) {
    try {
      let existing: Record<string, unknown> = {};
      if (existsSync(persistPath)) {
        existing = JSON.parse(readFileSync(persistPath, "utf-8"));
      }
      existing[key] = value;
      const dir = persistPath.substring(0, persistPath.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(persistPath, JSON.stringify(existing, null, 2) + "\n");
    } catch {
      // Silently fail to write
    }
  }
}

/**
 * Persist multiple settings at once. Used by the settings UI when the user
 * closes the dialog and wants to save all current values.
 */
export function persistSettings(
  settings: Record<string, SettingValue | Record<string, unknown>>,
  persistPath: string,
): void {
  try {
    let existing: Record<string, unknown> = {};
    if (existsSync(persistPath)) {
      existing = JSON.parse(readFileSync(persistPath, "utf-8"));
    }
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) {
        existing[key] = value;
      } else {
        delete existing[key];
      }
    }
    const dir = persistPath.substring(0, persistPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(persistPath, JSON.stringify(existing, null, 2) + "\n");
  } catch {
    // Silently fail to write
  }
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/**
 * Whether rate limit event emission is enabled.
 * Checks both config and env var at call time.
 */
export function isRateLimitEmitEnabled(): boolean {
  return config.emitRateLimitEvents || process.env.PI_GWDG_EMIT_RATE_LIMIT_EVENTS === "1";
}

/**
 * Whether debug logging is enabled (checks both config and env at call time).
 */
export function isDebugEnabled(): boolean {
  return config.debug || process.env.PI_GWDG_DEBUG === "1";
}

/**
 * Get footer timeout in milliseconds.
 */
export function getFooterTimeoutMs(): number {
  const sec = config.footerTimeoutSec;
  return sec > 0 ? sec * 1000 : sec === 0 ? Infinity : DEFAULT_FOOTER_TIMEOUT_SEC * 1000;
}

/**
 * Max seconds to wait for a rate-limit reset before failing the request.
 * 0 means never wait (fail on the first 429).
 */
export function getMaxRateLimitWaitSec(): number {
  const sec = config.maxRateLimitWaitSec;
  return Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_MAX_RATE_LIMIT_WAIT_SEC;
}

/**
 * Whether cross-session rate-limit state sharing is enabled.
 *
 * Checks the env var at call time (like isDebugEnabled) so it can be flipped
 * mid-session, and in both directions since the default is on.
 */
export function isSharedRateLimitStateEnabled(): boolean {
  const env = envBool("PI_GWDG_SHARED_STATE");
  if (env !== undefined) return env;
  return config.sharedRateLimitState;
}

/**
 * Configured shared-state directory, or "" to let shared-state.ts resolve one.
 */
export function getConfiguredSharedStateDir(): string {
  return config.sharedStateDir ?? "";
}

/**
 * Maximum random delay (ms) added to a shared-state wait, to keep peers from
 * waking in lockstep at the same quota reset.
 */
export function getSharedStateJitterMs(): number {
  const ms = config.sharedStateJitterMs;
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SHARED_STATE_JITTER_MS;
}

/**
 * Get model cache TTL in milliseconds.
 */
export function getModelCacheTtlMs(): number {
  return config.modelCacheTtlMs;
}

/**
 * Get per-model override for a given model id (if any).
 */
export function getModelOverride(modelId: string): GwdgModelOverride | undefined {
  return config.modelOverrides?.[modelId];
}

// ---------------------------------------------------------------------------
// Model override helpers
// ---------------------------------------------------------------------------

/**
 * Set or update a per-model override.
 *
 * Merges the provided fields into the existing override for `modelId`.
 * If `persistPath` is provided, also writes the full updated config
 * to the project config file.
 *
 * @param modelId - The model ID to override
 * @param fields - Fields to set/merge into the override
 * @param persistPath - Optional project config path to persist to
 */
export function setModelOverride(
  modelId: string,
  fields: Partial<GwdgModelOverride>,
  persistPath?: string,
): void {
  if (!config.modelOverrides) config.modelOverrides = {};
  config.modelOverrides[modelId] = {
    ...config.modelOverrides[modelId],
    ...fields,
  };

  if (persistPath) {
    persistModelOverrides(persistPath);
  }
}

/**
 * Set a single field on a per-model override.
 *
 * Convenience wrapper around `setModelOverride` for a single field.
 *
 * @param modelId - The model ID to override
 * @param field - Field name to set
 * @param value - New value for the field
 * @param persistPath - Optional project config path to persist to
 */
export function setModelOverrideField(
  modelId: string,
  field: keyof GwdgModelOverride,
  value: unknown,
  persistPath?: string,
): void {
  setModelOverride(modelId, { [field]: value }, persistPath);
}

/**
 * Remove a per-model override entirely.
 *
 * @param modelId - The model ID to remove
 * @param persistPath - Optional project config path to persist to
 */
export function removeModelOverride(
  modelId: string,
  persistPath?: string,
): void {
  if (config.modelOverrides?.[modelId] === undefined) return;
  delete config.modelOverrides[modelId];

  if (persistPath) {
    persistModelOverrides(persistPath);
  }
}

/**
 * Get the list of model IDs that have overrides.
 */
export function getOverrideModelIds(): string[] {
  return config.modelOverrides ? Object.keys(config.modelOverrides) : [];
}

/**
 * Persist the full modelOverrides to a config file.
 */
function persistModelOverrides(persistPath: string): void {
  try {
    let existing: Record<string, unknown> = {};
    if (existsSync(persistPath)) {
      existing = JSON.parse(readFileSync(persistPath, "utf-8"));
    }
    existing.modelOverrides = config.modelOverrides;
    const dir = persistPath.substring(0, persistPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(persistPath, JSON.stringify(existing, null, 2) + "\n");
  } catch {
    // Silently fail to write
  }
}
