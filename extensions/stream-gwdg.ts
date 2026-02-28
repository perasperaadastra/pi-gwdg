/**
 * GWDG Custom Streaming Implementation
 *
 * This file implements custom streaming for the GWDG provider using raw fetch()
 * to access response headers directly for rate limit tracking.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	OpenAICompletionsCompat,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, getEnvApiKey, parseStreamingJson } from "@mariozechner/pi-ai";
import { calculateCost } from "@mariozechner/pi-ai";
import { KeyRotationManager } from "./key-rotation.js";

const PI_GWDG_DEBUG = process.env.PI_GWDG_DEBUG === "1";
const FALLBACK_THRESHOLD_SECONDS = 3600;

function debug(...args: unknown[]): void {
	if (PI_GWDG_DEBUG) {
		console.log("[GWDG STREAM DEBUG]", ...args);
	}
}

const rateLimitResetTimes = new Map<string, { resetTimestamp: number }>();

/**
 * Removes unpaired Unicode surrogate characters from a string.
 * Unpaired surrogates cause JSON serialization errors in many API providers.
 */
function sanitizeSurrogates(text: string): string {
	// Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
	// Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Extended stream options for GWDG with toolChoice support
 */
export interface GwdgStreamOptions extends SimpleStreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
}

/**
 * GWDG compatibility defaults.
 * GWDG is OpenAI-compatible, so most features work out of the box.
 */
const GWDG_DEFAULT_COMPAT: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	supportsStrictMode: true,
};

/**
 * Get compatibility settings for GWDG.
 * Uses model.compat if provided, otherwise GWDG defaults.
 */
function getGwdgCompat(model: Model<"openai-completions">): Required<OpenAICompletionsCompat> {
	if (!model.compat) return GWDG_DEFAULT_COMPAT;

	return {
		supportsStore: model.compat.supportsStore ?? GWDG_DEFAULT_COMPAT.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? GWDG_DEFAULT_COMPAT.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? GWDG_DEFAULT_COMPAT.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? GWDG_DEFAULT_COMPAT.supportsUsageInStreaming,
		maxTokensField: model.compat.maxTokensField ?? GWDG_DEFAULT_COMPAT.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? GWDG_DEFAULT_COMPAT.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? GWDG_DEFAULT_COMPAT.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? GWDG_DEFAULT_COMPAT.requiresThinkingAsText,
		requiresMistralToolIds: model.compat.requiresMistralToolIds ?? GWDG_DEFAULT_COMPAT.requiresMistralToolIds,
		thinkingFormat: model.compat.thinkingFormat ?? GWDG_DEFAULT_COMPAT.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? GWDG_DEFAULT_COMPAT.openRouterRouting,
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? GWDG_DEFAULT_COMPAT.vercelGatewayRouting,
		supportsStrictMode: model.compat.supportsStrictMode ?? GWDG_DEFAULT_COMPAT.supportsStrictMode,
	};
}

/**
 * SSE Parsing - Parse Server-Sent Events from response body
 */
async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const chunk = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);

			const dataLines = chunk
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim());
			if (dataLines.length > 0) {
				const data = dataLines.join("\n").trim();
				if (data && data !== "[DONE]") {
					try {
						yield JSON.parse(data);
					} catch {
						debug("Failed to parse SSE chunk:", data);
					}
				}
			}
			idx = buffer.indexOf("\n\n");
		}
	}
}

/**
 * Rate limit window data structure
 */
interface RateLimitWindow {
	used: number;
	limit: number;
	remaining: number;
}

/**
 * Complete rate limits data from GWDG response
 */
export interface GwdgRateLimits {
	minute?: RateLimitWindow;
	hour?: RateLimitWindow;
	day?: RateLimitWindow;
	month?: RateLimitWindow;
}

/**
 * Extract rate limit data from response headers for usage tracking.
 */
export function extractRateLimits(headers: Headers): GwdgRateLimits | null {
	const getHeader = (name: string): number | undefined => {
		const value = headers.get(name);
		if (!value) return undefined;
		const parsed = parseInt(value, 10);
		return isNaN(parsed) ? undefined : parsed;
	};

	debug("extractRateLimits: checking headers...");
	debug("All x-ratelimit headers:", {
		"x-ratelimit-limit-minute": headers.get("x-ratelimit-limit-minute"),
		"x-ratelimit-remaining-minute": headers.get("x-ratelimit-remaining-minute"),
		"x-ratelimit-limit-hour": headers.get("x-ratelimit-limit-hour"),
		"x-ratelimit-remaining-hour": headers.get("x-ratelimit-remaining-hour"),
		"x-ratelimit-limit-day": headers.get("x-ratelimit-limit-day"),
		"x-ratelimit-remaining-day": headers.get("x-ratelimit-remaining-day"),
		"x-ratelimit-limit-month": headers.get("x-ratelimit-limit-month"),
		"x-ratelimit-remaining-month": headers.get("x-ratelimit-remaining-month"),
		"ratelimit-limit": headers.get("ratelimit-limit"),
		"ratelimit-remaining": headers.get("ratelimit-remaining"),
		"ratelimit-reset": headers.get("ratelimit-reset"),
	});

	const limits: GwdgRateLimits = {};

	// Minute window
	const minuteLimit = getHeader("x-ratelimit-limit-minute");
	const minuteRemaining = getHeader("x-ratelimit-remaining-minute");
	if (minuteLimit !== undefined && minuteRemaining !== undefined) {
		limits.minute = {
			used: minuteLimit - minuteRemaining,
			limit: minuteLimit,
			remaining: minuteRemaining,
		};
	}

	// Hour window
	const hourLimit = getHeader("x-ratelimit-limit-hour");
	const hourRemaining = getHeader("x-ratelimit-remaining-hour");
	if (hourLimit !== undefined && hourRemaining !== undefined) {
		limits.hour = {
			used: hourLimit - hourRemaining,
			limit: hourLimit,
			remaining: hourRemaining,
		};
	}

	// Day window
	const dayLimit = getHeader("x-ratelimit-limit-day");
	const dayRemaining = getHeader("x-ratelimit-remaining-day");
	if (dayLimit !== undefined && dayRemaining !== undefined) {
		limits.day = {
			used: dayLimit - dayRemaining,
			limit: dayLimit,
			remaining: dayRemaining,
		};
	}

	// Month window
	const monthLimit = getHeader("x-ratelimit-limit-month");
	const monthRemaining = getHeader("x-ratelimit-remaining-month");
	if (monthLimit !== undefined && monthRemaining !== undefined) {
		limits.month = {
			used: monthLimit - monthRemaining,
			limit: monthLimit,
			remaining: monthRemaining,
		};
	}

	// Only return if we have at least one valid window
	const result = Object.keys(limits).length > 0 ? limits : null;
	debug("extractRateLimits: result:", result);
	return result;
}

function emitRateLimits(
	response: Response,
	piEventEmitter: { emit: (event: string, data: unknown) => void } | undefined,
	endpoint: string,
	keyId?: number,
): void {
	debug("emitRateLimits: called with endpoint:", endpoint);
	const rateLimits = extractRateLimits(response.headers);
	debug("emitRateLimits: rateLimits:", rateLimits);
	debug("emitRateLimits: piEventEmitter:", piEventEmitter ? "defined" : "undefined");

	if (!rateLimits || !piEventEmitter) {
		debug("emitRateLimits: early return - no rate limits or no emitter");
		return;
	}

	const resetHeader =
		response.headers.get("ratelimit-reset") ||
		response.headers.get("x-ratelimit-reset");
	const resetSeconds = resetHeader ? parseInt(resetHeader, 10) : undefined;

	debug("Emitting rate limits:", rateLimits);

  debug(" resetSeconds", resetSeconds);

  const modResetSeconds = resetSeconds && !isNaN(resetSeconds) ? resetSeconds : undefined;

  debug("modResetSeconds", modResetSeconds);

	piEventEmitter.emit("gwdg:usage:update", {
		timestamp: Date.now(),
		rateLimits,
		resetSeconds: modResetSeconds,
		endpoint,
		keyId: keyId?.toString(),
	});

	debug("emitRateLimits: event emitted successfully");
}

/**
 * Build messages array for the request
 */
function buildMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: Required<OpenAICompletionsCompat>,
): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];

	// Add system prompt
	if (context.systemPrompt) {
		const role = compat.supportsDeveloperRole && model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	// Transform messages to OpenAI format
	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: sanitizeSurrogates(msg.content) });
			} else {
				const content = msg.content.map((item) => {
					if (item.type === "text") {
						return { type: "text", text: sanitizeSurrogates(item.text) };
					} else {
						return {
							type: "image_url",
							image_url: { url: `data:${item.mimeType};base64,${item.data}` },
						};
					}
				});
				messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: Record<string, unknown> = { role: "assistant" };
			const content: (TextContent | ThinkingContent | ToolCall)[] = msg.content;

			const textContent = content.filter((c) => c.type === "text");
			const toolCalls = content.filter((c) => c.type === "toolCall");

			if (textContent.length > 0) {
				assistantMsg.content = textContent.map((c) => sanitizeSurrogates((c as TextContent).text)).join("");
			}

			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc) => ({
					id: (tc as ToolCall).id,
					type: "function",
					function: {
						name: (tc as ToolCall).name,
						arguments: JSON.stringify((tc as ToolCall).arguments),
					},
				}));
			}

			messages.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const toolResultMsg: Record<string, unknown> = {
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: sanitizeSurrogates(
					msg.content
						?.map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
						.join("\n") || "",
				),
			};

			if (compat.requiresToolResultName && msg.toolName) {
				toolResultMsg.name = msg.toolName;
			}

			messages.push(toolResultMsg);
		}
	}

	return messages;
}

/**
 * Build the request body for OpenAI-compatible chat completions
 */
function buildRequestBody(
	model: Model<"openai-completions">,
	context: Context,
	options?: GwdgStreamOptions,
): Record<string, unknown> {
	const compat = getGwdgCompat(model);
	const messages = buildMessages(model, context, compat);

	const params: Record<string, unknown> = {
		model: model.id,
		messages,
		stream: true,
	};

	// Conditional stream_options (some providers may reject this)
	if (compat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	// Store parameter (opt-out of OpenAI's storage)
	if (compat.supportsStore) {
		params.store = false;
	}

	// Max tokens with field selection
	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			params.max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	// Tool choice support
	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	// Add tools if present
	if (context.tools && context.tools.length > 0) {
		params.tools = context.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				...(compat.supportsStrictMode !== false && { strict: false }),
			},
		}));
	}

	return params;
}

/**
 * Map OpenAI finish reason to our StopReason
 */
function mapStopReason(reason: string | null): StopReason {
	if (reason === null) return "stop";
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "tool_calls":
			return "toolUse";
		default:
			return "stop";
	}
}

/**
 * Create a GWDG custom stream function with header access
 */
export function createStreamSimpleGwdg(
	piEventEmitter?: { emit: (event: string, data: unknown) => void },
	fallbackBaseUrl?: string,
	keyRotationManager?: KeyRotationManager,
): (model: Model<Api>, context: Context, options?: GwdgStreamOptions) => AssistantMessageEventStream {
	return function streamSimpleGwdg(
		model: Model<Api>,
		context: Context,
		options?: GwdgStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();

		(async () => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api as Api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};

			// Track current key ID for rate limit updates
			let currentKeyId: number | undefined;

			try {
				debug("streamSimpleGwdg: model:", model.id, "baseUrl:", model.baseUrl);
				debug("streamSimpleGwdg: piEventEmitter:", piEventEmitter ? "defined" : "undefined");
				debug("streamSimpleGwdg: keyRotationManager:", keyRotationManager ? "defined" : "undefined");

				// Build request body (same for all attempts)
				const body = buildRequestBody(model as Model<"openai-completions">, context, options);

				/**
				 * Make a request with key rotation support
				 */
				const attemptRequest = async (): Promise<Response | null> => {
					// Get the best available key (with switch-back detection)
					const keySelection = keyRotationManager?.getBestAvailableKeyWithSwitchBack();
					const keyStatus = keySelection?.key;

					// Check if we switched back to a preferred (lower-ID) key
					if (keySelection && keySelection.switchedBack) {
						debug(`Switching back to preferred key ${keyStatus.id} (was using key ${keySelection.previousKeyId})`);
						if (piEventEmitter) {
							const message = `API key ${keyStatus.id} is available again, switching back from key ${keySelection.previousKeyId}`;
							// Note: sessionId is currently not included, so notification will broadcast to all active sessions
							// This is the intended behavior since key rotation affects all sessions
							piEventEmitter.emit("gwdg:key:switch-back", { message, type: "info" as const });
							debug("Emitted gwdg:key:switch-back event (broadcast to all sessions):", message);
						}
					}

					if (!keyStatus) {
						// All keys exhausted - check if we can wait for reset
						if (keyRotationManager) {
							const earliestReset = keyRotationManager.getEarliestResetTime();
							if (earliestReset) {
								const nowSeconds = Math.floor(Date.now() / 1000);
								const waitSeconds = earliestReset - nowSeconds;
								if (waitSeconds > 0 && waitSeconds <= 300) {
									// Only wait if it's reasonable (5 minutes or less)
									const resetTimeStr = new Date(earliestReset * 1000).toLocaleTimeString(
										undefined,
										{ hour: "2-digit", minute: "2-digit", second: "2-digit" },
									);
									output.errorMessage = `All API keys rate limited. Waiting ${waitSeconds}s until ${resetTimeStr}...`;
									stream.push({ type: "status", content: output.errorMessage, partial: output });
									debug("All keys rate limited, waiting:", waitSeconds, "seconds");
									await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
									return attemptRequest(); // Retry after wait
								}
							}
						}

						// Get key from options or environment as fallback
						const fallbackKey = options?.apiKey || getEnvApiKey(model.provider);
						if (!fallbackKey) {
							output.errorMessage = "All API keys are exhausted";
							stream.push({ type: "error", reason: "error", error: output });
							stream.end();
							return null;
						}

						// Try with fallback key (no rotation tracking)
						debug("Attempting request with fallback key (no rotation tracking)");
						console.warn(`[GWDG] All rotation keys exhausted, using fallback key (no rotation tracking)`);

						const headers: Record<string, string> = {
							"Content-Type": "application/json",
							Accept: "text/event-stream",
							Authorization: `Bearer ${fallbackKey}`,
						};

						if (options?.headers) {
							Object.assign(headers, options.headers);
						}

						return fetch(`${model.baseUrl}/chat/completions`, {
							method: "POST",
							headers,
							body: JSON.stringify(body),
							signal: options?.signal,
						});
					}

					// Track current key for rate limit updates
					currentKeyId = keyStatus.id;
					debug("Using key ID:", keyStatus.id);
					debug(`Starting request with key ${keyStatus.id} (${keyStatus.key.slice(0, 8)}...)`);


					// Build headers with this key
					const headers: Record<string, string> = {
						"Content-Type": "application/json",
						Accept: "text/event-stream",
					};
					headers["Authorization"] = `Bearer ${keyStatus.key}`;

					// Add custom headers from options
					if (options?.headers) {
						Object.assign(headers, options.headers);
					}

					// Determine which URL to use
					let currentBaseUrl = model.baseUrl;

					// Check if we have a stored rate limit reset time for the primary URL
					const cachedReset = rateLimitResetTimes.get(model.baseUrl);
					if (cachedReset && fallbackBaseUrl) {
						const nowSeconds = Math.floor(Date.now() / 1000);
						if (cachedReset.resetTimestamp > nowSeconds) {
							const waitSeconds = cachedReset.resetTimestamp - nowSeconds;
							if (waitSeconds > FALLBACK_THRESHOLD_SECONDS) {
								// Primary endpoint has long rate limit, try fallback
								debug(`Primary endpoint rate limited for ${waitSeconds}s, trying fallback`);
								stream.push({
									type: "status",
									content: `Primary endpoint rate limited, trying fallback...`,
									partial: output,
								});
								currentBaseUrl = fallbackBaseUrl;
							}
						}
					}

					// Make request
					const response = await fetch(`${currentBaseUrl}/chat/completions`, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: options?.signal,
					});

					// Check if we should rotate keys
					if (keyRotationManager && keyRotationManager.shouldRotateOnError(response.status)) {
						const rotated = keyRotationManager.updateKeyStatus(keyStatus.id, response);
						if (rotated) {
							const nextKey = keyRotationManager.getBestAvailableKey();
							if (nextKey) {
								debug(`Key ${keyStatus.id} rate limited, switching to key ${nextKey.id}`);
								debug(`Rotating from key ${keyStatus.id} to key ${nextKey.id}`);

								// Emit rotation notification
								if (piEventEmitter) {
									const message = `Rate limited: switching from API key ${keyStatus.id} to key ${nextKey.id}`;
									piEventEmitter.emit("gwdg:key:rotate", { message, type: "warning" as const });
									debug("Emitted gwdg:key:rotate event:", message);
								}

								stream.push({
									type: "status",
									content: `API key rate limited, switching to alternative key...`,
									partial: output,
								});
								return attemptRequest(); // Retry with next key
							}
						}
					}

					return response;
				};

				const response = await attemptRequest();
				if (!response) return; // Error already handled

				// Get the base URL that was used (might be fallback)
				const currentBaseUrl = response.url.replace('/chat/completions', '');

				if (!response.ok) {
					const errorText = await response.text();
					debug("Error response:", response.status, errorText);

					emitRateLimits(response, piEventEmitter, currentBaseUrl, currentKeyId);

					// Update rotation manager on error
					if (keyRotationManager && currentKeyId !== undefined) {
						keyRotationManager.updateKeyStatus(currentKeyId, response);
					}

					output.stopReason = "error";
					output.errorMessage = `API error (${response.status}): ${errorText}`;
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
					return;
				}

				// Capture rate limit headers on success
				emitRateLimits(response, piEventEmitter, currentBaseUrl, currentKeyId);

				// Send start event
				stream.push({ type: "start", partial: output });

				let currentBlock: TextContent | ThinkingContent | (ToolCall & { partialArgs?: string }) | null = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;
				const finishCurrentBlock = (block?: typeof currentBlock) => {
					if (block) {
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: blockIndex(),
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: blockIndex(),
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialArgs);
							delete block.partialArgs;
							stream.push({
								type: "toolcall_end",
								contentIndex: blockIndex(),
								toolCall: block,
								partial: output,
							});
						}
					}
				};

				// Process SSE stream
				for await (const chunk of parseSSE(response)) {
					const choice = (chunk as any).choices?.[0];
					if (!choice) {
						// Check for usage in chunk (stream_options: include_usage)
						const usage = (chunk as any).usage;
						if (usage) {
							const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
							const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;
							const input = (usage.prompt_tokens || 0) - cachedTokens;
							const outputTokens = (usage.completion_tokens || 0) + reasoningTokens;
							output.usage = {
								input,
								output: outputTokens,
								cacheRead: cachedTokens,
								cacheWrite: 0,
								totalTokens: input + outputTokens + cachedTokens,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							};
							calculateCost(model as Model<"openai-completions">, output.usage);
						}
						continue;
					}

					const delta = choice.delta;

					if (!delta) {
						// Check for finish_reason
						if (choice.finish_reason) {
							output.stopReason = mapStopReason(choice.finish_reason);
						}
						continue;
					}

					// Handle content delta
					if (delta.content !== undefined && delta.content !== "") {
						if (!currentBlock || currentBlock.type !== "text") {
							finishCurrentBlock(currentBlock);
							currentBlock = { type: "text", text: "" };
							output.content.push(currentBlock);
							stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
						}

						if (currentBlock.type === "text") {
							currentBlock.text += delta.content;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta: delta.content,
								partial: output,
							});
						}
					}

				// Handle reasoning (thinking)
				// Some endpoints return reasoning in reasoning_content (llama.cpp),
				// or reasoning (other openai compatible endpoints)
				// Use the first non-empty reasoning field to avoid duplication
				// (some return both reasoning_content and reasoning with same content)
				const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
				let foundReasoningField: string | null = null;
				for (const field of reasoningFields) {
					if (
						(delta as any)[field] !== null &&
						(delta as any)[field] !== undefined &&
						(delta as any)[field].length > 0
					) {
						if (!foundReasoningField) {
							foundReasoningField = field;
							break;
						}
					}
				}

				if (foundReasoningField) {
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishCurrentBlock(currentBlock);
						currentBlock = {
							type: "thinking",
							thinking: "",
							thinkingSignature: foundReasoningField,
						};
						output.content.push(currentBlock);
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					}

					if (currentBlock.type === "thinking") {
						const reasoningDelta = (delta as any)[foundReasoningField];
						currentBlock.thinking += reasoningDelta;
						stream.push({
							type: "thinking_delta",
							contentIndex: blockIndex(),
							delta: reasoningDelta,
							partial: output,
						});
					}
				}

					// Handle tool calls
					if (delta.tool_calls && delta.tool_calls.length > 0) {
						for (const tc of delta.tool_calls) {
							if (
								!currentBlock ||
								currentBlock.type !== "toolCall" ||
								(tc.id && currentBlock.id !== tc.id)
							) {
								finishCurrentBlock(currentBlock);
								currentBlock = {
									type: "toolCall",
									id: tc.id || "",
									name: tc.function?.name || "",
									arguments: {},
									partialArgs: "",
								};
								output.content.push(currentBlock);
								stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							}

							if (currentBlock.type === "toolCall") {
								if (tc.id) currentBlock.id = tc.id;
								if (tc.function?.name) currentBlock.name = tc.function.name;
								let delta = "";
								if (tc.function?.arguments) {
									delta = tc.function.arguments;
									currentBlock.partialArgs += tc.function.arguments;
									currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
								}
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta,
									partial: output,
								});
							}
						}
					}

					// Check for finish
					if (choice.finish_reason) {
						output.stopReason = mapStopReason(choice.finish_reason);
						finishCurrentBlock(currentBlock);
						currentBlock = null;
					}
				}

				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} catch (error) {
				debug("Stream error:", error);

				// Clean up block indices (pi-mono feature)
				for (const block of output.content) delete (block as any).index;

				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);

				// Extract additional metadata from provider errors (OpenRouter, etc.)
				const rawMetadata = (error as any)?.error?.metadata?.raw;
				if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;

				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	};
}
