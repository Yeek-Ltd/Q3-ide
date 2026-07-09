/*---------------------------------------------------------------------------------------------}
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentHistoryEntry } from '../../chat/common/participants/chatAgents.js';
import { IChatProgress, IChatMarkdownContent, IChatUsage, IChatProgressMessage } from '../../chat/common/chatService/chatService.js';
import { ChatToolInvocation } from '../../chat/common/model/chatProgressTypes/chatToolInvocation.js';
import { ToolDataSource, IToolData } from '../../chat/common/tools/languageModelToolsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Q3InlineDiffController, IQ3PendingEdit } from './q3InlineDiffController.js';
import { IQ3AgentService, IQ3AgentRequest, IQ3AgentResponseChunk } from '../../../services/q3Agent/common/q3Agent.js';
import './media/q3Agent.css';

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

	private _inlineDiffController: Q3InlineDiffController;

	constructor(
		@IQ3AgentService private readonly _agentService: IQ3AgentService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
	) {
		super();
		this._inlineDiffController = this._register(new Q3InlineDiffController());
		this._inlineDiffController.setApprovalCallbacks(
			(toolCallId: string) => this._agentService.resolveApproval(toolCallId, true),
			(toolCallId: string) => this._agentService.resolveApproval(toolCallId, false),
		);
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

			let accumulatedText = '';
			let lastFlushedLen = 0;

			const flushText = () => {
				const delta = accumulatedText.substring(lastFlushedLen);
				if (delta) {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(delta),
					} as IChatMarkdownContent]);
					lastFlushedLen = accumulatedText.length;
				}
			};

			while (!done && !token.isCancellationRequested) {
				if (chunkQueue.length > 0) {
					const chunk = chunkQueue.shift()!;

					if (chunk.type === 'token') {
						if (chunk.content) {
							accumulatedText += chunk.content;
							flushText();
						}
					} else {
						flushText();
						accumulatedText = '';
						lastFlushedLen = 0;
						this._processChunk(chunk, progress, request);
					}

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

			flushText();
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
					{ invocationMessage: `Calling ${toolName}` },
					toolData,
					chunk.toolCallId || `${toolName}-${Date.now()}`,
					undefined,
					parameters,
				);

				progress([invocation]);
				break;
			}
			case 'tool_result': {
				break;
			}
			case 'tool_approval': {
				const toolName = chunk.toolName || 'unknown';
				progress([{
					kind: 'progressMessage',
					content: new MarkdownString(`Approving ${toolName}...`),
				} as IChatProgressMessage]);
				break;
			}
			case 'file_diff': {
				if (!chunk.diffLines || chunk.diffLines.length === 0) { break; }

				const filePath = chunk.filePath || 'unknown';

				let added = 0;
				let removed = 0;
				const lineHtml: string[] = [];
				for (const line of chunk.diffLines) {
					const escaped = line.text
						.replace(/&/g, '&amp;')
						.replace(/</g, '&lt;')
						.replace(/>/g, '&gt;');
					if (line.type === 'add') {
						added++;
						lineHtml.push(`<div class="q3-agent-diff-line-add"><span class="q3-agent-diff-marker">+</span><code>${escaped}</code></div>`);
					} else if (line.type === 'del') {
						removed++;
						lineHtml.push(`<div class="q3-agent-diff-line-del"><span class="q3-agent-diff-marker">-</span><code>${escaped}</code></div>`);
					} else {
						lineHtml.push(`<div class="q3-agent-diff-line-context"><span class="q3-agent-diff-marker">&nbsp;</span><code>${escaped}</code></div>`);
					}
				}

				const header = `### ${filePath} \`+${added} -${removed}\`\n\n`;
				const diffHtml = `<div class="q3-agent-diff-preview"><div class="q3-agent-diff-table">${lineHtml.join('')}</div></div>\n\n`;
				const openLink = `[Open ${filePath.split('/').pop()}](command:workbench.action.files.openFile?${encodeURIComponent(JSON.stringify({ filePath }))})\n`;

				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(header + diffHtml + openLink, { supportHtml: true, isTrusted: true }),
				} as IChatMarkdownContent]);

				if (chunk.filePath && chunk.oldText !== undefined && chunk.newText !== undefined) {
					this._showInlineDiffInEditor(chunk.filePath, chunk.oldText, chunk.newText, chunk.toolCallId || '');
				}
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

	private _getLanguageFromPath(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase() || '';
		const langMap: Record<string, string> = {
			ts: 'typescript', js: 'javascript', jsx: 'javascript', tsx: 'typescript',
			py: 'python', java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp',
			go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
			kt: 'kotlin', scala: 'scala', sh: 'shell', bash: 'shell',
			html: 'html', css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', yml: 'yaml',
			md: 'markdown', xml: 'xml', sql: 'sql', dart: 'dart', lua: 'lua',
		};
		return langMap[ext] || 'text';
	}

	private async _showInlineDiffInEditor(filePath: string, oldText: string, newText: string, toolCallId: string): Promise<void> {
		if (!filePath) { return; }
		try {
			let uri: URI;
			if (filePath.startsWith('/') || filePath.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(filePath)) {
				uri = URI.file(filePath);
			} else {
				const workspace = this._workspaceService.getWorkspace();
				const root = workspace.folders[0]?.uri;
				if (!root) { return; }
				uri = joinPath(root, filePath);
			}
			await this._editorService.openEditor({ resource: uri });
			const codeEditor = this._codeEditorService.getActiveCodeEditor();
			if (!codeEditor) { return; }
			const edit: IQ3PendingEdit = { filePath, oldText, newText, toolCallId };
			this._inlineDiffController.showDiff(codeEditor, edit);
		} catch (e) {
			console.warn('[Q3ChatAgent] Failed to show inline diff in editor:', e);
		}
	}
}
