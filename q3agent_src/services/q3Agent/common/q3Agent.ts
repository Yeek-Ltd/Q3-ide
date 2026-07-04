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

export interface IQ3ModelPreset {
	name: string;
	displayName: string;
	description: string;
	size: string;
	cloud: boolean;
	category: 'coder' | 'general' | 'reasoning';
}

export interface IQ3ModelService {
	readonly _serviceBrand: undefined;

	readonly onDidModelsChange: Event<void>;

	getModels(): Promise<IQ3ModelInfo[]>;
	getModelPresets(): IQ3ModelPreset[];
	pullModel(name: string): Promise<void>;
	deleteModel(name: string): Promise<void>;
	getCurrentModel(): string;
	setCurrentModel(model: string): void;
	getEndpoint(): string;
	refreshModels(): void;
	listLocalGGUFModels(): string[];
}

export const IQ3LLMBridgeService = createDecorator<IQ3LLMBridgeService>('q3LLMBridgeService');

export interface IQ3ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: IQ3ToolCall[];
	toolCallId?: string;
	toolName?: string;
}

export interface IQ3ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface IQ3ToolProperty {
	type: string;
	description?: string;
	items?: IQ3ToolProperty;
	properties?: Record<string, IQ3ToolProperty>;
	required?: string[];
	enum?: string[];
}

export interface IQ3ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: string;
			properties: Record<string, IQ3ToolProperty>;
			required: string[];
		};
	};
}

export interface IQ3StreamToken {
	token: string;
	done: boolean;
}

export interface IQ3TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface IQ3LLMResponse {
	content: string;
	toolCalls: IQ3ToolCall[];
	usage?: IQ3TokenUsage;
	textParsedToolCalls?: boolean;
}

export interface IQ3FIMRequest {
	prefix: string;
	suffix: string;
	language: string;
}

export interface IQ3LLMBridgeService {
	readonly _serviceBrand: undefined;

	chat(model: string, messages: IQ3ChatMessage[], tools?: IQ3ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): Promise<IQ3LLMResponse>;
	chatStream(model: string, messages: IQ3ChatMessage[], tools: IQ3ToolDefinition[], options: { temperature: number; maxTokens: number }, onToken: (token: string) => void): Promise<IQ3LLMResponse>;
	complete(model: string, request: IQ3FIMRequest, options?: { temperature?: number; maxTokens?: number }): Promise<string>;
	cancel(): void;
}

export const IQ3LlamaCppService = createDecorator<IQ3LlamaCppService>('q3LlamaCppService');

export interface IQ3LlamaCppService {
	readonly _serviceBrand: undefined;

	readonly onDidStateChange: Event<'stopped' | 'starting' | 'running' | 'error'>;
	readonly onDidStatusMessage: Event<string>;

	start(): Promise<boolean>;
	stop(): Promise<void>;
	fireStatusMessage(msg: string): void;
	isRunning(): boolean;
	getPort(): number;
	getEndpoint(): string;
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
			cursorLine?: number;
			cursorColumn?: number;
		};
		openTabs?: string[];
		workspaceRoot?: string;
	};
}

export interface IQ3AgentResponseChunk {
	type: 'token' | 'tool_call' | 'tool_result' | 'tool_approval' | 'done' | 'error' | 'step' | 'file_diff' | 'status';
	content?: string;
	toolName?: string;
	toolArgs?: string;
	toolResult?: string;
	toolCallId?: string;
	error?: string;
	stepNumber?: number;
	maxSteps?: number;
	filePath?: string;
	diffLines?: { type: 'add' | 'del' | 'context'; text: string; oldLine?: number; newLine?: number }[];
	oldText?: string;
	newText?: string;
}

export interface IQ3AgentService {
	readonly _serviceBrand: undefined;

	readonly onDidResponseChunk: Event<IQ3AgentResponseChunk>;
	readonly onDidStateChange: Event<'idle' | 'thinking' | 'tool_executing'>;

	isRunning(): boolean;
	cancel(): void;
	send(request: IQ3AgentRequest): Promise<void>;
	resolveApproval(toolCallId: string, approved: boolean): void;
}
