/**
 * GWDG Provider Extension
 *
 * Provides access to GWDG models via dynamic model fetching
 * and OpenAI-compatible API with enhanced rate limit error handling.
 *
 * Usage:
 *   # If auth required:
 *   export GWDG_API_KEY=your-key
 *
 *   # Load extension
 *   pi -e ./pi-gwdg
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { createStreamSimpleGwdg } from "./stream-gwdg.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// Cache configuration
const CACHE_FILE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days on disk
const CACHE_DIR = join(getAgentDir(), "cache", "pi-gwdg");
const CACHE_FILE = join(CACHE_DIR, "models-cache.json");

const GWDG_DEBUG = process.env.GWDG_DEBUG === "1";
const GWDG_ASYNC_INIT = process.env.GWDG_ASYNC_INIT === "true";
const GWDG_API_KEY_NAME = "GWDG_API_KEY";

function debug(...args: unknown[]): void {
  if (GWDG_DEBUG) {
    console.log("[GWDG EXTENSION DEBUG]", ...args);
  }
}

let gwdgSetupDone = false;
let gwdgSetupFailed = false;
let gwdgSetupInProgress = false;

// GWDG endpoints
const GWDG_ENDPOINTS = [
    "https://saia.gwdg.de/v1/",
    "https://chat-ai.academiccloud.de/v1/"
];

// Helper to get base URL without trailing slash
function getBaseUrl(): string {
    return GWDG_ENDPOINTS[0].replace(/\/$/, '');
}

interface CacheData {
  models: Model[];
  timestamp: number;
  baseUrl: string;
}

interface ProviderModel {
  id: string;
  name?: string;        // Made optional - GWDG doesn't provide this
  object?: string;      // Added - present in GWDG response
  input?: ("text" | "image")[];   // Made optional
  output?: ("text" | "image")[];  // Made optional
  status?: string;      // Made optional - not present in GWDG response
  created?: number;
  owned_by?: string;
}

async function registerProvider(pi: ExtensionAPI | undefined, ctx: ExtensionContext | undefined, models: Model<"openai-completions">[]) {
    const baseUrl = getBaseUrl();
    debug("registerProvider: pi.events:", pi?.events ? "defined" : "undefined");
    debug("registerProvider: pi:", pi ? "defined" : "undefined", "ctx:", ctx ? "defined" : "undefined");
    const config = {
        baseUrl,
        apiKey: GWDG_API_KEY_NAME,
        api: "openai-completions" as const,
        models: models,
        streamSimple: createStreamSimpleGwdg(pi.events),
    };
    if (ctx) {
        ctx.modelRegistry.registerProvider("gwdg", config);
    } else if (pi) {
        pi.registerProvider("gwdg", config);
    }
    debug("provider registered with", models.length, "models");
}


async function loadModelsFromFile(ctx: ExtensionContext | undefined): Promise<CacheData | null> {
    const baseUrl = getBaseUrl();

    debug("baseUrl present:", !!baseUrl);
    if (!baseUrl) {
        ctx?.ui.notify("GWDG baseUrl missing!", "warning");
        debug("loadModelsFromFile: baseUrl missing");
        return null;
    }
    debug("loadModelsFromFile: trying to load cache for", baseUrl);
    try {
        if (!existsSync(CACHE_FILE)) {
            debug("loadModelsFromFile: cache file does not exist");
            return null;
        }

        const data = JSON.parse(await readFile(CACHE_FILE, "utf-8")) as CacheData;

        if (data.baseUrl !== baseUrl) {
            debug("loadModelsFromFile: cache baseUrl mismatch", data.baseUrl, "!==", baseUrl);
            return null;
        }
        if (Date.now() - data.timestamp > CACHE_FILE_TTL) {
            debug("loadModelsFromFile: cache expired");
            return null;
        }

        debug("loadModelsFromFile: cache loaded successfully, models:", data.models.length);
        return data;
    } catch (e) {
        debug("loadModelsFromFile: error loading cache:", e);
        return null;
    }
}

async function saveModelsToFile(cache: CacheData): Promise<void> {
  debug("saveModelsToFile: saving", cache.models.length, "models to cache");
  try {
    if (!existsSync(CACHE_DIR)) {
      debug("saveModelsToFile: creating cache dir", CACHE_DIR);
      await mkdir(CACHE_DIR, { recursive: true });
    }
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
    debug("saveModelsToFile: cache saved successfully");
  } catch (e) {
    console.warn("Failed to save GWDG models cache:", e);
  }
}

async function loadModelsFromAPI(ctx: ExtensionContext | undefined): Promise<Model<"openai-completions">[]> {
    const baseUrl = getBaseUrl();

    let apiKey: string | undefined;
    let apiKeySet: boolean;
    if (ctx) {
        apiKey = await ctx.modelRegistry.getApiKeyForProvider("gwdg");
        apiKeySet = apiKey != GWDG_API_KEY_NAME;
    } else {
        apiKey = process.env[GWDG_API_KEY_NAME];
        apiKeySet = !!apiKey
    }
    debug("apiKey present:", apiKeySet);
    if (!apiKeySet) {
        ctx?.ui.notify("GWDG API key missing!", "warning");
        debug("loadModelsFromAPI: API key not set");
        return [];
    }

    ctx?.ui.setStatus("GWDG", "Fetching models...");

    debug("loadModelsFromAPI: fetching from", baseUrl, "with apiKey:", !!apiKey);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/models`, { headers });
    if (!response.ok) {
        const errorText = await response.text();
        debug("loadModelsFromAPI: failed with status", response.status, errorText);
        throw new Error(`Failed to fetch models: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as { data: ProviderModel[] };
    debug("loadModelsFromAPI: got", data.data.length, "models from API");

    const models =  data.data.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        reasoning: false,
        input: m.input?.includes("image") ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
    }));

    await saveModelsToFile({ models, timestamp: Date.now(), baseUrl });

    return models
}

async function refreshProvider(
    pi: ExtensionAPI,
    ctx: ExtensionContext | undefined,
    models: Model<"openai-completions">[],
    source: string
): Promise<void> {
    debug("refreshing", models.length, `models from ${source}`);
    await registerProvider(pi, ctx, models);

    if (ctx) {
        ctx.ui.setStatus("GWDG", `${models.length} GWDG models refreshed from ${source}`);
        setTimeout(() => {
            ctx?.ui.setStatus("GWDG", undefined);
        }, 5000);
    }
}

async function refreshModelsFromAPI(
    pi: ExtensionAPI,
    ctx: ExtensionContext | undefined
): Promise<Model<"openai-completions">[]>{
    const models = await loadModelsFromAPI(ctx);
    if (models.length === 0) {
        debug("no models available from api");
        ctx.ui.setStatus("GWDG", "No models available. Check GWDG service.");
        return [];
    }
    await refreshProvider(pi, ctx, models, "API");
    return models
}

async function refreshModelsFromFile(
    pi: ExtensionAPI,
    ctx: ExtensionContext | undefined
): Promise<Model<"openai-completions">[]>{
    const fileCache = await loadModelsFromFile(ctx);
    if (fileCache) {
        debug("loaded", fileCache.models.length, "models from file");
        const models = fileCache.models;
        if (models.length > 0) {
            await refreshProvider(pi, ctx, models, "file");
            return models
        }
    }
    debug("failed loading models from file");
    return await refreshModelsFromAPI(pi, ctx);
}

async function refreshModels(
    pi: ExtensionAPI,
    ctx: ExtensionContext | undefined,
    force: boolean = false,
): Promise<Model<"openai-completions">[]> {
    debug("starting refreshing models");

    try {
        let models: Model<"openai-completions">[];
        if (force) {
            models = await refreshModelsFromAPI(pi, ctx);
        }else{
            models = await refreshModelsFromFile(pi, ctx);
        }
        debug("finished refreshing models");
        return models;
    } catch (error) {
        debug("refreshModels failed:", error);
        ctx?.ui?.notify("Failed to load GWDG models: " + (error as Error).message, "error");
        return [];
    }
}

export default async function (pi: ExtensionAPI) {
    debug("extension loading, GWDG_ASYNC_INIT:", GWDG_ASYNC_INIT);

    if (!GWDG_ASYNC_INIT) {
        debug("starting blocking setup")
        await refreshModels(pi, undefined);
        gwdgSetupDone = true;
        debug("finished blocking setup")
    } else {
        let models: Model<"openai-completions">[] = [];
        registerProvider(pi, undefined, models);
    }

    pi.on("session_start", async (_args, ctx) => {
        if (!gwdgSetupDone && !gwdgSetupFailed && !gwdgSetupInProgress) {
            gwdgSetupInProgress = true;
            debug("starting async setup")
            try {
                await refreshModels(pi, ctx);
                gwdgSetupDone = true;
                debug("finished async setup")
            } catch (error) {
                debug("async setup failed:", error);
                gwdgSetupFailed = true;
                ctx.ui.notify("GWDG setup failed: " + (error as Error).message, "error");
            } finally {
                gwdgSetupInProgress = false;
            }
        }
    });

    pi.registerCommand("refresh-gwdg-models", {
        description: "Refresh GWDG models list from server",
        handler: async (_args, ctx) => {
            debug("starting refresh command");
            await refreshModels(pi, ctx, true);
            debug("finished refresh command");
        }
    });

    // maybe possible at one point
    if ("registerEnvVar" in pi) {
        debug("registering env vars")
        pi.registerEnvVar("GWDG_API_KEY", {
            description: "GWDG provider API key (optional, from pi-gwdg extension)"
        });
    }

    debug("initialization complete");
}
