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
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { IQ3AgentService, IQ3AgentRequest, IQ3AgentResponseChunk, IQ3ChatMessage, IQ3ToolDefinition, IQ3ToolCall, IQ3LLMBridgeService, IQ3ModelService, IQ3TokenUsage } from './q3Agent.js';
import { normalizeEditStrings, maybeAugmentOldStringForDeletion, countOccurrences, extractEditSnippet } from './editHelper.js';
import { safeLiteralReplace } from './textUtils.js';

const SYSTEM_PROMPT = `You are a coding assistant with tools. You MUST call tools to make any change - NEVER describe changes in text without calling the corresponding tool. Do not claim you have fixed, added, or updated something unless you have called the tool to do it. Do NOT write summaries of changes before making them - call the tool first, then briefly confirm after.

Tools: read_file (read a file), list_dir (list directory), grep_search (search code), read_diagnostics (check errors), apply_edit (edit file with old_string/new_string - copy EXACT text from file, set replace_all=true to replace every occurrence), batch_edit (apply multiple edits to one file in a single call - ALWAYS use this when you need to make 2+ edits to the same file), write_file (create/overwrite file), run_command (run shell command), git_commit (commit changes), git_status (check git status).

Rules:
- Always read a file before editing it, then use the exact text you read as old_string
- MANDATORY: When making 2 or more edits to the same file, use batch_edit with ALL edits in a single call. NEVER make multiple sequential apply_edit calls to the same file - the file content changes between edits and old_string will not match.
- After making changes, do not write a summary of what you did - just say done or make the next tool call
- Do NOT call tools unnecessarily - if you already have enough context to answer, just answer directly
- Use relative paths from the workspace root`;

const TOOLS: IQ3ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read the contents of a file at the given path. Use a relative path from the workspace root, e.g. "src/main.ts".',
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
			description: 'List the contents of a directory. Use "." for the workspace root, or a relative path like "src/components".',
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
			description: 'Apply a partial edit to an existing file by replacing old_string with new_string. Use this for small targeted changes. For creating new files or rewriting an entire file, use write_file instead. Set replace_all to true to replace every occurrence of old_string.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The file path to edit' },
					old_string: { type: 'string', description: 'The exact text to find in the file' },
					new_string: { type: 'string', description: 'The replacement text' },
					replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default false)' }
				},
				required: ['path', 'old_string', 'new_string']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'batch_edit',
			description: 'Apply multiple edits to a single file in one call. Use this when you need to make 2+ changes to the same file. Edits are applied sequentially in order. If any edit fails, remaining edits are skipped.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The file path to edit' },
					edits: {
						type: 'array',
						description: 'Array of edits to apply sequentially',
						items: {
							type: 'object',
							properties: {
								old_string: { type: 'string', description: 'The exact text to find in the file' },
								new_string: { type: 'string', description: 'The replacement text' },
								replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' }
							},
							required: ['old_string', 'new_string']
						}
					}
				},
				required: ['path', 'edits']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'write_file',
			description: 'Create a new file or overwrite an existing file with the given content. Use this when you want to create a new file or completely rewrite an existing file.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The file path to write' },
					content: { type: 'string', description: 'The full file content to write' }
				},
				required: ['path', 'content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'run_command',
			description: 'Run a shell command in the integrated terminal and return a status. The user will see the output in the terminal.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The command to run' }
				},
				required: ['command']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'grep_search',
			description: 'Search for a text pattern in files under a directory. Returns matching lines with file paths and line numbers.',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'The text or regex pattern to search for' },
					path: { type: 'string', description: 'Directory to search in. Use "." for workspace root or a relative path like "src".' },
				include: { type: 'string', description: 'Optional glob pattern to filter files, e.g. "*.ts"' }
				},
				required: ['pattern', 'path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'git_status',
			description: 'Get the git status of the workspace. Shows modified, staged, and untracked files.',
			parameters: {
				type: 'object',
				properties: {},
				required: []
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'git_commit',
			description: 'Stage all changes and create a git commit.',
			parameters: {
				type: 'object',
				properties: {
					message: { type: 'string', description: 'The commit message' }
				},
				required: ['message']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'read_diagnostics',
			description: 'Read errors and warnings from the Problems panel for the current workspace.',
			parameters: {
				type: 'object',
				properties: {},
				required: []
			}
		}
	},
];

export class Q3AgentService extends Disposable implements IQ3AgentService {
	declare readonly _serviceBrand: undefined;

	private _running = false;
	private _conversationHistory: IQ3ChatMessage[] = [];
	private _pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();
	private _totalUsage: IQ3TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	private _lastFileDiff: IQ3AgentResponseChunk | undefined;
	private _readFileCache = new Map<string, string>();
	private _applyEditFailures = new Map<string, number>();
	private _approvedFiles = new Set<string>();

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
		@IMarkerService private readonly _markerService: IMarkerService,
		@ITerminalService private readonly _terminalService: ITerminalService,
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
		this._onDidResponseChunk.fire({ type: 'done', content: 'stopped' });
	}

	resolveApproval(toolCallId: string, approved: boolean): void {
		const pending = this._pendingApprovals.get(toolCallId);
		if (pending) {
			this._pendingApprovals.delete(toolCallId);
			pending.resolve(approved);
		}
	}

	async send(request: IQ3AgentRequest): Promise<void> {
		if (this._running) { return; }
		this._running = true;
		this._readFileCache.clear();
		this._applyEditFailures.clear();
		this._approvedFiles.clear();

		try {
			const contextMsg = this.buildContext(request);
			const userMessage: IQ3ChatMessage = { role: 'user', content: contextMsg + request.prompt };
			this._conversationHistory.push(userMessage);

			this._trimHistory();

			const messages: IQ3ChatMessage[] = [
				{ role: 'system', content: SYSTEM_PROMPT },
				...this._conversationHistory,
			];

			const maxSteps = this._configService.getValue<number>('q3.agent.maxLoopSteps') || 30;
			let nudgeCount = 0;
			const maxNudges = 5;
			const toolActions: string[] = [];
			let consecutiveReads = 0;
			const readOnlyTools = ['read_file', 'list_dir', 'grep_search', 'git_status', 'read_diagnostics'];

			for (let step = 0; step < maxSteps; step++) {
				console.warn('[Q3Agent] Step', step, 'of', maxSteps, 'started');
				this._onDidResponseChunk.fire({ type: 'step', stepNumber: step + 1, maxSteps });
				this._trimHistory();
				// Rebuild messages from trimmed history to keep context bounded
				messages.length = 0;
				messages.push({ role: 'system', content: SYSTEM_PROMPT });
				messages.push(...this._conversationHistory);
				this._onDidStateChange.fire('thinking');

				const stepStart = Date.now();
				const response = await this._llmBridge.chatStream(
					this._modelService.getCurrentModel(),
					messages,
					TOOLS,
					{
						temperature: this._configService.getValue<number>('q3.agent.temperature') ?? 0,
						maxTokens: this._configService.getValue<number>('q3.agent.maxTokens') ?? 4096,
					},
				(token: string) => {
					this._onDidResponseChunk.fire({ type: 'token', content: token });
					}
				);
				console.warn('[Q3Agent] Step', step, 'LLM call took', ((Date.now() - stepStart) / 1000).toFixed(1), 's, content:', response.content.length, 'chars, tools:', response.toolCalls.length);

				if (response.usage) {
					this._totalUsage.promptTokens += response.usage.promptTokens;
					this._totalUsage.completionTokens += response.usage.completionTokens;
					this._totalUsage.totalTokens += response.usage.totalTokens;
				}

				const assistantMsg: IQ3ChatMessage = {
					role: 'assistant',
					content: response.content,
					toolCalls: response.textParsedToolCalls ? [] : response.toolCalls.map(tc => ({
						...tc,
						function: {
							...tc.function,
							arguments: tc.function.arguments.length > 4000
								? tc.function.arguments.slice(0, 4000) + '...[truncated]'
								: tc.function.arguments,
						},
					})),
				};
				this._conversationHistory.push(assistantMsg);
				messages.push(assistantMsg);

				if (response.toolCalls.length === 0) {
					const contentLower = response.content.toLowerCase().trim();

					// Detect false claims of having made changes (e.g. 'I've fixed', 'I've added', 'These changes')
					const claimPhrases = ['i\'ve fixed', 'i\'ve added', 'i\'ve updated', 'i\'ve completed', 'i\'ve implemented', 'i\'ve removed', 'i\'ve exported', 'i\'ve improved', 'i\'ve changed', 'i\'ve modified', 'i\'ve enhanced', 'i\'ve documented', 'i\'ve rewritten', 'i\'ve refactored', 'i\'ve restructured', 'i\'ve reorganized', 'i\'ve simplified', 'i\'ve optimized', 'i\'ve cleaned up', 'i\'ve adjusted', 'i\'ve replaced', 'i\'ve inserted', 'i\'ve deleted', 'i\'ve moved', 'i\'ve renamed', 'i\'ve converted', 'i\'ve transformed', 'i\'ve extended', 'i\'ve configured', 'i\'ve integrated', 'i\'ve upgraded', 'i\'ve patched', 'i\'ve built', 'i\'ve created', 'i\'ve written', 'i fixed', 'i added', 'i updated', 'i completed', 'i implemented', 'i improved', 'i changed', 'i modified', 'i enhanced', 'i documented', 'i rewrote', 'i refactored', 'i replaced', 'i inserted', 'i deleted', 'i moved', 'i renamed', 'i converted', 'i created', 'i wrote', 'i built', 'i cleaned up', 'i adjusted', 'these changes', 'the bot now has', 'the code now', 'i\'ve made the following', 'i made the following', 'i\'ve completely fixed', 'i completely fixed', 'here are the key improvements', 'here are the changes', 'i\'ve added comments', 'i added comments'];
					let hasFalseClaim = claimPhrases.some(p => contentLower.includes(p));

					// Don't nudge on false claims if the model has already made WRITE tool calls (it's likely a genuine summary)
					const writeTools = ['apply_edit', 'write_file'];
					const hasAlreadyMadeChanges = toolActions.some(a => writeTools.some(w => a.startsWith(w)));
					// Also check for 'already' which indicates the model believes it's done
					const saysAlready = contentLower.includes('already') || contentLower.includes('i apologize');
					if (hasFalseClaim && (hasAlreadyMadeChanges || saysAlready)) {
						hasFalseClaim = false;
					}
					// Don't nudge on false claims at step 0 -- the model is likely answering a question about prior work
					if (hasFalseClaim && step === 0) {
						hasFalseClaim = false;
					}

					// Detect tool intent without action (short responses describing what to do)
					const toolKeywords = ['let me', "i'll", 'i will', 'i need to', 'i should', 'now i', 'i can', 'going to', 'i would like to'];
					const actionKeywords = ['read', 'edit', 'list', 'search', 'run', 'check', 'fix', 'create', 'write', 'update', 'modify', 'commit', 'apply'];
					let hasToolIntent = toolKeywords.some(k => contentLower.includes(k)) && actionKeywords.some(k => contentLower.includes(k));

					// Don't nudge for tool intent if the response is substantial or at step 0 (answering a question)
					if (hasToolIntent && !hasFalseClaim && (response.content.length > 500 || step === 0)) {
						hasToolIntent = false;
					}

					const shouldNudge = (hasFalseClaim || hasToolIntent) && step < maxSteps - 1 && nudgeCount < maxNudges;

					if (shouldNudge) {
						nudgeCount++;
						console.warn('[Q3Agent] Model generated text without tool calls (hasFalseClaim:', hasFalseClaim, ', hasToolIntent:', hasToolIntent, '). Nudging. Step:', step, 'Nudge:', nudgeCount);
						const nudgeMsg: IQ3ChatMessage = {
							role: 'user',
							content: hasFalseClaim
								? 'You described changes in text but did not call enough tools to actually make them. Do NOT describe changes - call apply_edit, write_file, or other tools to make each change. Make one tool call per change. Continue making tool calls until all changes are actually applied.'
								: 'You described what you want to do but did not call any tool. Please use the tools to take action now. Do not describe what you will do - call the tool directly.',
						};
						messages.push(nudgeMsg);
						this._conversationHistory.push(nudgeMsg);
						this._onDidResponseChunk.fire({ type: 'token', content: '\n\n*Nudging model to use tools...*\n\n' });
						continue;
					}
					break;
				}

				for (const toolCall of response.toolCalls) {
					this._onDidStateChange.fire('tool_executing');
					console.warn('[Q3Agent] Executing tool:', toolCall.function.name);

					// Check if approval is needed for destructive tools
					const destructiveTools = ['apply_edit', 'batch_edit', 'write_file', 'run_command', 'git_commit'];
					const autoApprove = this._configService.getValue<boolean>('q3.agent.autoApproveTools') ?? false;
					const editTools = ['apply_edit', 'batch_edit', 'write_file'];
					if (destructiveTools.includes(toolCall.function.name) && !autoApprove) {
						// Auto-approve edits to files already approved in this session
						let filePath = '';
						if (editTools.includes(toolCall.function.name)) {
							try {
								const parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
								filePath = (parsedArgs.path || '').toLowerCase().replace(/\\/g, '/');
							} catch {}
						}
						const alreadyApproved = filePath && this._approvedFiles.has(filePath);
						if (!alreadyApproved) {
							// Fire tool_approval instead of tool_call; wait for user approval
							const approved = await new Promise<boolean>((resolve) => {
								this._pendingApprovals.set(toolCall.id, { resolve });
								this._onDidResponseChunk.fire({
									type: 'tool_approval',
									toolName: toolCall.function.name,
									toolArgs: toolCall.function.arguments,
									toolCallId: toolCall.id,
								});
							});
							if (!approved) {
								const skippedResult = `Tool call ` + toolCall.function.name + ` was rejected by the user.`;
								this._onDidResponseChunk.fire({
									type: 'tool_result',
									toolName: toolCall.function.name,
									toolResult: skippedResult,
								});
								const toolMsg: IQ3ChatMessage = response.textParsedToolCalls
									? { role: 'user', content: `[Tool Result: ` + toolCall.function.name + `]` + skippedResult }
									: { role: 'tool', content: skippedResult, toolCallId: toolCall.id, toolName: toolCall.function.name };
								this._conversationHistory.push(toolMsg);
								messages.push(toolMsg);
								continue;
							}
							// Track approved file for auto-approve of subsequent edits
							if (filePath) {
								this._approvedFiles.add(filePath);
							}
						}
					}

					// Fire tool_call after approval (or for non-destructive tools)
					this._onDidResponseChunk.fire({
						type: 'tool_call',
						toolName: toolCall.function.name,
						toolArgs: toolCall.function.arguments,
						toolCallId: toolCall.id,
					});
const result = await this.executeTool(toolCall);
					console.warn('[Q3Agent] Tool', toolCall.function.name, 'result:', result.substring(0, 200));
					toolActions.push(`${toolCall.function.name}(${toolCall.function.arguments})`);
				if (readOnlyTools.includes(toolCall.function.name)) {
					consecutiveReads++;
				} else {
					consecutiveReads = 0;
				}
				if (consecutiveReads >= 3 && step < maxSteps - 2 && nudgeCount < maxNudges) {
					nudgeCount++;
					consecutiveReads = 0;
				console.warn('[Q3Agent] Model made 3+ consecutive read-only calls. Nudging to implement.');
					const readNudgeMsg: IQ3ChatMessage = {
						role: 'user',
					content: 'You have read enough files. You now have sufficient context to respond. If the user asked you to analyze or explain, provide your answer now. If the user asked for changes, use apply_edit or write_file to make them. Do not read any more files.'
					};
					messages.push(readNudgeMsg);
					this._conversationHistory.push(readNudgeMsg);
				this._onDidResponseChunk.fire({ type: 'token', content: '' });
				}
					this._onDidResponseChunk.fire({
						type: 'tool_result',
						toolName: toolCall.function.name,
						toolResult: result,
					});

					// Fire file_diff chunk for apply_edit, batch_edit and write_file
					if ((toolCall.function.name === 'apply_edit' || toolCall.function.name === 'batch_edit' || toolCall.function.name === 'write_file') && this._lastFileDiff) {
						this._lastFileDiff.toolCallId = toolCall.id;
						this._onDidResponseChunk.fire(this._lastFileDiff);
						this._lastFileDiff = undefined;
					}

					// Push full tool result to history - _trimHistory will truncate older ones as needed
					const toolMsg: IQ3ChatMessage = response.textParsedToolCalls
						? { role: 'user', content: `[Tool Result: ${toolCall.function.name}]\n${result}` }
						: { role: 'tool', content: result, toolCallId: toolCall.id, toolName: toolCall.function.name };
					this._conversationHistory.push(toolMsg);
					messages.push(toolMsg);
				}
			}

			this._onDidResponseChunk.fire({ type: 'done', content: JSON.stringify(this._totalUsage) });
		} catch (err: any) {
			if (!this._running) {
				// Cancelled by user - cancel() already fired done, suppress error
			} else {
				this._onDidResponseChunk.fire({ type: 'error', error: err?.message || String(err) });
			}
		} finally {
			this._running = false;
			this._onDidStateChange.fire('idle');
		}
	}

	private buildContext(request: IQ3AgentRequest): string {
		const parts: string[] = [];

		const rootPath = request.context?.workspaceRoot;

		if (request.context?.activeFile) {
			const f = request.context.activeFile;
			const relPath = rootPath && f.path.startsWith(rootPath)
				? f.path.substring(rootPath.length).replace(/^[\\\/]/, '')
				: f.path;
			parts.push(`Current file: ${relPath} (${f.language})`);
			if (f.cursorLine) {
				parts.push(`Cursor: line ${f.cursorLine}, column ${f.cursorColumn || 1}`);
			}
			if (f.selection) {
				parts.push(`Selected text:\n\`\`\`${f.language}\n${f.selection}\n\`\`\``);
			} else if (f.content) {
				const truncated = f.content.length > 3000 ? f.content.substring(0, 3000) + '\n... (truncated)' : f.content;
				parts.push(`File content:\n\`\`\`${f.language}\n${truncated}\n\`\`\``);
			}
		}

		if (request.context?.openTabs && request.context.openTabs.length > 0) {
			const tabs = request.context.openTabs.map(p => {
				const rel = rootPath && p.startsWith(rootPath)
					? p.substring(rootPath.length).replace(/^[\\\/]/, '')
					: p;
				return rel;
			});
			parts.push(`Open tabs: ${tabs.join(', ')}`);
		}

		if (rootPath) {
			parts.push(`Workspace root: ${rootPath}`);
		}

		if (parts.length > 0) {
			return parts.join('\n') + '\n\n';
		}
		return '';
	}

	private _trimHistory(): void {
		const MAX_TOKENS = 8000;
		const CHARS_PER_TOKEN = 4;
		const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;
		const MAX_TOOL_RESULT_CHARS = 3000;

		// Find the index of the last tool result message so we don't truncate it
		let lastToolResultIdx = -1;
		for (let i = this._conversationHistory.length - 1; i >= 0; i--) {
			const msg = this._conversationHistory[i];
			if (msg.role === 'tool' || (msg.role === 'user' && msg.content.startsWith('[Tool Result:'))) {
				lastToolResultIdx = i;
				break;
			}
		}

		// Truncate older tool results, but keep the most recent one intact
		for (let i = 0; i < this._conversationHistory.length; i++) {
			if (i === lastToolResultIdx) { continue; }
			const msg = this._conversationHistory[i];
			if ((msg.role === 'tool' || (msg.role === 'user' && msg.content.startsWith('[Tool Result:'))) && msg.content.length > MAX_TOOL_RESULT_CHARS) {
				msg.content = msg.content.substring(0, MAX_TOOL_RESULT_CHARS) + '\n... (truncated)';
			}
		}


		// Also truncate the most recent tool result if it's very large (keep head + tail)
		if (lastToolResultIdx >= 0) {
			const lastMsg = this._conversationHistory[lastToolResultIdx];
			if (lastMsg.content.length > MAX_TOOL_RESULT_CHARS * 2) {
				const headLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.6);
				const tailLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.3);
				lastMsg.content = lastMsg.content.substring(0, headLen)
					+ `\n... (truncated ${lastMsg.content.length - headLen - tailLen} chars) ...\n`
					+ lastMsg.content.substring(lastMsg.content.length - tailLen);
			}
		}
		// Then, drop oldest messages if over budget (keep system + last user message)
		let totalChars = this._conversationHistory.reduce((sum, m) => sum + m.content.length, 0);
		while (totalChars > MAX_CHARS && this._conversationHistory.length > 2) {
			const removed = this._conversationHistory.shift();
			if (removed) {
				totalChars -= removed.content.length;
			}
		}
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
				return await this.toolApplyEdit(args.path, args.old_string, args.new_string, args.replace_all ?? false);
			case 'batch_edit':
				return await this.toolBatchEdit(args.path, args.edits);
			case 'write_file':
				return await this.toolWriteFile(args.path, args.content);
			case 'run_command':
				return await this.toolRunCommand(args.command);
			case 'grep_search':
				return await this.toolGrepSearch(args.pattern, args.path, args.include);
			case 'git_status':
				return await this.toolGitStatus();
			case 'git_commit':
				return await this.toolGitCommit(args.message);
			case 'read_diagnostics':
				return await this.toolReadDiagnostics();
			default:
				return `Error: Unknown tool: ${toolCall.function.name}`;
		}
	}

	private async toolReadFile(path: string): Promise<string> {
		const cacheKey = path.toLowerCase().replace(/\\/g, '/');
		if (this._readFileCache.has(cacheKey)) {
			return this._readFileCache.get(cacheKey) + '\n[File already read - cached. Use apply_edit or write_file to make changes.]';
		}
		try {
			const uri = this.resolvePath(path);
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString().replace(/\r\n/g, '\n');
			const MAX_FILE_CHARS = 30000;
			if (text.length > MAX_FILE_CHARS) {
			const truncated = text.substring(0, MAX_FILE_CHARS) + '... (truncated at ' + MAX_FILE_CHARS + ' chars, total ' + text.length + ' chars)';
			this._readFileCache.set(cacheKey, truncated);
			return truncated;
			}
			this._readFileCache.set(cacheKey, text);
			return text;
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

	private async toolApplyEdit(path: string, oldString: string, newString: string, replaceAll: boolean): Promise<string> {
		try {
			const uri = this.resolvePath(path);
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();

			// Normalize line endings to LF for consistent processing
			const normalizedText = text.replace(/\r\n/g, '\n');

			// Run the multi-pass normalization pipeline to reconcile LLM text with on-disk text
			const normalized = normalizeEditStrings(normalizedText, oldString.replace(/\r\n/g, '\n'), newString.replace(/\r\n/g, '\n'));
			let finalOldString = normalized.oldString;
			let finalNewString = normalized.newString;

			// When deleting text, consume trailing newline to avoid leaving blank lines
			finalOldString = maybeAugmentOldStringForDeletion(normalizedText, finalOldString, finalNewString);

			// Count occurrences to determine if the edit can be applied
			const occurrences = countOccurrences(normalizedText, finalOldString);

			if (occurrences === 0) {
				const failCount = (this._applyEditFailures.get(path) || 0) + 1;
				this._applyEditFailures.set(path, failCount);
				const preview = text.substring(0, Math.min(3000, text.length));
				if (failCount >= 2) {
					return 'Error: old_string not found in ' + path + ' (attempt ' + failCount + '). The file may be corrupted from previous edits. STOP using apply_edit for this file. Use write_file to rewrite the ENTIRE file with the correct content. Here is the current file content:\n\n' + preview;
				}
				return 'Error: old_string not found in ' + path + '. Here is the beginning of the file content for reference:\n\n' + preview + '\n\nMake sure to copy the exact text from the file, including whitespace and indentation.';
			}

			if (!replaceAll && occurrences > 1) {
				return `Error: old_string matches ${occurrences} locations in ${path}. Provide more context to make the match unique, or set replace_all to true.`;
			}

			if (finalOldString === finalNewString) {
				return `Error: old_string and new_string are identical in ${path}. No changes to apply.`;
			}

			// Use safe literal replacement to avoid $ interpretation issues
			const newNormalizedText = safeLiteralReplace(normalizedText, finalOldString, finalNewString, replaceAll);

			if (newNormalizedText === normalizedText) {
				return `Error: replacement produced no changes in ${path}.`;
			}

			// Preserve original line ending style
			const hasCRLF = text.includes('\r\n');
			const finalText = hasCRLF ? newNormalizedText.replace(/\n/g, '\r\n') : newNormalizedText;

			await this._fileService.writeFile(uri, VSBuffer.fromString(finalText));
			this._lastFileDiff = this._computeDiff(path, text, finalText);
			this._readFileCache.delete(path.toLowerCase().replace(/\\/g, '/'));
			this._applyEditFailures.delete(path);

			// Build success message with optional snippet
			const snippet = extractEditSnippet(normalizedText, newNormalizedText);
			if (snippet) {
				return `Successfully edited ${path} (showing lines ${snippet.startLine}-${snippet.endLine} of ${snippet.totalLines})`;
			}
			return `Successfully edited ${path}`;
		} catch (err: any) {
			return `Error editing file: ${err?.message}`;
		}
	}

	private async toolWriteFile(path: string, content: string): Promise<string> {
		try {
			const uri = this.resolvePath(path);
			let oldText = '';
			try {
				const oldContent = await this._fileService.readFile(uri);
				oldText = oldContent.value.toString();
			} catch { /* file doesn't exist yet */ }
			await this._fileService.writeFile(uri, VSBuffer.fromString(content));
			this._lastFileDiff = this._computeDiff(path, oldText, content);
			this._readFileCache.delete(path.toLowerCase().replace(/\\/g, '/'));
			this._applyEditFailures.delete(path);
			return `Successfully wrote ${path}`;
		} catch (err: any) {
			return `Error writing file: ${err?.message}`;
		}
	}

	private async toolBatchEdit(path: string, edits: { old_string: string; new_string: string; replace_all?: boolean }[]): Promise<string> {
		try {
			const uri = this.resolvePath(path);
			const content = await this._fileService.readFile(uri);
			let text = content.value.toString();
			let normalizedText = text.replace(/\r\n/g, '\n');
			const results: string[] = [];
			let successCount = 0;
			let failCount = 0;

			for (let i = 0; i < edits.length; i++) {
				const edit = edits[i];
				const replaceAll = edit.replace_all ?? false;
				const normalized = normalizeEditStrings(normalizedText, edit.old_string.replace(/\r\n/g, '\n'), edit.new_string.replace(/\r\n/g, '\n'));
				let finalOldString = normalized.oldString;
				let finalNewString = normalized.newString;
				finalOldString = maybeAugmentOldStringForDeletion(normalizedText, finalOldString, finalNewString);
				const occurrences = countOccurrences(normalizedText, finalOldString);

				if (occurrences === 0) {
					failCount++;
					results.push(`Edit ${i + 1}: old_string not found`);
					break;
				}
				if (!replaceAll && occurrences > 1) {
					failCount++;
					results.push(`Edit ${i + 1}: old_string matches ${occurrences} locations`);
					break;
				}
				if (finalOldString === finalNewString) {
					results.push(`Edit ${i + 1}: identical, skipped`);
					continue;
				}
				const newText = safeLiteralReplace(normalizedText, finalOldString, finalNewString, replaceAll);
				if (newText === normalizedText) {
					results.push(`Edit ${i + 1}: no changes`);
					continue;
				}
				normalizedText = newText;
				successCount++;
				results.push(`Edit ${i + 1}: OK`);
			}

			if (successCount === 0) {
				return `Error: no edits applied to ${path}. ` + results.join('; ');
			}

			const hasCRLF = text.includes('\r\n');
			const finalText = hasCRLF ? normalizedText.replace(/\n/g, '\r\n') : normalizedText;
			await this._fileService.writeFile(uri, VSBuffer.fromString(finalText));
			this._lastFileDiff = this._computeDiff(path, text, finalText);
			this._readFileCache.delete(path.toLowerCase().replace(/\\/g, '/'));
			this._applyEditFailures.delete(path);
			return `Successfully applied ${successCount} of ${edits.length} edits to ${path}` + (failCount > 0 ? `. Failed: ` + results.filter(r => r.includes('not found') || r.includes('matches')).join('; ') : '');
		} catch (err: any) {
			return `Error in batch edit: ${err?.message}`;
		}
	}
	private _computeDiff(filePath: string, oldText: string, newText: string): IQ3AgentResponseChunk {
		const oldLines = oldText.split('\n');
		const newLines = newText.split('\n');
		const diffLines: { type: 'add' | 'del' | 'context'; text: string; oldLine?: number; newLine?: number }[] = [];
		const maxDiffLines = 200;
		let oldIdx = 0;
		let newIdx = 0;
		let added = 0;
		let removed = 0;

		// Simple LCS-based diff
		while (oldIdx < oldLines.length || newIdx < newLines.length) {
			if (diffLines.length >= maxDiffLines) { break; }
			if (oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] === newLines[newIdx]) {
				diffLines.push({ type: 'context', text: oldLines[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
				oldIdx++;
				newIdx++;
			} else if (oldIdx < oldLines.length && (newIdx >= newLines.length || oldLines[oldIdx] !== newLines[newIdx])) {
				// Check if this old line appears later in new text (it was removed)
				diffLines.push({ type: 'del', text: oldLines[oldIdx], oldLine: oldIdx + 1 });
				oldIdx++;
				removed++;
			} else if (newIdx < newLines.length) {
				diffLines.push({ type: 'add', text: newLines[newIdx], newLine: newIdx + 1 });
				newIdx++;
				added++;
			}
		}

		return { type: 'file_diff', filePath, diffLines, content: `+${added} -${removed}`, oldText, newText };
	}

	private async toolRunCommand(command: string): Promise<string> {
		try {
			const terminal = await this._terminalService.createTerminal({ config: { name: 'Q3 Agent' } });
			this._terminalService.setActiveInstance(terminal);
			terminal.sendText(command + ' 2>&1', true);
			return `Command sent to terminal: ${command}`;
		} catch (err: any) {
			return `Error running command: ${err?.message}`;
		}
	}

	private async toolGrepSearch(pattern: string, path: string, include?: string): Promise<string> {
		try {
			const uri = this.resolvePath(path);
			const regex = new RegExp(pattern, 'i');
			const results: string[] = [];
			const maxResults = 50;
			const includeGlob = include ? new RegExp(include.replace(/\*/g, '.*').replace(/\?/g, '.')) : null;

			const searchDir = async (dirUri: URI, depth: number): Promise<void> => {
				if (results.length >= maxResults || depth > 5) { return; }
				const stat = await this._fileService.resolve(dirUri);
				if (!stat.children) { return; }
				for (const child of stat.children) {
					if (results.length >= maxResults) { return; }
					if (child.isDirectory) {
						if (child.name.startsWith('.') || child.name === 'node_modules' || child.name === '.git') { continue; }
					await searchDir(child.resource, depth + 1);
				} else {
					if (includeGlob && !includeGlob.test(child.name)) { continue; }
					try {
						const content = await this._fileService.readFile(child.resource);
						const text = content.value.toString();
						const lines = text.split('\n');
						const relPath = child.resource.fsPath.replace(this._workspaceService.getWorkspace().folders[0]?.uri.fsPath || '', '').replace(/^[\\/]/, '');
						for (let i = 0; i < lines.length; i++) {
							if (results.length >= maxResults) { break; }
							if (regex.test(lines[i])) {
								results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
							}
						}
					} catch { /* skip unreadable files */ }
				}
			}
		};

			await searchDir(uri, 0);
			if (results.length === 0) { return 'No matches found.'; }
			return results.join('\n') + (results.length >= 50 ? '\n... (truncated at 50 results)' : '');
		} catch (err: any) {
			return `Error searching: ${err?.message}`;
		}
	}

	private async toolGitStatus(): Promise<string> {
		try {
			const terminal = await this._terminalService.createTerminal({ config: { name: 'Q3 Agent: Git' } });
			this._terminalService.setActiveInstance(terminal);
			terminal.sendText('git status --short 2>&1', true);
			return 'Git status command sent to terminal. Check terminal output for results.';
		} catch (err: any) {
			return `Error getting git status: ${err?.message}`;
		}
	}

	private async toolGitCommit(message: string): Promise<string> {
		try {
			const terminal = await this._terminalService.createTerminal({ config: { name: 'Q3 Agent: Git' } });
			this._terminalService.setActiveInstance(terminal);
			terminal.sendText(`git add -A && git commit -m "${message.replace(/"/g, '\\"')}" 2>&1`, true);
			return `Git commit command sent to terminal with message: ${message}`;
		} catch (err: any) {
			return `Error committing: ${err?.message}`;
		}
	}

	private async toolReadDiagnostics(): Promise<string> {
		try {
			const markers = this._markerService.read();
			if (markers.length === 0) { return 'No diagnostics found.'; }
			const results: string[] = [];
			const maxResults = 50;
			const rootPath = this._workspaceService.getWorkspace().folders[0]?.uri.fsPath || '';
			for (const marker of markers) {
				if (results.length >= maxResults) { break; }
				const relPath = marker.resource.fsPath.replace(rootPath, '').replace(/^[\\/]/, '');
				const severity = marker.severity === 8 ? 'ERROR' : marker.severity === 4 ? 'WARNING' : 'INFO';
				results.push(`${severity}: ${relPath}:${marker.startLineNumber} - ${marker.message}`);
			}
			return results.join('\n') + (markers.length > maxResults ? `\n... (${markers.length - maxResults} more not shown)` : '');
		} catch (err: any) {
			return `Error reading diagnostics: ${err?.message}`;
		}
	}

	private resolvePath(path: string): URI {
		if (path.startsWith('file://')) {
			return URI.parse(path);
		}
		// Check if it's an absolute path (Windows drive letter like d:\ or C:/, or Unix /)
		if (/^[a-zA-Z]:[\\\/]/.test(path) || path.startsWith('/')) {
			return URI.file(path);
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
