/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IQ3AgentService, IQ3AgentRequest, IQ3AgentResponseChunk, IQ3ChatMessage, IQ3ToolDefinition, IQ3ToolCall, IQ3LLMBridgeService, IQ3ModelService } from './q3Agent.js';

const SYSTEM_PROMPT = `You are Q3 IDE's built-in AI coding assistant, powered by Qwen 3 Coder running locally via Ollama.
You help users with coding tasks: writing code, debugging, refactoring, explaining code, and running commands.

You have access to tools that let you interact with the user's workspace:
- read_file: Read the contents of a file
- list_dir: List directory contents
- apply_edit: Apply an edit to a file (old_string -> new_string replacement)
- run_command: Run a shell command and return its output

When the user asks you to do something that requires file access or running commands, use the appropriate tool.
Always explain what you're doing before using a tool. After getting tool results, summarize what you found.
Keep responses concise and focused. Use code blocks for code suggestions.`;

const TOOLS: IQ3ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read the contents of a file at the given path',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The file path to read' }
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_dir',
			description: 'List the contents of a directory',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The directory path to list' }
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'apply_edit',
			description: 'Apply an edit to a file by replacing old_string with new_string',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The file path to edit' },
					old_string: { type: 'string', description: 'The exact text to find and replace' },
					new_string: { type: 'string', description: 'The replacement text' }
				},
				required: ['path', 'old_string', 'new_string']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'run_command',
			description: 'Run a shell command and return its output',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The command to run' }
				},
				required: ['command']
			}
		}
	},
];

export class Q3AgentService extends Disposable implements IQ3AgentService {
	declare readonly _serviceBrand: undefined;

	private _running = false;
	private _conversationHistory: IQ3ChatMessage[] = [];

	private readonly _onDidResponseChunk = new Emitter<IQ3AgentResponseChunk>();
	readonly onDidResponseChunk: Event<IQ3AgentResponseChunk> = this._onDidResponseChunk.event;

	private readonly _onDidStateChange = new Emitter<'idle' | 'thinking' | 'tool_executing'>();
	readonly onDidStateChange: Event<'idle' | 'thinking' | 'tool_executing'> = this._onDidStateChange.event;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IQ3LLMBridgeService private readonly _llmBridge: IQ3LLMBridgeService,
		@IQ3ModelService private readonly _modelService: IQ3ModelService,
		@IEditorService private readonly _editorService: IEditorService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) {
		super();
	}

	isRunning(): boolean {
		return this._running;
	}

	cancel(): void {
		this._llmBridge.cancel();
		this._running = false;
		this._onDidStateChange.fire('idle');
	}

	async send(request: IQ3AgentRequest): Promise<void> {
		if (this._running) { return; }
		this._running = true;

		try {
			const contextMsg = this.buildContext(request);
			const userMessage: IQ3ChatMessage = { role: 'user', content: contextMsg + request.prompt };
			this._conversationHistory.push(userMessage);

			const messages: IQ3ChatMessage[] = [
				{ role: 'system', content: SYSTEM_PROMPT },
				...this._conversationHistory,
			];

			const maxSteps = this._configService.getValue<number>('q3.agent.maxLoopSteps') || 20;

			for (let step = 0; step < maxSteps; step++) {
				this._onDidStateChange.fire('thinking');

				const response = await this._llmBridge.chatStream(
					this._modelService.getCurrentModel(),
					messages,
					TOOLS,
					{
						temperature: this._configService.getValue<number>('q3.agent.temperature') ?? 0.7,
						maxTokens: this._configService.getValue<number>('q3.agent.maxTokens') ?? 4096,
					},
					(token: string) => {
						this._onDidResponseChunk.fire({ type: 'token', content: token });
					}
				);

				const assistantMsg: IQ3ChatMessage = { role: 'assistant', content: response.content, toolCalls: response.toolCalls };
				this._conversationHistory.push(assistantMsg);
				messages.push(assistantMsg);

				if (response.toolCalls.length === 0) {
					break;
				}

				for (const toolCall of response.toolCalls) {
					this._onDidStateChange.fire('tool_executing');
					this._onDidResponseChunk.fire({
						type: 'tool_call',
						toolName: toolCall.function.name,
						toolArgs: toolCall.function.arguments,
					});

					const result = await this.executeTool(toolCall);
					this._onDidResponseChunk.fire({
						type: 'tool_result',
						toolName: toolCall.function.name,
						toolResult: result,
					});

					const toolMsg: IQ3ChatMessage = {
						role: 'tool',
						content: result,
						toolCallId: toolCall.id,
					};
					this._conversationHistory.push(toolMsg);
					messages.push(toolMsg);
				}
			}

			this._onDidResponseChunk.fire({ type: 'done' });
		} catch (err: any) {
			this._onDidResponseChunk.fire({ type: 'error', error: err?.message || String(err) });
		} finally {
			this._running = false;
			this._onDidStateChange.fire('idle');
		}
	}

	private buildContext(request: IQ3AgentRequest): string {
		const parts: string[] = [];

		if (request.context?.activeFile) {
			const f = request.context.activeFile;
			parts.push(`Current file: ${f.path} (${f.language})`);
			if (f.selection) {
				parts.push(`Selected text:\n\`\`\`${f.language}\n${f.selection}\n\`\`\``);
			} else if (f.content) {
				const truncated = f.content.length > 5000 ? f.content.substring(0, 5000) + '\n... (truncated)' : f.content;
				parts.push(`File content:\n\`\`\`${f.language}\n${truncated}\n\`\`\``);
			}
		}

		if (request.context?.openTabs && request.context.openTabs.length > 0) {
			parts.push(`Open tabs: ${request.context.openTabs.join(', ')}`);
		}

		if (request.context?.workspaceRoot) {
			parts.push(`Workspace root: ${request.context.workspaceRoot}`);
		}

		if (parts.length > 0) {
			return parts.join('\n') + '\n\n';
		}
		return '';
	}

	private async executeTool(toolCall: IQ3ToolCall): Promise<string> {
		let args: any;
		try {
			args = JSON.parse(toolCall.function.arguments);
		} catch {
			return `Error: Invalid tool arguments: ${toolCall.function.arguments}`;
		}

		switch (toolCall.function.name) {
			case 'read_file':
				return await this.toolReadFile(args.path);
			case 'list_dir':
				return await this.toolListDir(args.path);
			case 'apply_edit':
				return await this.toolApplyEdit(args.path, args.old_string, args.new_string);
			case 'run_command':
				return await this.toolRunCommand(args.command);
			default:
				return `Error: Unknown tool: ${toolCall.function.name}`;
		}
	}

	private async toolReadFile(path: string): Promise<string> {
		try {
			const uri = this.resolvePath(path);
			const content = await this._fileService.readFile(uri);
			return content.value.toString();
		} catch (err: any) {
			return `Error reading file: ${err?.message}`;
		}
	}

	private async toolListDir(path: string): Promise<string> {
		try {
			const uri = this.resolvePath(path);
			const stat = await this._fileService.resolve(uri);
			if (stat.children) {
				return stat.children.map(e => `${e.name}${e.isDirectory ? '/' : ''}`).join('\n');
			}
			return 'Empty directory';
		} catch (err: any) {
			return `Error listing directory: ${err?.message}`;
		}
	}

	private async toolApplyEdit(path: string, oldString: string, newString: string): Promise<string> {
		try {
			const uri = this.resolvePath(path);
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();
			if (!text.includes(oldString)) {
				return `Error: old_string not found in ${path}`;
			}
			const newText = text.replace(oldString, newString);
			await this._fileService.writeFile(uri, VSBuffer.fromString(newText));
			return `Successfully edited ${path}`;
		} catch (err: any) {
			return `Error editing file: ${err?.message}`;
		}
	}

	private async toolRunCommand(command: string): Promise<string> {
		return `Command execution is not yet implemented. Command was: ${command}`;
	}

	private resolvePath(path: string): URI {
		if (path.startsWith('file://')) {
			return URI.parse(path);
		}
		const workspace = this._workspaceService.getWorkspace();
		if (workspace.folders.length > 0) {
			const root = workspace.folders[0].uri;
			return URI.joinPath(root, path);
		}
		const activeEditor = this._editorService.activeEditor;
		if (activeEditor?.resource) {
			const dir = activeEditor.resource.with({ path: activeEditor.resource.path.substring(0, activeEditor.resource.path.lastIndexOf('/')) });
			return URI.joinPath(dir, path);
		}
		return URI.file(path);
	}
}

registerSingleton(IQ3AgentService, Q3AgentService, InstantiationType.Delayed);
