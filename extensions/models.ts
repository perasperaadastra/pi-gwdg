/**
 * Model discovery and caching for GWDG provider.
 *
 * Fetches models from the GWDG API and caches them locally for 30 days.
 * Cache is stored under getAgentDir()/cache/pi-gwdg/models-cache.json.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import {
  getModelCacheTtlMs,
  getModelOverride,
  recordModelCacheAge,
} from "./config.js";
import { debug } from "./debug.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheFile {
  models: GwdgApiModel[];
  timestamp: number;
  baseUrl: string;
}

interface GwdgApiModel {
  id: string;
  name?: string;
  description?: string;
  context_window?: number;
  max_tokens?: number;
  /** Current load indicator reported by the API (higher = busier). Live value, never cached. */
  demand?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = "cache/pi-gwdg";
const CACHE_FILE = "models-cache.json";

// ---------------------------------------------------------------------------
// Vision capability heuristics
// ---------------------------------------------------------------------------

const VISION_PATTERNS = [
  /\bimage\b/i,
  /\bgemma-4\b/i,
  /\bmistral-medium\b/i,
  /\bomni\b/i,
  /^qwen3\.5/,
  /^qwen3\.6/,
];

function hasVisionCapability(modelId: string, modelName?: string): boolean {
  const fields = [modelId, modelName].filter(Boolean).join(" ");
  return VISION_PATTERNS.some((p) => p.test(fields));
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Get path to the cache file */
function getCacheDir(): string {
  return join(getAgentDir(), CACHE_DIR);
}

function getCacheFilePath(): string {
  return join(getCacheDir(), CACHE_FILE);
}

/**
 * Load models from cache.
 * Returns null if cache is missing, expired, or for a different baseUrl.
 */
export async function loadModelsFromCache(baseUrl: string): Promise<ProviderModelConfig[] | null> {
  const cachePath = getCacheFilePath();

  if (!existsSync(cachePath)) {
    debug("Cache file not found");
    return null;
  }

  try {
    const raw = await readFile(cachePath, "utf8");
    const cache: CacheFile = JSON.parse(raw);

    // Validate baseUrl match
    if (cache.baseUrl !== baseUrl) {
      debug("Cache baseUrl mismatch: expected %s, got %s", baseUrl, cache.baseUrl);
      return null;
    }

      // Validate TTL
    const ttlMs = getModelCacheTtlMs();
    const age = Date.now() - cache.timestamp;
    if (age > ttlMs) {
      debug("Cache expired (age: %d days, TTL: %d days)", Math.floor(age / 86400000), Math.floor(ttlMs / 86400000));
      return null;
    }

    recordModelCacheAge(age);
    debug("Loaded %d models from cache (age: %d days)", cache.models.length, Math.floor(age / 86400000));
    return mapModels(cache.models);
  } catch (err) {
    debug("Cache load error:", err);
    return null;
  }
}

/**
 * Fetch models from the GWDG API.
 */
export async function fetchModelsFromApi(baseUrl: string, apiKey: string): Promise<ProviderModelConfig[]> {
  if (!apiKey) {
    debug("No API key available, returning empty model list");
    return [];
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/models`;

  try {
    debug("Fetching models from %s", url);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 401) {
      debug("Auth error (401): API key is invalid or not set");
      return [];
    }

    if (!response.ok) {
      debug("API error: %d %s", response.status, response.statusText);
      return [];
    }

    const body = (await response.json()) as { data: GwdgApiModel[] };
    const models = body.data ?? [];
    debug("Fetched %d models from API", models.length);

    return mapModels(models);
  } catch (err) {
    debug("Network error fetching models:", err);
    return [];
  }
}

/**
 * Fetch the live per-model demand from the GWDG API.
 *
 * `demand` is the API's current load indicator for a model (higher = busier),
 * so it is deliberately not persisted with the model cache — a value read from
 * a 30-day-old cache would be meaningless. Returns null when it cannot be
 * fetched (no API key, auth error, network failure); callers render without it.
 */
export async function fetchModelDemand(baseUrl: string, apiKey: string): Promise<Map<string, number> | null> {
  if (!apiKey) {
    debug("No API key available, cannot fetch model demand");
    return null;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/models`;

  try {
    debug("Fetching model demand from %s", url);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      debug("Demand fetch failed: %d %s", response.status, response.statusText);
      return null;
    }

    const body = (await response.json()) as { data?: GwdgApiModel[] };
    const demand = new Map<string, number>();
    for (const m of body.data ?? []) {
      if (typeof m.demand === "number") demand.set(m.id, m.demand);
    }
    debug("Fetched demand for %d models", demand.size);
    return demand.size > 0 ? demand : null;
  } catch (err) {
    debug("Network error fetching model demand:", err);
    return null;
  }
}

/**
 * Save models to cache.
 */
export async function saveModelsToCache(models: ProviderModelConfig[], baseUrl: string): Promise<void> {
  const cachePath = getCacheFilePath();
  const cacheDir = dirname(cachePath);

  try {
    await mkdir(cacheDir, { recursive: true });

    // Strip runtime fields before caching
    const apiModels: GwdgApiModel[] = models.map((m) => ({
      id: m.id,
      name: m.name,
      context_window: m.contextWindow,
      max_tokens: m.maxTokens,
    }));

    const cache: CacheFile = {
      models: apiModels,
      timestamp: Date.now(),
      baseUrl,
    };

    await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
    debug("Saved %d models to cache", models.length);
  } catch (err) {
    debug("Cache write error:", err);
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Map raw API model objects to pi ProviderModelConfig format.
 */
function mapModels(apiModels: GwdgApiModel[]): ProviderModelConfig[] {
  return apiModels.map((m) => {
    // Check for per-model overrides from config
    const override = getModelOverride(m.id);
    const vision = hasVisionCapability(m.id, m.name);

    return {
      id: m.id,
      name: m.name ?? m.id,
      reasoning: override?.reasoning ?? false,
      input: override?.input ?? (vision ? (["text", "image"] as const) : (["text"] as const)),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: override?.contextWindow ?? m.context_window ?? 128000,
      maxTokens: override?.maxTokens ?? m.max_tokens ?? 4096,
      ...(override?.thinkingLevelMap ? { thinkingLevelMap: override.thinkingLevelMap } : {}),
    };
  });
}
