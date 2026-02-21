/**
 * Key Rotation Manager for GWDG Provider
 *
 * Manages multiple API keys with intelligent rate limit tracking per key.
 * Supports multiple rotation strategies and prefers lower-ID keys when available.
 *
 * This functionality is intentionally undocumented.
 * It's available for advanced users who discover it.
 *
 * Setup:
 *   export PI_GWDG_API_KEY=your-primary-key
 *   export PI_GWDG_API_KEY_1=your-second-key
 *   export PI_GWDG_API_KEY_2=your-third-key
 *   # etc.
 *
 * Configuration:
 *   PI_GWDG_KEY_ROTATION - Strategy: "roundrobin", "random", or "fallback" (default: "fallback")
 *   PI_GWDG_KEY_ROTATION_DEBUG - Enable detailed debug logging (default: "")
 *   PI_GWDG_KEY_ROTATION_ERRORS - HTTP codes triggering rotation (default: "429")
 *   PI_GWDG_MAX_KEY_ATTEMPTS - Max keys to try (0 = unlimited, default: 0)
 *
 * How it works:
 *   1. Key Discovery: All keys with pattern PI_GWDG_API_KEY or PI_GWDG_API_KEY_{n} are discovered
 *   2. Rate Limit Tracking: Each key's rate limit reset time is tracked individually
 *   3. Lower-ID Preference: Key 0 (primary) is preferred when available, then Key 1, etc.
 *   4. Automatic Recovery: Keys automatically become preferred again after rate limit resets
 *   5. Fallback Strategy: On rate limit, automatically switches to next available key
 *
 * Rotation Strategies:
 *   - "fallback": Try keys sequentially, move to next only on error (recommended - lowest-ID preference)
 *   - "roundrobin": Cycle through keys evenly for load balancing
 *   - "random": Random key selection per request
 *
 * Behavior:
 *   - On 429 (rate limit): Key is marked with reset time, next available key is used
 *   - On 401/403 (auth errors): Key is permanently marked as exhausted (always tracked)
 *   - When all keys rate limited: Waits for earliest reset (≤ 5 min) or fails with message
 *   - Keys become available again after their reset timestamp expires
 *
 * Backward Compatibility:
 *   - Single PI_GWDG_API_KEY continues to work exactly as before
 *   - Rotation only activates when multiple keys are detected
 *   - No configuration changes required for existing users
 */

const KEY_ROTATION_DEBUG = process.env.PI_GWDG_KEY_ROTATION_DEBUG === "1";

function krDebug(...args: unknown[]): void {
	  if (KEY_ROTATION_DEBUG) {
		    console.log("[GWDG KEY_ROTATION DEBUG]", ...args);
	  }
}

export interface KeyStatus {
	  key: string; // The actual API key value
	  id: number; // Sequential ID after deduplication and remapping (0, 1, 2, ...)
	  originalId: number; // Original ID from environment variable name
	  resetTimestamp: number | null; // When this key becomes available again (Unix timestamp)
	  isExhausted: boolean; // Permanently failed (401/403)
	  lastError: string | null; // Last error message for debugging
	  sourceEnvVar: string; // Source environment variable name
}

export type RotationStrategy = "roundrobin" | "random" | "fallback";

export interface KeyRotationConfig {
	  baseKeyName: string; // "PI_GWDG_API_KEY"
	  strategy: RotationStrategy;
	  errorCodes: number[]; // [429, 401]
	  maxAttempts: number; // 0 = unlimited
	  warnOnDuplicates?: boolean; // Warn about duplicate keys (default: true)
}

export interface DuplicateKeyInfo {
	  removedId: number;
	  removedSource: string;
	  keptId: number;
	  keptSource: string;
}

export interface IdMappingInfo {
	  newId: number;
	  originalId: number;
	  sourceEnvVar: string;
}

export interface KeyDiscoveryStats {
	  totalFound: number;
	  afterDeduplication: number;
	  duplicatesRemoved: DuplicateKeyInfo[];
	  idMappings: IdMappingInfo[];
}

export class KeyRotationManager {
	  private keys: KeyStatus[] = [];
	  private currentIndex: number = 0;
	  private config: KeyRotationConfig;
	  private discoveryStats: KeyDiscoveryStats

	  constructor(config: KeyRotationConfig) {
		    this.config = config;
		    const warnOnDuplicates = config.warnOnDuplicates ?? true;
		    krDebug("Initializing KeyRotationManager with config:", {
			      baseKeyName: config.baseKeyName,
			      strategy: config.strategy,
			      errorCodes: config.errorCodes,
			      maxAttempts: config.maxAttempts,
			      warnOnDuplicates,
		    });

		    // Discover keys with sources, then deduplicate
		    const keysWithSources = this.discoverKeysWithSources();
		    const { deduplicatedKeys, duplicatesRemoved, idMappings } = this.deduplicateKeys(keysWithSources);

		    this.keys = deduplicatedKeys;
		    this.discoveryStats = {
			      totalFound: keysWithSources.length,
			      afterDeduplication: deduplicatedKeys.length,
			      duplicatesRemoved,
			      idMappings,
		    };

		    // Log discovery summary
		    krDebug(`Discovered ${this.discoveryStats.totalFound} keys`);
		    krDebug(`After deduplication: ${this.discoveryStats.afterDeduplication} keys`);

		    // Log ID remapping if any occurred
		    if (KEY_ROTATION_DEBUG && idMappings.length > 0) {
		      krDebug("ID remapping after deduplication:");
		      for (const mapping of idMappings) {
		        krDebug(`  New ID ${mapping.newId} ← Original ID ${mapping.originalId} (${mapping.sourceEnvVar})`);
		      }
		    }

		    // Log warnings for duplicates
		    if (warnOnDuplicates && duplicatesRemoved.length > 0) {
			      console.warn(
				        `[GWDG Key Rotation] Found ${duplicatesRemoved.length} duplicate API key(s) and removed them:`
			      );
			      for (const dup of duplicatesRemoved) {
				        console.warn(
					          `  - ${dup.removedSource} (id=${dup.removedId}) → duplicate of ${dup.keptSource} (id=${dup.keptId})`
				        );
			      }
			      console.warn(
				        `[GWDG Key Rotation] Avoid setting the same API key under multiple environment variable names.`
			      );
		    }

		    if (KEY_ROTATION_DEBUG) {
			      krDebug("Key states after deduplication:",
				            this.keys.map(k => ({
					              id: k.id,
					              originalId: k.originalId,
					              source: k.sourceEnvVar,
					              key: `${k.key.slice(0, 8)}...`
				            }))
			             );
		    }
	  }

	  /**
	   * Validates that a key is a non-empty string with reasonable length
	   */
	  private isValidKey(keyValue: string | undefined): keyValue is string {
		    if (!keyValue) {
			      return false;
		    }
		    if (typeof keyValue !== 'string') {
			      krDebug(`Invalid key: not a string`);
			      return false;
		    }
		    if (keyValue.trim().length === 0) {
			      krDebug(`Invalid key: empty or whitespace-only`);
			      return false;
		    }
		    // API keys should be at least 3 characters (catches obviously invalid values like "a" or "x")
		    if (keyValue.length < 3) {
			      krDebug(`Invalid key: too short (${keyValue.length} chars, minimum 3)`);
			      return false;
		    }
		    // Cap at 2048 to catch garbage values
		    if (keyValue.length > 2048) {
			      krDebug(`Invalid key: too long (${keyValue.length} chars, maximum 2048)`);
			      return false;
		    }
		    return true;
	  }

	  /**
	   * Discover keys from environment variables with source tracking
	   * Looks for PI_GWDG_API_KEY, PI_GWDG_API_KEY_1, PI_GWDG_API_KEY_2, etc.
	   * Returns keys with their source environment variable names.
	   */
	  private discoverKeysWithSources(): Array<{status: KeyStatus, source: string}> {
		    const keysWithSources: Array<{status: KeyStatus, source: string}> = [];
		    const { baseKeyName } = this.config;
		    krDebug(`Searching for keys with base name: ${baseKeyName}`);
		    // Check for base key (e.g., PI_GWDG_API_KEY)
		    const baseKey = process.env[baseKeyName];
		    if (this.isValidKey(baseKey)) {
			      keysWithSources.push({
				        status: {
					          key: baseKey,
					          id: 0,
					          originalId: 0,
					          resetTimestamp: null,
					          isExhausted: false,
					          lastError: null,
					          sourceEnvVar: baseKeyName,
				        },
				        source: baseKeyName,
			      });
			      krDebug(`Found base key (id=0): ${baseKey.slice(0, 8)}...`);
		    } else {
			      krDebug(`No valid base key found for ${baseKeyName}`);
		    }
		    // Check for numbered keys (e.g., PI_GWDG_API_KEY_1, PI_GWDG_API_KEY_2, ...)
		    let id = 1;
		    while (true) {
			      const keyName = `${baseKeyName}_${id}`;
			      const keyValue = process.env[keyName];
			      if (!this.isValidKey(keyValue)) {
				        break;
			      }
			      keysWithSources.push({
				        status: {
					          key: keyValue,
					          id,
					          originalId: id,
					          resetTimestamp: null,
					          isExhausted: false,
					          lastError: null,
					          sourceEnvVar: keyName,
				        },
				        source: keyName,
			      });
			      krDebug(`Found numbered key ${keyName} (id=${id}): ${keyValue.slice(0, 8)}...`);
			      id++;
		    }

		    krDebug(`Total keys discovered: ${keysWithSources.length}`);
		    return keysWithSources;
	  }

	  /**
	   * Deduplicate keys by keeping the lowest ID for each unique key value
	   * Returns deduplicated keys and information about removed duplicates
	   */
	  private deduplicateKeys(
		    keysWithSources: Array<{status: KeyStatus, source: string}>
	  ): { deduplicatedKeys: KeyStatus[]; duplicatesRemoved: DuplicateKeyInfo[]; idMappings: IdMappingInfo[] } {
		    // Build map: keyValue → { lowestId, lowestSource, allEntries }
		    const keyMap = new Map<string, {
			      lowestId: number;
			      lowestSource: string;
			      allEntries: Array<{status: KeyStatus; source: string}>;
		    }>();

		    // Populate map
		    for (const entry of keysWithSources) {
			      const existing = keyMap.get(entry.status.key);
			      if (!existing) {
				        keyMap.set(entry.status.key, {
					          lowestId: entry.status.id,
					          lowestSource: entry.source,
					          allEntries: [entry],
				        });
			      } else {
				        // Update lowest ID if this entry has a lower ID
				        if (entry.status.id < existing.lowestId) {
					          existing.lowestId = entry.status.id;
					          existing.lowestSource = entry.source;
				        }
				        existing.allEntries.push(entry);
			      }
		    }

		    // Extract deduplicated keys and removed duplicates info
		    const deduplicatedKeys: KeyStatus[] = [];
		    const duplicatesRemoved: DuplicateKeyInfo[] = [];
		    for (const [keyValue, data] of Array.from(keyMap.entries())) {
			      // Find the entry with lowest ID
			      const keptEntry = data.allEntries.find(e => e.status.id === data.lowestId)!;
			      deduplicatedKeys.push(keptEntry.status);
			      for (const entry of data.allEntries) {
				        if (entry.status.id !== data.lowestId) {
					          duplicatesRemoved.push({
						            removedId: entry.status.id,
						            removedSource: entry.source,
						            keptId: data.lowestId,
						            keptSource: data.lowestSource,
					          });
				        }
			      }
		    }

		    // Sort by ID for consistent ordering
		    deduplicatedKeys.sort((a, b) => a.id - b.id);

		    // Remap keys to sequential IDs
		    const { remappedKeys, idMappings } = this.remapKeysSequentially(deduplicatedKeys);

		    return { deduplicatedKeys: remappedKeys, duplicatesRemoved, idMappings };
	  }

	  /**
	   * Remap keys to sequential IDs starting from 0
	   * Preserves original ID in originalId field for traceability
	   */
	  private remapKeysSequentially(keys: KeyStatus[]): {
	    remappedKeys: KeyStatus[];
	    idMappings: IdMappingInfo[];
	  } {
	    // Sort by original ID to preserve order
	    const sortedKeys = [...keys].sort((a, b) => a.id - b.id);
	    const idMappings: IdMappingInfo[] = [];

	    const remappedKeys = sortedKeys.map((key, index) => {
	      const newId = index;
	      idMappings.push({
	        newId,
	        originalId: key.id,
	        sourceEnvVar: key.sourceEnvVar,
	      });

	      return {
	        ...key,
	        id: newId,
	        originalId: key.id, // Preserve original ID for traceability
	      };
	    });

	    return { remappedKeys, idMappings };
	  }

	  /**
	   * Check if a key is currently available
	   */
	  private isKeyAvailable(keyId: number): boolean {
		    const key = this.keys.find((k) => k.id === keyId);
		    if (!key) {
			      krDebug(`isKeyAvailable: Key ${keyId} not found`);
			      return false;
		    }
		    if (key.isExhausted) {
			      krDebug(`isKeyAvailable: Key ${keyId} is exhausted (${key.lastError})`);
			      return false;
		    }
		    if (key.resetTimestamp === null) {
			      krDebug(`isKeyAvailable: Key ${keyId} is available`);
			      return true;
		    }

		    const nowSeconds = Math.floor(Date.now() / 1000);
		    const available = nowSeconds >= key.resetTimestamp;
		    if (available) {
			      krDebug(`isKeyAvailable: Key ${keyId} is now available (reset time passed)`);
		    } else {
			      const waitTime = key.resetTimestamp - nowSeconds;
			      krDebug(`isKeyAvailable: Key ${keyId} is rate limited (resets in ${waitTime}s)`);
		    }
		    return available;
	  }

	  /**
	   * Get the best available key (lowest ID that's not rate limited)
	   */
	  getBestAvailableKey(): KeyStatus | null {
		    krDebug("getBestAvailableKey: Looking for best available key");
		    // Sort by ID to prefer lower-ID keys
		    const sortedKeys = [...this.keys].sort((a, b) => a.id - b.id);

		    for (const key of sortedKeys) {
			      if (this.isKeyAvailable(key.id)) {
				        krDebug(`getBestAvailableKey: Selected key ${key.id} (${key.key.slice(0, 8)}...)`);
				        return key;
			      }
		    }

		    krDebug("getBestAvailableKey: No available keys found");
		    return null;
	  }

	  /**
	   * Get the earliest reset time among all rate-limited keys
	   */
	  getEarliestResetTime(): number | null {
		    let earliest: number | null = null;
		    let earliestKeyId: number | null = null;

		    for (const key of this.keys) {
			      if (key.resetTimestamp !== null && !key.isExhausted) {
				        if (earliest === null || key.resetTimestamp < earliest) {
					          earliest = key.resetTimestamp;
					          earliestKeyId = key.id;
				        }
			      }
		    }

		    if (earliest !== null && earliestKeyId !== null) {
			      const nowSeconds = Math.floor(Date.now() / 1000);
			      const waitTime = earliest - nowSeconds;
			      krDebug(`getEarliestResetTime: Key ${earliestKeyId} resets earliest in ${waitTime}s`);
		    } else {
			      krDebug("getEarliestResetTime: No rate-limited keys found");
		    }

		    return earliest;
	  }

	  /**
	   * Mark key as rate limited with reset time
	   */
	  markRateLimited(keyId: number, resetSeconds: number): void {
		    const key = this.keys.find((k) => k.id === keyId);
		    if (!key) {
			      krDebug(`markRateLimited: Key ${keyId} not found`);
			      return;
		    }

		    // Validate resetSeconds
		    const MIN_RESET_SECONDS = 1;
		    const MAX_RESET_SECONDS = 86400; // 24 hours
		    let validatedResetSeconds = resetSeconds;
		    if (isNaN(resetSeconds) || resetSeconds < MIN_RESET_SECONDS) {
			      validatedResetSeconds = MIN_RESET_SECONDS;
			      krDebug(`markRateLimited: Invalid reset time ${resetSeconds}s, using minimum ${MIN_RESET_SECONDS}s`);
		    } else if (resetSeconds > MAX_RESET_SECONDS) {
			      validatedResetSeconds = MAX_RESET_SECONDS;
			      krDebug(`markRateLimited: Reset time ${resetSeconds}s too large, using maximum ${MAX_RESET_SECONDS}s`);
		    }

		    const nowSeconds = Math.floor(Date.now() / 1000);
		    key.resetTimestamp = nowSeconds + validatedResetSeconds;
		    key.lastError = `Rate limited, reset in ${validatedResetSeconds}s`;

		    const resetTime = new Date(key.resetTimestamp * 1000).toLocaleTimeString();
		    krDebug(`markRateLimited: Key ${keyId} marked as rate limited, resets at ${resetTime} (${validatedResetSeconds}s from now)`);
	  }

	  /**
	   * Mark key as permanently exhausted (auth errors)
	   */
	  markExhausted(keyId: number, errorMessage?: string): void {
		    const key = this.keys.find((k) => k.id === keyId);
		    if (!key) {
			      krDebug(`markExhausted: Key ${keyId} not found`);
			      return;
		    }

		    key.isExhausted = true;
		    key.lastError = errorMessage || "Exhausted";

		    krDebug(`markExhausted: Key ${keyId} marked as permanently exhausted: ${key.lastError}`);
	  }

	  /**
	   * Check if we should rotate on this error code
	   */
	  shouldRotateOnError(statusCode: number): boolean {
		    const shouldRotate = this.config.errorCodes.includes(statusCode);
		    krDebug(`shouldRotateOnError: Status ${statusCode} -> ${shouldRotate ? "ROTATE" : "NO ROTATE"} (configured codes: ${this.config.errorCodes.join(", ")})`);
		    return shouldRotate;
	  }

	  /**
	   * Update key status based on response
	   * Returns true if the key was marked as unavailable (exhausted or rate limited)
	   */
	  updateKeyStatus(keyId: number, response: Response): boolean {
		    const statusCode = response.status;

		    krDebug(`updateKeyStatus: Checking key ${keyId} with status code ${statusCode}`);

		    // Auth errors (401/403) are always tracked regardless of rotation config
		    // These represent permanent key failures, not rate limiting
		    if (statusCode === 401 || statusCode === 403) {
			      // Authentication errors - mark as exhausted
			      krDebug(`updateKeyStatus: Authentication error (${statusCode}), marking key ${keyId} as exhausted`);
			      this.markExhausted(keyId, `Auth error ${statusCode}`);
			      return true;
		    }

		    // Rate limiting and other errors only tracked if in configured rotation codes
		    if (!this.shouldRotateOnError(statusCode)) {
			      krDebug(`updateKeyStatus: Status ${statusCode} not in rotation codes, no tracking needed`);
			      return false;
		    }

		    if (statusCode === 429) {
			      // Rate limit - extract reset time and mark as rate limited
			      const resetHeader =
				        response.headers.get("ratelimit-reset") || response.headers.get("x-ratelimit-reset");
			      const resetSeconds = resetHeader ? parseInt(resetHeader, 10) : 60; // Default 60s if not provided

			      krDebug(`updateKeyStatus: Rate limit detected for key ${keyId}, reset header: ${resetHeader}, parsed: ${resetSeconds}s`);

			      // Validate resetSeconds is a reasonable positive number (1 second to 24 hours)
			      const MIN_RESET_SECONDS = 1;
			      const MAX_RESET_SECONDS = 86400; // 24 hours
			      if (!isNaN(resetSeconds) && resetSeconds >= MIN_RESET_SECONDS && resetSeconds <= MAX_RESET_SECONDS) {
				        this.markRateLimited(keyId, resetSeconds);
			      } else if (isNaN(resetSeconds)) {
				        krDebug(`updateKeyStatus: Failed to parse reset header, using default 60s`);
				        this.markRateLimited(keyId, 60);
			      } else if (resetSeconds < MIN_RESET_SECONDS) {
				        krDebug(`updateKeyStatus: Reset time ${resetSeconds}s too small, using minimum ${MIN_RESET_SECONDS}s`);
				        this.markRateLimited(keyId, MIN_RESET_SECONDS);
			      } else {
				        krDebug(`updateKeyStatus: Reset time ${resetSeconds}s too large, using maximum ${MAX_RESET_SECONDS}s`);
				        this.markRateLimited(keyId, MAX_RESET_SECONDS);
			      }
			      return true;
		    }

		    krDebug(`updateKeyStatus: Status ${statusCode} handled but no tracking needed`);
		    return false;
	  }

	  /**
	   * Get next key in rotation (for roundrobin strategy)
	   */
	  getNextInRotation(): KeyStatus | null {
		    krDebug(`getNextInRotation: Current index: ${this.currentIndex}, strategy: roundrobin`);

		    if (this.keys.length === 0) {
			      krDebug("getNextInRotation: No keys available");
			      return null;
		    }

		    // Determine how many keys to try: use maxAttempts if set (>0), otherwise try all keys
		    const attempts = this.config.maxAttempts > 0
			      ? Math.min(this.config.maxAttempts, this.keys.length)
			      : this.keys.length;

		    krDebug(`getNextInRotation: Will try up to ${attempts} keys (maxAttempts: ${this.config.maxAttempts})`);

		    for (let i = 0; i < attempts; i++) {
			      const key = this.keys[this.currentIndex];
			      const previousIndex = this.currentIndex;
			      this.currentIndex = (this.currentIndex + 1) % this.keys.length;

			      krDebug(`getNextInRotation: Attempt ${i + 1}/${attempts}: Checking key ${key.id} (index ${previousIndex})`);

			      if (this.isKeyAvailable(key.id)) {
				        krDebug(`getNextInRotation: Selected key ${key.id} (${key.key.slice(0, 8)}...), next index: ${this.currentIndex}`);
				        return key;
			      }

			      krDebug(`getNextInRotation: Key ${key.id} not available, trying next`);
		    }

		    krDebug("getNextInRotation: No available keys found after all attempts");
		    return null;
	  }

	  /**
	   * Get random available key (for random strategy)
	   */
	  getRandomAvailableKey(): KeyStatus | null {
		    krDebug("getRandomAvailableKey: Strategy: random");

		    const availableKeys = this.keys.filter((k) => this.isKeyAvailable(k.id));

		    if (availableKeys.length === 0) {
			      krDebug("getRandomAvailableKey: No available keys found");
			      return null;
		    }

		    const randomIndex = Math.floor(Math.random() * availableKeys.length);
		    const selected = availableKeys[randomIndex];

		    krDebug(`getRandomAvailableKey: Selected key ${selected.id} (${selected.key.slice(0, 8)}...) from ${availableKeys.length} available keys`);
		    return selected;
	  }

	  /**
	   * Get key based on rotation strategy
	   */
	  getKeyByStrategy(): KeyStatus | null {
		    krDebug(`getKeyByStrategy: Using strategy "${this.config.strategy}"`);

		    let result: KeyStatus | null;

		    switch (this.config.strategy) {
			      case "roundrobin":
				        result = this.getNextInRotation();
				        break;
			      case "random":
				        result = this.getRandomAvailableKey();
				        break;
			      case "fallback":
			      default:
				        result = this.getBestAvailableKey();
				        break;
		    }

		    if (result) {
			      krDebug(`getKeyByStrategy: Returned key ${result.id} (${result.key.slice(0, 8)}...)`);
		    } else {
			      krDebug("getKeyByStrategy: No key returned");
		    }

		    return result;
	  }

	  /**
	   * Reset all exhausted keys (for manual retry)
	   */
	  resetAllKeys(): void {
		    krDebug("resetAllKeys: Resetting all keys");

		    for (const key of this.keys) {
			      const wasExhausted = key.isExhausted;
			      const hadReset = key.resetTimestamp !== null;

			      key.isExhausted = false;
			      key.resetTimestamp = null;
			      key.lastError = null;

			      if (wasExhausted || hadReset) {
				        krDebug(`resetAllKeys: Key ${key.id} reset (was exhausted: ${wasExhausted}, had reset time: ${!!hadReset})`);
			      }
		    }

		    krDebug("resetAllKeys: All keys have been reset");
	  }

	  /**
	   * Get debug info about key states
	   */
	  getKeyStates(): KeyStatus[] {
		    const states = this.keys.map((k) => ({ ...k }));
		    krDebug("getKeyStates: Current key states:", states.map(k => ({
			      id: k.id,
			      key: k.key.slice(0, 8) + "...",
			      isExhausted: k.isExhausted,
			      resetTimestamp: k.resetTimestamp,
			      lastError: k.lastError,
		    })));
		    return states;
	  }

	  /**
	   * Get the number of keys
	   */
	  getKeyCount(): number {
		    const count = this.keys.length;
		    krDebug(`getKeyCount: Total keys: ${count}`);
		    return count;
	  }

	  /**
	   * Check if any keys are available
	   */
	  hasAvailableKeys(): boolean {
		    const availableKeys = this.keys.filter((k) => this.isKeyAvailable(k.id));
		    const hasAvailable = availableKeys.length > 0;

		    krDebug(`hasAvailableKeys: ${availableKeys.length}/${this.keys.length} keys available -> ${hasAvailable ? "YES" : "NO"}`);

		    if (hasAvailable) {
			      krDebug(`hasAvailableKeys: Available key IDs: ${availableKeys.map(k => k.id).join(", ")}`);
		    }

		    return hasAvailable;
	  }

	  /**
	   * Get statistics about key discovery and deduplication
	   */
	  getKeyDiscoveryStats(): KeyDiscoveryStats {
		    return { ...this.discoveryStats };
	  }

	  /**
	   * Get a formatted wait time message for all rate-limited keys
	   * Returns null if no keys are waiting for reset
	   */
	  getWaitTimeMessage(): string | null {
		    const earliestReset = this.getEarliestResetTime();
		    if (!earliestReset) {
			      return null;
		    }

		    const nowSeconds = Math.floor(Date.now() / 1000);
		    const waitSeconds = earliestReset - nowSeconds;

		    // Find which key has the earliest reset
		    const earliestKeyId = this.keys.find(k => k.resetTimestamp === earliestReset)?.id;

		    const resetTimeStr = new Date(earliestReset * 1000).toLocaleTimeString(
			      undefined,
			      { hour: "2-digit", minute: "2-digit", second: "2-digit" }
		    );

		    return `Next API key (ID ${earliestKeyId}) will be available in ${waitSeconds}s at ${resetTimeStr}`;
	  }

	  /**
	   * Track the last key that was selected for use
	   * Used to detect when switching back to a preferred key
	   */
	  private lastSelectedKeyId: number | null = null;

	  /**
	   * Get the best available key and detect if we're switching back to a preferred key
	   * Returns null if no keys are available
	   *
	   * This method is similar to getBestAvailableKey() but also tracks the transition
	   * and can detect when switching back to a lower-ID key (which just became available)
	   */
	  getBestAvailableKeyWithSwitchBack(): { key: KeyStatus; switchedBack: boolean; previousKeyId: number | null } | null {
		    const key = this.getBestAvailableKey();
		    if (!key) {
			      return null;
		    }

		    const previousKeyId = this.lastSelectedKeyId;
		    const switchedBack = previousKeyId !== null && key.id < previousKeyId;

		    // Update tracking
		    this.lastSelectedKeyId = key.id;

		    if (switchedBack) {
			      krDebug(`Switching back to preferred key ${key.id} (was using key ${previousKeyId})`);
		    }

		    return { key, switchedBack, previousKeyId };
	  }

	  /**
	   * Reset the last selected key tracking
	   * Call this when starting a new session or manually resetting keys
	   */
	  resetLastSelectedKey(): void {
		    krDebug("Resetting last selected key tracking");
		    this.lastSelectedKeyId = null;
	  }
}

/**
 * Factory function to create a KeyRotationManager with default config
 */
export function createKeyRotationManager(config?: Partial<KeyRotationConfig>): KeyRotationManager {
	  const baseKeyName = config?.baseKeyName || "PI_GWDG_API_KEY";
	  const strategy = config?.strategy || "fallback";
	  const errorCodes = config?.errorCodes || [429];
	  const maxAttempts = config?.maxAttempts ?? 0;
	  const warnOnDuplicates = config?.warnOnDuplicates;
	  krDebug("createKeyRotationManager: Creating manager with config:", {
		    baseKeyName,
		    strategy,
		    errorCodes,
		    maxAttempts,
		    warnOnDuplicates,
	  });
	  return new KeyRotationManager({
		    baseKeyName,
		    strategy,
		    errorCodes,
		    maxAttempts,
		    ...(warnOnDuplicates !== undefined && { warnOnDuplicates }),
	  });
}
