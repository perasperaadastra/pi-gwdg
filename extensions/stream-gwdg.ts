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
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, getEnvApiKey, parseStreamingJson } from "@mariozechner/pi-ai";
import { calculateCost } from "@mariozechner/pi-ai";

const GWDG_DEBUG = process.env.GWDG_DEBUG === "1";

function debug(...args: unknown[]): void {
	if (GWDG_DEBUG) {
		console.log("[GWDG STREAM DEBUG]", ...args);
	}
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
	});

	debug("emitRateLimits: event emitted successfully");
}

/**
 * Build the request body for OpenAI-compatible chat completions
 */
function buildRequestBody(
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): Record<string, unknown> {
	const messages: Record<string, unknown>[] = [];

	// Add system prompt
	if (context.systemPrompt) {
		messages.push({
			role: "system",
			content: context.systemPrompt,
		});
	}

	// Transform messages to OpenAI format
	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: msg.content });
			} else {
				const content = msg.content.map((item) => {
					if (item.type === "text") {
						return { type: "text", text: item.text };
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
				assistantMsg.content = textContent.map((c) => (c as TextContent).text).join("");
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
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content:
					msg.content
						?.map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
						.join("\n") || "",
			});
		}
	}

	// Build request params
	const params: Record<string, unknown> = {
		model: model.id,
		messages,
		stream: true,
		stream_options: { include_usage: true },
	};

	if (options?.maxTokens) {
		params.max_tokens = options.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	// Add tools if present
	if (context.tools && context.tools.length > 0) {
		params.tools = context.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
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
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return function streamSimpleGwdg(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
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

			try {
				const apiKey = options?.apiKey || getEnvApiKey(model.provider);

				debug("streamSimpleGwdg: model:", model.id, "baseUrl:", model.baseUrl);
				debug("streamSimpleGwdg: piEventEmitter:", piEventEmitter ? "defined" : "undefined");

				// Build headers
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				};

				if (apiKey) {
					headers["Authorization"] = `Bearer ${apiKey}`;
				}

				// Add custom headers from options
				if (options?.headers) {
					Object.assign(headers, options.headers);
				}

				// Build request body
				const body = buildRequestBody(model as Model<"openai-completions">, context, options);

				debug("Making request to", model.baseUrl, "with model", model.id);

				// Make the request
				const response = await fetch(`${model.baseUrl}/chat/completions`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: options?.signal,
				});

				// CRITICAL: Capture headers immediately after response
				debug("Response status:", response.status);

				if (!response.ok) {
					const errorText = await response.text();
					debug("Error response:", response.status, errorText);

					// Try to extract rate limit info even on error
					emitRateLimits(response, piEventEmitter, model.baseUrl);

					// Check if rate limited
					if (response.status === 429) {
						output.stopReason = "error";
						output.errorMessage = `Rate limited (429): ${errorText}`;
						stream.push({ type: "error", reason: "error", error: output });
						stream.end();
						return;
					}

					output.stopReason = "error";
					output.errorMessage = `API error (${response.status}): ${errorText}`;
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
					return;
				}

				// Capture rate limit headers on success
				emitRateLimits(response, piEventEmitter, model.baseUrl);

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
					if (delta.reasoning !== undefined && delta.reasoning !== "") {
						if (!currentBlock || currentBlock.type !== "thinking") {
							finishCurrentBlock(currentBlock);
							currentBlock = {
								type: "thinking",
								thinking: "",
							};
							output.content.push(currentBlock);
							stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
						}

						if (currentBlock.type === "thinking") {
							currentBlock.thinking += delta.reasoning;
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: delta.reasoning,
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
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	};
}
