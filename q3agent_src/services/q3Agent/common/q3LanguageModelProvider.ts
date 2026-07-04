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
		const temperature = this._configService.getValue<number>('q3.agent.temperature') ?? 0;
		const maxTokens = this._configService.getValue<number>('q3.agent.maxTokens') ?? 4096;

		let resolveResult!: () => void;
		let rejectResult!: (err: Error) => void;
		const result = new Promise<void>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});

		const self = this;
		const stream: AsyncIterable<IChatResponsePart | IChatResponsePart[]> = {
			async *[Symbol.asyncIterator](): AsyncIterator<IChatResponsePart | IChatResponsePart[]> {
				try {
					const response = await self._llmBridge.chatStream(
						modelId,
						q3Messages,
						tools,
						{ temperature, maxTokens },
						(tokenText: string) => {
							// Tokens are accumulated inside chatStream; we yield the final content
						}
					);

					if (token.isCancellationRequested) {
						self._llmBridge.cancel();
						resolveResult();
						return;
					}

					if (response.content) {
						yield [{ type: 'text', value: response.content } as IChatResponseTextPart];
					}

					if (response.toolCalls && response.toolCalls.length > 0) {
						for (const toolCall of response.toolCalls) {
							let params: unknown = {};
							try { params = JSON.parse(toolCall.function.arguments); } catch {}
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
					rejectResult(err as Error);
					throw err;
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
		if (typeof message === 'string') {
			return Math.ceil(message.length / 4);
		}
		let totalLength = 0;
		for (const part of message.content) {
			if (part.type === 'text') {
				totalLength += part.value.length;
			}
		}
		return Math.ceil(totalLength / 4);
	}
}
