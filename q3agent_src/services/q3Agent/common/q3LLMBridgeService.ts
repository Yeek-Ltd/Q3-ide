/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQ3LLMBridgeService, IQ3ChatMessage, IQ3ToolDefinition, IQ3ToolCall, IQ3LLMResponse, IQ3FIMRequest, IQ3TokenUsage } from './q3Agent.js';

export class Q3LLMBridgeService extends Disposable implements IQ3LLMBridgeService {
	declare readonly _serviceBrand: undefined;

	private _abortController: AbortController | undefined;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();
	}

	private getEndpoint(): string {
		const port = this._configService.getValue<number>('q3.agent.llamacpp.port') || 8080;
		return `http://127.0.0.1:${port}`;
	}

	cancel(): void {
		if (this._abortController) {
			this._abortController.abort();
			this._abortController = undefined;
		}
	}

	async chat(model: string, messages: IQ3ChatMessage[], tools?: IQ3ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): Promise<IQ3LLMResponse> {
		return this._chatOpenAI(model, messages, tools, options);
	}

	private async _chatOpenAI(model: string, messages: IQ3ChatMessage[], tools?: IQ3ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): Promise<IQ3LLMResponse> {
		const body: any = {
			model,
			messages: messages.map(m => {
				const msg: any = { role: m.role, content: m.content };
				if (m.toolCalls && m.toolCalls.length > 0) {
					msg.tool_calls = m.toolCalls.map(tc => ({
						id: tc.id,
						type: 'function',
						function: { name: tc.function.name, arguments: this._validateToolCallArgs(tc.function.arguments) },
					}));
				}
				if (m.toolCallId) { msg.tool_call_id = m.toolCallId; }
				if (m.toolName) { msg.name = m.toolName; }
				return msg;
			}),
			stream: false,
			temperature: options?.temperature ?? 0.7,
			max_tokens: options?.maxTokens ?? 4096,
		};
		if (tools && tools.length > 0) {
			body.tools = tools;
		}

		const respText = await this._requestWithRetry(`${this.getEndpoint()}/v1/chat/completions`, JSON.stringify(body));
		const data = JSON.parse(respText) as any;
		const choice = data.choices?.[0];
		const msg = choice?.message || {};
		let content = msg.content || '';
		let toolCalls: IQ3ToolCall[] = (msg.tool_calls || []).map((tc: any) => ({
			id: tc.id || `call_${Date.now()}`,
			type: 'function' as const,
			function: {
				name: tc.function?.name || '',
				arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
			},
		}));

		let textParsedToolCalls = false;
		if (toolCalls.length === 0 && content) {
			const parsed = this._parseTextToolCalls(content);
			if (parsed.toolCalls.length > 0) {
				toolCalls = parsed.toolCalls;
				content = parsed.remainingText;
				textParsedToolCalls = true;
			}
		}

		return {
			content,
			toolCalls,
			usage: this._parseOpenAIUsage(data.usage),
			textParsedToolCalls,
		};
	}

	async chatStream(model: string, messages: IQ3ChatMessage[], tools: IQ3ToolDefinition[], options: { temperature: number; maxTokens: number }, onToken: (token: string) => void): Promise<IQ3LLMResponse> {
		return this._chatStreamOpenAI(model, messages, tools, options, onToken);
	}

	private async _chatStreamOpenAI(model: string, messages: IQ3ChatMessage[], tools: IQ3ToolDefinition[], options: { temperature: number; maxTokens: number }, onToken: (token: string) => void): Promise<IQ3LLMResponse> {
		this._abortController = new AbortController();

		const body: any = {
			model,
			messages: messages.map(m => {
				const msg: any = { role: m.role, content: m.content };
				if (m.toolCalls && m.toolCalls.length > 0) {
					msg.tool_calls = m.toolCalls.map(tc => ({
						id: tc.id,
						type: 'function',
						function: { name: tc.function.name, arguments: this._validateToolCallArgs(tc.function.arguments) },
					}));
				}
				if (m.toolCallId) { msg.tool_call_id = m.toolCallId; }
				if (m.toolName) { msg.name = m.toolName; }
				return msg;
			}),
			stream: true,
			temperature: options.temperature,
			max_tokens: options.maxTokens,
			tools,
		};

		const url = `${this.getEndpoint()}/v1/chat/completions`;
		const res = await this._fetchWithRetry(url, JSON.stringify(body), this._abortController.signal);

		if (!res.ok) {
			const errText = await res.text();
			throw new Error(`llama.cpp API error: ${res.status} - ${errText}`);
		}

		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let fullContent = '';
		let toolCalls: IQ3ToolCall[] = [];
		let usage: IQ3TokenUsage | undefined;
		let lineBuffer = '';
		let textParsedToolCalls = false;

		let streamDone = false;
		const READ_TIMEOUT_MS = 120000;
		try {
		for (;;) {
			const readPromise = reader.read();
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
				timeoutId = setTimeout(() => resolve({ done: true, value: undefined }), READ_TIMEOUT_MS);
			});
			const { done, value } = await Promise.race([readPromise, timeoutPromise]);
			if (timeoutId) { clearTimeout(timeoutId); }
			if (done) {
				if (!value) {
					console.warn('[Q3LLMBridge] Stream read timed out after', READ_TIMEOUT_MS, 'ms, treating as end of stream');
				}
				break;
			}

			lineBuffer += decoder.decode(value, { stream: true });
			const lines = lineBuffer.split('\n');
			lineBuffer = lines.pop() || '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
				const dataStr = trimmed.slice(6);
				if (dataStr === '[DONE]') { streamDone = true; break; }

				try {
					const data = JSON.parse(dataStr) as any;
					const delta = data.choices?.[0]?.delta;
					if (delta?.content) {
						fullContent += delta.content;
						onToken(delta.content);
					}
					if (delta?.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							if (!toolCalls[idx]) {
								toolCalls[idx] = {
									id: tc.id || `call_${Date.now()}_${idx}`,
									type: 'function' as const,
									function: { name: '', arguments: '' },
								};
							}
							if (tc.function?.name) {
								toolCalls[idx].function.name += tc.function.name;
							}
							if (tc.function?.arguments) {
								toolCalls[idx].function.arguments += tc.function.arguments;
							}
						}
					}
					if (data.usage) {
						usage = this._parseOpenAIUsage(data.usage);
					}
					const finishReason = data.choices?.[0]?.finish_reason;
					if (finishReason === 'stop' || finishReason === 'tool_calls' || finishReason === 'length') {
						streamDone = true;
						break;
					}
				} catch {
					// Partial JSON, ignore
				}
			}
			if (streamDone) { break; }
		}
		} finally {
			// Always release the reader to free the HTTP connection
			try { reader.cancel(); } catch {}
			try { reader.releaseLock(); } catch {}
		}

		this._abortController = undefined;

		// Filter out empty tool calls
		toolCalls = toolCalls.filter(tc => tc.function.name);

		// Validate and repair tool call arguments JSON
		for (const tc of toolCalls) {
			tc.function.arguments = this._validateToolCallArgs(tc.function.arguments);
		}

		if (toolCalls.length > 0) {
			console.warn('[Q3LLMBridge] (llama.cpp) Got', toolCalls.length, 'native tool calls:', toolCalls.map(tc => tc.function.name).join(', '));
		}

		fullContent = fullContent.replace(/\[TOOL_CALLS?\]/g, '').trim();

		if (toolCalls.length === 0 && fullContent) {
			console.warn('[Q3LLMBridge] (llama.cpp) No native tool_calls, attempting text parse. Content tail:', fullContent.slice(-200));
			const parsed = this._parseTextToolCalls(fullContent);
			if (parsed.toolCalls.length > 0) {
				console.warn('[Q3LLMBridge] (llama.cpp) Parsed', parsed.toolCalls.length, 'text tool calls');
				toolCalls = parsed.toolCalls;
				fullContent = parsed.remainingText;
				textParsedToolCalls = true;
			} else {
				console.warn('[Q3LLMBridge] (llama.cpp) No text tool calls found in content');
			}
		}

		return { content: fullContent, toolCalls, usage, textParsedToolCalls };
	}

	async complete(model: string, request: IQ3FIMRequest, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
		return this._completeOpenAI(model, request, options);
	}

	private async _completeOpenAI(model: string, request: IQ3FIMRequest, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
		const body: any = {
			model,
			prompt: request.prefix,
			suffix: request.suffix,
			stream: false,
			temperature: options?.temperature ?? 0.2,
			max_tokens: options?.maxTokens ?? 128,
			stop: ['\n\n', '```'],
		};

		const respText = await this._requestWithRetry(`${this.getEndpoint()}/v1/completions`, JSON.stringify(body));
		const data = JSON.parse(respText) as any;
		return data.choices?.[0]?.text || '';
	}

	private async _request(url: string, body: string): Promise<string> {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});
		if (!res.ok) {
			const errorBody = await res.text();
			throw new Error(`API error: ${res.status} - ${errorBody}`);
		}
		return await res.text();
	}

	private async _requestWithRetry(url: string, body: string): Promise<string> {
		const maxRetries = this._configService.getValue<number>('q3.agent.maxRetries') ?? 3;
		const baseDelay = this._configService.getValue<number>('q3.agent.retryDelay') ?? 1000;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await this._request(url, body);
			} catch (err: any) {
				lastError = err;
				if (attempt < maxRetries) {
					const delay = baseDelay * Math.pow(2, attempt);
					await this._sleep(delay);
				}
			}
		}
		throw lastError ?? new Error('Request failed after retries');
	}

	private async _fetchWithRetry(url: string, body: string, signal?: AbortSignal): Promise<Response> {
		const maxRetries = this._configService.getValue<number>('q3.agent.maxRetries') ?? 3;
		const baseDelay = this._configService.getValue<number>('q3.agent.retryDelay') ?? 1000;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				const timeoutController = new AbortController();
				const timeoutId = setTimeout(() => timeoutController.abort(), 300000);
				const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
				const res = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body,
					signal: combinedSignal,
				});
				clearTimeout(timeoutId);
				if (!res.ok) {
					const errText = await res.text();
					throw new Error(`API error: ${res.status} - ${errText}`);
				}
				return res;
			} catch (err: any) {
				// Don't retry HTTP errors (they have a status code) - only retry network errors
				if (err?.message?.startsWith('API error:')) {
					throw err;
				}
				lastError = err;
				if (attempt < maxRetries && !signal?.aborted) {
					const delay = baseDelay * Math.pow(2, attempt);
					await this._sleep(delay);
				}
			}
		}
		throw lastError ?? new Error('Fetch failed after retries');
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private _parseOpenAIUsage(usage: any): IQ3TokenUsage | undefined {
		if (usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)) {
			const promptTokens = usage.prompt_tokens ?? 0;
			const completionTokens = usage.completion_tokens ?? 0;
			return {
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
			};
		}
		return undefined;
	}

	private _parseTextToolCalls(content: string): { toolCalls: IQ3ToolCall[]; remainingText: string } {
		const toolCalls: IQ3ToolCall[] = [];
		let remainingText = content;

		// Pattern 1: <function=name><parameter=key>value</parameter></function>
		const xmlRegex = /<function=(\w+)>([\s\S]*?)<\/function>/g;
		const xmlParamRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;

		let match: RegExpExecArray | null;
		while ((match = xmlRegex.exec(content)) !== null) {
			const name = match[1];
			const inner = match[2];
			const args: any = {};

			let paramMatch: RegExpExecArray | null;
			const paramRegex = new RegExp(xmlParamRegex);
			while ((paramMatch = paramRegex.exec(inner)) !== null) {
				args[paramMatch[1]] = paramMatch[2].trim();
			}

			toolCalls.push({
				id: `call_${Date.now()}_${toolCalls.length}`,
				type: 'function',
				function: {
					name,
					arguments: JSON.stringify(args),
				},
			});
		}

		if (toolCalls.length > 0) {
			remainingText = content.replace(xmlRegex, '').trim();
		}

		// Pattern 2: [TOOL_CALLS] with JSON array
		if (toolCalls.length === 0) {
			const jsonToolMatch = content.match(/\[TOOL_CALLS?\]\s*(\[[\s\S]*?\])/);
			if (jsonToolMatch) {
				try {
					const parsed = JSON.parse(jsonToolMatch[1]);
					for (const tc of parsed) {
						toolCalls.push({
							id: tc.id || `call_${Date.now()}_${toolCalls.length}`,
							type: 'function',
							function: {
								name: tc.function?.name || tc.name || '',
								arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
							},
						});
					}
					remainingText = content.replace(jsonToolMatch[0], '').trim();
				} catch {
					// JSON parse failed, ignore
					}
			}
		}

		// Pattern 3: Qwen tool_call format: <tool_call>\n{"name": "...", "arguments": {...}}\n</tool_call>
		if (toolCalls.length === 0) {
			const toolCallRegex = /<tool_call>\s*([\s\S]*?)<\/tool_call>/g;
			let tcMatch: RegExpExecArray | null;
			while ((tcMatch = toolCallRegex.exec(content)) !== null) {
				try {
					const parsed = JSON.parse(tcMatch[1].trim());
					toolCalls.push({
						id: `call_${Date.now()}_${toolCalls.length}`,
						type: 'function',
						function: {
							name: parsed.name || parsed.function?.name || '',
							arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || parsed.function?.arguments || {}),
						},
					});
				} catch {
					// JSON parse failed, ignore
					}
			}
			if (toolCalls.length > 0) {
				remainingText = content.replace(toolCallRegex, '').trim();
			}
		}

		// Pattern 4: Qwen ichat format: <\uFF5Ctool\u2581call\u2581begin\uFF5C>function<\uFF5Ctool\u2581sep\uFF5C>name<\uFF5Ctool\u2581call\u2581args\u2581begin\uFF5C>{...}<\uFF5Ctool\u2581call\u2581end\uFF5C>
		if (toolCalls.length === 0) {
			const ichatRegex = /<\uFF5Ctool\u2581call\u2581begin\uFF5C>function<\uFF5Ctool\u2581sep\uFF5C>(\w+)<\uFF5Ctool\u2581call\u2581args\u2581begin\uFF5C>([\s\S]*?)<\uFF5Ctool\u2581call\u2581end\uFF5C>/g;
			let ichatMatch: RegExpExecArray | null;
			while ((ichatMatch = ichatRegex.exec(content)) !== null) {
				toolCalls.push({
					id: `call_${Date.now()}_${toolCalls.length}`,
					type: 'function',
					function: {
						name: ichatMatch[1],
						arguments: ichatMatch[2].trim(),
					},
				});
			}
			if (toolCalls.length > 0) {
				remainingText = content.replace(ichatRegex, '').trim();
			}
		}

		// Pattern 5: Markdown code block with JSON tool call
		if (toolCalls.length === 0) {
			const codeBlockRegex = /```(?:json|tool_call)?\s*\n?(\{[\s\S]*?\})\s*```/g;
			let cbMatch: RegExpExecArray | null;
			while ((cbMatch = codeBlockRegex.exec(content)) !== null) {
				try {
					const parsed = JSON.parse(cbMatch[1].trim());
					if (parsed.name || parsed.function?.name) {
						toolCalls.push({
							id: `call_${Date.now()}_${toolCalls.length}`,
							type: 'function',
							function: {
								name: parsed.name || parsed.function?.name || '',
								arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || parsed.function?.arguments || {}),
							},
						});
					}
				} catch {
					// JSON parse failed, ignore
					}
			}
			if (toolCalls.length > 0) {
				remainingText = content.replace(codeBlockRegex, '').trim();
			}
		}

		return { toolCalls, remainingText };
	}

	private _validateToolCallArgs(args: string): string {
		if (!args) { return '{}'; }
		try {
			JSON.parse(args);
			return args;
		} catch {
			// JSON is invalid - try to repair common issues
			console.warn('[Q3LLMBridge] Invalid tool call args JSON, attempting repair. Length:', args.length);
			try {
				// Attempt 1: Try parsing as-is (maybe just trailing content)
				const trimmed = args.trim();
				JSON.parse(trimmed);
				return trimmed;
			} catch {
				// Attempt 2: Try to find the first valid JSON object in the string
				const jsonMatch = args.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					try {
						JSON.parse(jsonMatch[0]);
						return jsonMatch[0];
					} catch {
						// Still invalid, fall through
					}
				}
				// Attempt 3: If the args look like they contain a content field with unescaped quotes,
				// try to extract what we can and return a minimal valid object
				console.warn('[Q3LLMBridge] Could not repair tool call args JSON, using empty object');
				return '{}';
			}
		}
	}
}

registerSingleton(IQ3LLMBridgeService, Q3LLMBridgeService, InstantiationType.Delayed);
