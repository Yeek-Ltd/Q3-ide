/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQ3LLMBridgeService, IQ3ChatMessage, IQ3ToolDefinition, IQ3ToolCall, IQ3LLMResponse } from './q3Agent.js';

export class Q3LLMBridgeService extends Disposable implements IQ3LLMBridgeService {
	declare readonly _serviceBrand: undefined;

	private _abortController: AbortController | undefined;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();
	}

	private getEndpoint(): string {
		return this._configService.getValue<string>('q3.agent.endpoint') || 'http://localhost:11434';
	}

	cancel(): void {
		if (this._abortController) {
			this._abortController.abort();
			this._abortController = undefined;
		}
	}

	async chat(model: string, messages: IQ3ChatMessage[], tools?: IQ3ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): Promise<IQ3LLMResponse> {
		const body: any = {
			model,
			messages: messages.map(m => ({ role: m.role, content: m.content })),
			stream: false,
			options: {
				temperature: options?.temperature ?? 0.7,
				num_predict: options?.maxTokens ?? 4096,
			},
		};
		if (tools && tools.length > 0) {
			body.tools = tools;
		}

		const resp = await fetch(`${this.getEndpoint()}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		if (!resp.ok) {
			throw new Error(`Ollama API error: ${resp.status} ${resp.statusText}`);
		}

		const data = await resp.json() as any;
		return {
			content: data.message?.content || '',
			toolCalls: (data.message?.tool_calls || []).map((tc: any) => ({
				id: tc.id || `call_${Date.now()}`,
				type: 'function' as const,
				function: {
					name: tc.function?.name || '',
					arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
				},
			})),
		};
	}

	async chatStream(model: string, messages: IQ3ChatMessage[], tools: IQ3ToolDefinition[], options: { temperature: number; maxTokens: number }, onToken: (token: string) => void): Promise<IQ3LLMResponse> {
		this._abortController = new AbortController();

		const body: any = {
			model,
			messages: messages.map(m => {
				const msg: any = { role: m.role, content: m.content };
				if (m.toolCalls) {
					msg.tool_calls = m.toolCalls;
				}
				if (m.toolCallId) {
					msg.tool_call_id = m.toolCallId;
				}
				return msg;
			}),
			stream: true,
			tools,
			options: {
				temperature: options.temperature,
				num_predict: options.maxTokens,
			},
		};

		const resp = await fetch(`${this.getEndpoint()}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: this._abortController.signal,
		});

		if (!resp.ok) {
			throw new Error(`Ollama API error: ${resp.status} ${resp.statusText}`);
		}

		const reader = resp.body?.getReader();
		if (!reader) {
			throw new Error('No response body');
		}

		const decoder = new TextDecoder();
		let buffer = '';
		let fullContent = '';
		const toolCalls: IQ3ToolCall[] = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) { continue; }
				try {
					const chunk = JSON.parse(line) as any;
					if (chunk.message?.content) {
						fullContent += chunk.message.content;
						onToken(chunk.message.content);
					}
					if (chunk.message?.tool_calls) {
						for (const tc of chunk.message.tool_calls) {
							toolCalls.push({
								id: tc.id || `call_${Date.now()}_${toolCalls.length}`,
								type: 'function' as const,
								function: {
									name: tc.function?.name || '',
									arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
								},
							});
						}
					}
				} catch {
					// partial JSON, skip
				}
			}
		}

		this._abortController = undefined;
		return { content: fullContent, toolCalls };
	}
}

registerSingleton(IQ3LLMBridgeService, Q3LLMBridgeService, InstantiationType.Delayed);
