/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IQ3ModelService = createDecorator<IQ3ModelService>('q3ModelService');

export interface IQ3ModelInfo {
	name: string;
	parameterSize: string;
	quantizationLevel: string;
	size: number;
}

export interface IQ3ModelService {
	readonly _serviceBrand: undefined;

	readonly onDidModelsChange: Event<void>;

	isOllamaRunning(): Promise<boolean>;
	getModels(): Promise<IQ3ModelInfo[]>;
	pullModel(name: string): Promise<void>;
	deleteModel(name: string): Promise<void>;
	getCurrentModel(): string;
	setCurrentModel(model: string): void;
	getEndpoint(): string;
}

export const IQ3LLMBridgeService = createDecorator<IQ3LLMBridgeService>('q3LLMBridgeService');

export interface IQ3ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: IQ3ToolCall[];
	toolCallId?: string;
}

export interface IQ3ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface IQ3ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: string;
			properties: Record<string, { type: string; description: string }>;
			required: string[];
		};
	};
}

export interface IQ3StreamToken {
	token: string;
	done: boolean;
}

export interface IQ3LLMResponse {
	content: string;
	toolCalls: IQ3ToolCall[];
}

export interface IQ3LLMBridgeService {
	readonly _serviceBrand: undefined;

	chat(model: string, messages: IQ3ChatMessage[], tools?: IQ3ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): Promise<IQ3LLMResponse>;
	chatStream(model: string, messages: IQ3ChatMessage[], tools: IQ3ToolDefinition[], options: { temperature: number; maxTokens: number }, onToken: (token: string) => void): Promise<IQ3LLMResponse>;
	cancel(): void;
}

export const IQ3AgentService = createDecorator<IQ3AgentService>('q3AgentService');

export interface IQ3AgentRequest {
	prompt: string;
	context?: {
		activeFile?: {
			path: string;
			content?: string;
			language?: string;
			selection?: string;
		};
		openTabs?: string[];
		workspaceRoot?: string;
	};
}

export interface IQ3AgentResponseChunk {
	type: 'token' | 'tool_call' | 'tool_result' | 'done' | 'error';
	content?: string;
	toolName?: string;
	toolArgs?: string;
	toolResult?: string;
	error?: string;
}

export interface IQ3AgentService {
	readonly _serviceBrand: undefined;

	readonly onDidResponseChunk: Event<IQ3AgentResponseChunk>;
	readonly onDidStateChange: Event<'idle' | 'thinking' | 'tool_executing'>;

	isRunning(): boolean;
	cancel(): void;
	send(request: IQ3AgentRequest): Promise<void>;
}
