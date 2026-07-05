/*---------------------------------------------------------------------------------------------}
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import {
	ChatMessageRole,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatMetadata,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
	IChatMessage,
	IChatResponsePart,
	IChatResponseTextPart,
	IChatResponseToolUsePart,
} from '../../../contrib/chat/common/languageModels.js';
import { IQ3LLMBridgeService, IQ3ChatMessage, IQ3ToolDefinition } from './q3Agent.js';

export const Q3_VENDOR_ID = 'q3';

export class Q3LanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _modelsCache: ILanguageModelChatMetadataAndIdentifier[] = [];

	constructor(
		@IQ3LLMBridgeService private readonly _llmBridge: IQ3LLMBridgeService,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		if (this._modelsCache.length > 0) {
			return this._modelsCache;
		}

		const modelId = this._configService.getValue<string>('q3.agent.model') || 'qwen3-coder:30b';
		const maxInputTokens = this._configService.getValue<number>('q3.agent.llamacpp.ctxSize') || 32768;
		const maxOutputTokens = this._configService.getValue<number>('q3.agent.maxTokens') || 4096;

		const metadata: ILanguageModelChatMetadata = {
			extension: new ExtensionIdentifier('q3-ide'),
			name: 'Qwen3 Coder',
			id: modelId,
			vendor: Q3_VENDOR_ID,
			version: '1.0.0',
			family: 'qwen3',
			maxInputTokens,
			maxOutputTokens,
			isDefaultForLocation: { panel: true },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				agentMode: true,
			},
		};

		this._modelsCache = [{ metadata, identifier: modelId }];
		return this._modelsCache;
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const q3Messages = this._convertMessages(messages);
		const tools: IQ3ToolDefinition[] = [];
		const temperature = this._configService.getValue<number>('q3.agent.temperature') ?? 0.2;
		const maxTokens = this._configService.getValue<number>('q3.agent.maxTokens') ?? 2048;

		let resolveResult!: () => void;
		let rejectResult!: (err: Error) => void;
		const result = new Promise<void>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});

		const self = this;

		// Queue-based bridge: callback pushes tokens, generator pulls them
		const tokenQueue: IChatResponseTextPart[] = [];
		let tokenQueueDone = false;

		const stream: AsyncIterable<IChatResponsePart | IChatResponsePart[]> = {
			async *[Symbol.asyncIterator](): AsyncIterator<IChatResponsePart | IChatResponsePart[]> {
				try {
					// Start chatStream in background — it pushes tokens into the queue via callback
					const responsePromise = self._llmBridge.chatStream(
						modelId,
						q3Messages,
						tools,
						{ temperature, maxTokens },
						(tokenText: string) => {
							if (token.isCancellationRequested) {
								self._llmBridge.cancel();
								return;
							}
							tokenQueue.push({ type: 'text', value: tokenText });
						}
					);

					// Yield tokens as they arrive in the queue
					while (!tokenQueueDone) {
						if (token.isCancellationRequested) {
							self._llmBridge.cancel();
							resolveResult();
							return;
						}

						if (tokenQueue.length > 0) {
							yield [tokenQueue.shift()!];
						} else {
							// Check if chatStream has resolved
							const settled = await Promise.race([
								responsePromise.then(() => true).catch(() => true),
								Promise.resolve(false).then(() => new Promise<boolean>(r => setTimeout(() => r(false), 10)))
							]);
							if (settled && tokenQueue.length === 0) {
								tokenQueueDone = true;
							}
						}
					}

					// Drain any remaining tokens
					while (tokenQueue.length > 0) {
						yield [tokenQueue.shift()!];
					}

					// Get the final response for tool calls
					const response = await responsePromise;

					if (response.toolCalls && response.toolCalls.length > 0) {
						for (const toolCall of response.toolCalls) {
							let params: unknown = {};
							try {
								params = JSON.parse(toolCall.function.arguments);
							} catch (err) {
								console.warn('[Q3Provider] Tool call JSON parse failed for', toolCall.function.name, ':', err);
								params = {};
							}
							yield [{
								type: 'tool_use',
								name: toolCall.function.name,
								toolCallId: toolCall.id,
								parameters: params,
							} as IChatResponseToolUsePart];
						}
					}

					resolveResult();
				} catch (err) {
					yield [{ type: 'text', value: `Error: ${String((err as Error).message || err)}` } as IChatResponseTextPart];
					rejectResult(err as Error);
				}
			}
		};

		return { stream, result };
	}

	private _convertMessages(messages: IChatMessage[]): IQ3ChatMessage[] {
		return messages.map(msg => {
			const role = this._convertRole(msg.role);
			let content = '';
			for (const part of msg.content) {
				if (part.type === 'text') {
					content += part.value;
				}
			}
			return { role, content };
		});
	}

	private _convertRole(role: ChatMessageRole): 'system' | 'user' | 'assistant' {
		switch (role) {
			case ChatMessageRole.System: return 'system';
			case ChatMessageRole.User: return 'user';
			case ChatMessageRole.Assistant: return 'assistant';
			default: return 'user';
		}
	}

	async provideTokenCount(modelId: string, message: string | IChatMessage, token: CancellationToken): Promise<number> {
		let text: string;
		if (typeof message === 'string') {
			text = message;
		} else {
			text = '';
			for (const part of message.content) {
				if (part.type === 'text') {
					text += part.value;
				}
			}
		}
		// Normalize whitespace and count words (~1.3 tokens per word for code)
		const words = text.trim().split(/\s+/).filter(w => w.length > 0).length;
		const chars = text.length;
		// Blend word count and char count for better estimate
		return Math.ceil(Math.max(words * 1.3, chars / 4));
	}
}
