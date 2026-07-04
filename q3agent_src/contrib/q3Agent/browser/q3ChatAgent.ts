/*---------------------------------------------------------------------------------------------}
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentHistoryEntry } from '../../chat/common/participants/chatAgents.js';
import { IChatProgress, IChatMarkdownContent, IChatUsage, IChatProgressMessage, ToolConfirmKind } from '../../chat/common/chatService/chatService.js';
import { ChatToolInvocation } from '../../chat/common/model/chatProgressTypes/chatToolInvocation.js';
import { ToolDataSource, IToolData } from '../../chat/common/tools/languageModelToolsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQ3AgentService, IQ3AgentRequest, IQ3AgentResponseChunk } from '../../../services/q3Agent/common/q3Agent.js';

const Q3_TOOL_DATA: Record<string, IToolData> = {
	read_file: {
		id: 'q3_read_file',
		source: ToolDataSource.Internal,
		displayName: 'Read File',
		modelDescription: 'Read the contents of a file',
		canBeReferencedInPrompt: false,
	},
	list_dir: {
		id: 'q3_list_dir',
		source: ToolDataSource.Internal,
		displayName: 'List Directory',
		modelDescription: 'List the contents of a directory',
		canBeReferencedInPrompt: false,
	},
	apply_edit: {
		id: 'q3_apply_edit',
		source: ToolDataSource.Internal,
		displayName: 'Apply Edit',
		modelDescription: 'Apply a partial edit to an existing file',
		canBeReferencedInPrompt: false,
	},
	batch_edit: {
		id: 'q3_batch_edit',
		source: ToolDataSource.Internal,
		displayName: 'Batch Edit',
		modelDescription: 'Apply multiple edits to a single file',
		canBeReferencedInPrompt: false,
	},
	write_file: {
		id: 'q3_write_file',
		source: ToolDataSource.Internal,
		displayName: 'Write File',
		modelDescription: 'Create a new file or overwrite an existing file',
		canBeReferencedInPrompt: false,
	},
	run_command: {
		id: 'q3_run_command',
		source: ToolDataSource.Internal,
		displayName: 'Run Command',
		modelDescription: 'Run a shell command in the integrated terminal',
		canBeReferencedInPrompt: false,
	},
	grep_search: {
		id: 'q3_grep_search',
		source: ToolDataSource.Internal,
		displayName: 'Grep Search',
		modelDescription: 'Search for a text pattern in files',
		canBeReferencedInPrompt: false,
	},
	git_status: {
		id: 'q3_git_status',
		source: ToolDataSource.Internal,
		displayName: 'Git Status',
		modelDescription: 'Get the git status of the workspace',
		canBeReferencedInPrompt: false,
	},
	git_commit: {
		id: 'q3_git_commit',
		source: ToolDataSource.Internal,
		displayName: 'Git Commit',
		modelDescription: 'Stage all changes and create a git commit',
		canBeReferencedInPrompt: false,
	},
	read_diagnostics: {
		id: 'q3_read_diagnostics',
		source: ToolDataSource.Internal,
		displayName: 'Read Diagnostics',
		modelDescription: 'Read errors and warnings from the Problems panel',
		canBeReferencedInPrompt: false,
	},
};

export class Q3ChatAgent extends Disposable implements IChatAgentImplementation {

	constructor(
		@IQ3AgentService private readonly _agentService: IQ3AgentService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<IChatAgentResult> {
		const q3Request = this._buildRequest(request);

		const chunkQueue: IQ3AgentResponseChunk[] = [];
		let done = false;
		let error: string | undefined;
		let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

		const chunkHandler = (chunk: IQ3AgentResponseChunk) => {
			chunkQueue.push(chunk);
		};

		const chunkDisposable: IDisposable = this._agentService.onDidResponseChunk(chunkHandler);

		const tokenListener = token.onCancellationRequested(() => {
			this._agentService.cancel();
		});

		try {
			const sendPromise = this._agentService.send(q3Request);

			while (!done && !token.isCancellationRequested) {
				if (chunkQueue.length > 0) {
					const chunk = chunkQueue.shift()!;
					this._processChunk(chunk, progress, request);
					if (chunk.type === 'done') {
						done = true;
						if (chunk.content) {
							try { usage = JSON.parse(chunk.content); } catch {}
						}
					} else if (chunk.type === 'error') {
						done = true;
						error = chunk.error;
					}
				} else {
					await new Promise(resolve => setTimeout(resolve, 10));
				}
			}

			await sendPromise;
		} finally {
			tokenListener.dispose();
			chunkDisposable.dispose();
		}

		if (usage) {
			progress([{
				kind: 'usage',
				promptTokens: usage.promptTokens,
				completionTokens: usage.completionTokens,
			} as IChatUsage]);
		}

		if (error) {
			return {
				errorDetails: { message: error },
			};
		}

		return {};
	}

	private _buildRequest(request: IChatAgentRequest): IQ3AgentRequest {
		const context: IQ3AgentRequest['context'] = {};

		const activeEditor = this._editorService.activeTextEditorControl;
		if (activeEditor) {
			const model = (activeEditor as any).getModel?.();
			if (model) {
				const selection = (activeEditor as any).getSelection?.();
				const selectedText = selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined;
				const position = (activeEditor as any).getPosition?.();
				context.activeFile = {
					path: model.uri.fsPath,
					content: model.getValue(),
					language: model.getLanguageId(),
					selection: selectedText,
					cursorLine: position?.lineNumber,
					cursorColumn: position?.column,
				};
			}
		}

		const openEditors = this._editorService.getEditors(0 /* MOST_RECENTLY_ACTIVE */);
		if (openEditors && openEditors.length > 0) {
			context.openTabs = openEditors
				.map((e: { editor: { resource?: { fsPath?: string } } }) => e.editor.resource?.fsPath)
				.filter((p: string | undefined): p is string => !!p)
				.slice(0, 20);
		}

		const workspace = this._workspaceService.getWorkspace();
		if (workspace.folders.length > 0) {
			context.workspaceRoot = workspace.folders[0].uri.fsPath;
		}

		return { prompt: request.message, context };
	}

	private _processChunk(chunk: IQ3AgentResponseChunk, progress: (parts: IChatProgress[]) => void, request: IChatAgentRequest): void {
		switch (chunk.type) {
			case 'token': {
				if (chunk.content) {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(chunk.content),
					} as IChatMarkdownContent]);
				}
				break;
			}
			case 'step': {
				if (chunk.content) {
					progress([{
						kind: 'progressMessage',
						content: new MarkdownString(chunk.content),
					} as IChatProgressMessage]);
				}
				break;
			}
			case 'tool_call': {
				const toolName = chunk.toolName || 'unknown';
				const toolData = Q3_TOOL_DATA[toolName] ?? {
					id: `q3_${toolName}`,
					source: ToolDataSource.Internal,
					displayName: toolName,
					modelDescription: '',
					canBeReferencedInPrompt: false,
				};

				let parameters: unknown = {};
				try { parameters = JSON.parse(chunk.toolArgs || '{}'); } catch {}

				const invocation = new ChatToolInvocation(
					undefined,
					toolData,
					chunk.toolCallId || `${toolName}-${Date.now()}`,
					undefined,
					parameters,
				);
				invocation.invocationMessage = `Calling ${toolName}`;

				const autoApprove = this._configService.getValue<boolean>('q3.agent.autoApproveTools') ?? false;
				const destructiveTools = ['apply_edit', 'batch_edit', 'write_file', 'run_command', 'git_commit'];
				if (destructiveTools.includes(toolName) && !autoApprove) {
					invocation.confirmationMessages = {
						title: `Approve ${toolName}?`,
						message: `The agent wants to execute ${toolName} with arguments: ${chunk.toolArgs || '{}'}`,
					};
					const state = invocation.state.get();
					if (state.type === 1 /* IChatToolInvocation.StateKind.WaitingForConfirmation */) {
						const waitingState = state as { confirm: (reason: { type: ToolConfirmKind }) => void };
						const originalConfirm = waitingState.confirm;
						waitingState.confirm = (reason: { type: ToolConfirmKind }) => {
							originalConfirm(reason);
							if (reason.type === ToolConfirmKind.ConfirmationNotNeeded || reason.type === ToolConfirmKind.Setting || reason.type === ToolConfirmKind.LmServicePerTool || reason.type === ToolConfirmKind.UserAction) {
								this._agentService.resolveApproval(chunk.toolCallId!, true);
							} else {
								this._agentService.resolveApproval(chunk.toolCallId!, false);
							}
						};
					}
				}

				progress([invocation]);
				break;
			}
			case 'tool_result': {
				break;
			}
			case 'tool_approval': {
				break;
			}
			case 'file_diff': {
				break;
			}
			case 'status': {
				if (chunk.content) {
					progress([{
						kind: 'progressMessage',
						content: new MarkdownString(chunk.content),
					} as IChatProgressMessage]);
				}
				break;
			}
			case 'done':
			case 'error':
				break;
		}
	}
}
