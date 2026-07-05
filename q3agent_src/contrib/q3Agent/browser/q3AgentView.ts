/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/q3Agent.css';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IQ3AgentService, IQ3AgentResponseChunk, IQ3ModelService, IQ3LlamaCppService } from '../../../services/q3Agent/common/q3Agent.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Q3InlineDiffController, IQ3PendingEdit } from './q3InlineDiffController.js';

interface ChatMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	toolName?: string;
}

export class Q3AgentViewPane extends ViewPane {
	private _chatContainer!: HTMLElement;
	private _inputBox!: HTMLTextAreaElement;
	private _sendButton!: HTMLButtonElement;
	private _stopButton!: HTMLButtonElement;
	private _modelSelector!: HTMLSelectElement;
	private _backendStatusEl!: HTMLElement;
	private _browsePanelVisible = false;
	private _modelBrowserEl!: HTMLElement;
	private _browseButton!: HTMLButtonElement;
	private _messages: ChatMessage[] = [];
	private _currentAssistantEl: HTMLElement | undefined;
	private _currentAssistantText: string = '';
	private _currentToolActivityEl: HTMLElement | undefined;
	private _currentToolActivityCount: number = 0;
	private _currentThoughtEl: HTMLElement | undefined;
	private readonly _disposables = new DisposableStore();
	private _inlineDiffController: Q3InlineDiffController | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IQ3AgentService private readonly _agentService: IQ3AgentService,
		@IQ3ModelService private readonly _modelService: IQ3ModelService,
		@IQ3LlamaCppService private readonly _llamaCppService: IQ3LlamaCppService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IMarkdownRendererService private readonly _markdownRendererService: IMarkdownRendererService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._inlineDiffController = new Q3InlineDiffController();
		this._register(this._inlineDiffController);
		this._inlineDiffController.setApprovalCallbacks(
			(toolCallId: string) => this._agentService.resolveApproval(toolCallId, true),
			(toolCallId: string) => this._agentService.resolveApproval(toolCallId, false),
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = container;
		root.classList.add('q3-agent');

		// Backend selector + model selector bar
		const toolbar = document.createElement('div');
		toolbar.classList.add('q3-agent-toolbar');
		root.appendChild(toolbar);

		// Engine label
		const backendLabel = document.createElement('span');
		backendLabel.textContent = 'Engine: ik_llama.cpp';
		backendLabel.classList.add('q3-agent-model-label');
		toolbar.appendChild(backendLabel);

		// Backend status indicator
		this._backendStatusEl = document.createElement('span');
		this._backendStatusEl.classList.add('q3-agent-backend-status');
		this._backendStatusEl.textContent = '●';
		toolbar.appendChild(this._backendStatusEl);

		const divider = document.createElement('span');
		divider.classList.add('q3-agent-toolbar-divider');
		toolbar.appendChild(divider);

		const modelLabel = document.createElement('span');
		modelLabel.textContent = 'Model: ';
		modelLabel.classList.add('q3-agent-model-label');
		toolbar.appendChild(modelLabel);

		this._modelSelector = document.createElement('select');
		this._modelSelector.classList.add('q3-agent-model-selector');
		this._modelSelector.addEventListener('change', () => {
			this._modelService.setCurrentModel(this._modelSelector.value);
		});
		toolbar.appendChild(this._modelSelector);

		this._browseButton = document.createElement('button');
		this._browseButton.classList.add('q3-agent-browse-button');
		this._browseButton.textContent = '+';
		this._browseButton.title = 'Browse and download models';
		this._browseButton.addEventListener('click', () => this._toggleModelBrowser());
		toolbar.appendChild(this._browseButton);

		this._refreshModels();

		// Listen for model changes
		this._disposables.add(this._modelService.onDidModelsChange(() => this._refreshModels()));

		// Model browser panel (hidden by default)
		this._modelBrowserEl = document.createElement('div');
		this._modelBrowserEl.classList.add('q3-agent-model-browser');
		this._modelBrowserEl.style.display = 'none';
		root.appendChild(this._modelBrowserEl);

		// Chat container
		this._chatContainer = document.createElement('div');
		this._chatContainer.classList.add('q3-agent-chat');
		root.appendChild(this._chatContainer);

		// Welcome message
		this._addMessage({ role: 'assistant', content: 'Welcome to Q3 Agent! I\'m powered by Qwen 3 Coder running locally via ik_llama.cpp. Ask me anything about your code.' });

		// Subscribe to llama.cpp state changes
		this._disposables.add(this._llamaCppService.onDidStateChange(state => this._updateBackendStatus(state)));

		// Subscribe to status messages from llama-swap service (warm-up, loading, etc.)
		this._disposables.add(this._llamaCppService.onDidStatusMessage(msg => this._addStatusMessage(msg)));

		// Input area
		const inputArea = document.createElement('div');
		inputArea.classList.add('q3-agent-input-area');
		root.appendChild(inputArea);

		this._inputBox = document.createElement('textarea');
		this._inputBox.classList.add('q3-agent-input');
		this._inputBox.placeholder = 'Ask Q3 Agent... (Enter to send, Shift+Enter for newline)';
		this._inputBox.rows = 3;
		this._inputBox.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._sendMessage();
			}
		});
		inputArea.appendChild(this._inputBox);

		const buttonRow = document.createElement('div');
		buttonRow.classList.add('q3-agent-button-row');
		inputArea.appendChild(buttonRow);

		this._sendButton = document.createElement('button');
		this._sendButton.classList.add('q3-agent-send-button');
		this._sendButton.textContent = 'Send';
		this._sendButton.addEventListener('click', () => this._sendMessage());
		buttonRow.appendChild(this._sendButton);

		this._stopButton = document.createElement('button');
		this._stopButton.classList.add('q3-agent-stop-button');
		this._stopButton.textContent = 'Stop';
		this._stopButton.style.display = 'none';
		this._stopButton.addEventListener('click', () => this._agentService.cancel());
		buttonRow.appendChild(this._stopButton);

		// Subscribe to agent events
		this._disposables.add(this._agentService.onDidResponseChunk(chunk => this._handleChunk(chunk)));
		this._disposables.add(this._agentService.onDidStateChange(state => this._handleStateChange(state)));
		this._disposables.add(this._modelService.onDidModelsChange(() => this._refreshModels()));
	}

	private _toggleModelBrowser(): void {
		this._browsePanelVisible = !this._browsePanelVisible;
		this._modelBrowserEl.style.display = this._browsePanelVisible ? '' : 'none';
		if (this._browsePanelVisible) {
			this._renderModelBrowser();
		}
	}

	private _renderModelBrowser(): void {
		this._modelBrowserEl.replaceChildren();

		const presets = this._modelService.getModelPresets();

		const header = document.createElement('div');
		header.classList.add('q3-agent-model-browser-header');
		header.textContent = 'Available Models';
		this._modelBrowserEl.appendChild(header);

		let lastCategory = '';
		const categoryLabels: Record<string, string> = {
			coder: 'Coding',
			general: 'General',
			reasoning: 'Reasoning',
		};

		for (const preset of presets) {
			if (preset.category !== lastCategory) {
				lastCategory = preset.category;
				const catHeader = document.createElement('div');
				catHeader.classList.add('q3-agent-model-category-header');
				catHeader.textContent = categoryLabels[preset.category] || preset.category;
				this._modelBrowserEl.appendChild(catHeader);
			}

			const row = document.createElement('div');
			row.classList.add('q3-agent-model-preset');
			if (preset.cloud) {
				row.classList.add('q3-agent-model-preset-cloud');
			}

			const info = document.createElement('div');
			info.classList.add('q3-agent-model-preset-info');

			const nameEl = document.createElement('div');
			nameEl.classList.add('q3-agent-model-preset-name');
			nameEl.textContent = preset.displayName;
			info.appendChild(nameEl);

			const descEl = document.createElement('div');
			descEl.classList.add('q3-agent-model-preset-desc');
			descEl.textContent = preset.description;
			info.appendChild(descEl);

			const sizeEl = document.createElement('div');
			sizeEl.classList.add('q3-agent-model-preset-size');
			sizeEl.textContent = preset.size;
			info.appendChild(sizeEl);

			row.appendChild(info);

			const actions = document.createElement('div');
			actions.classList.add('q3-agent-model-preset-actions');

			const useBtn = document.createElement('button');
			useBtn.classList.add('q3-agent-model-use-button');
			useBtn.textContent = 'Use';
			useBtn.addEventListener('click', () => {
				this._modelService.setCurrentModel(preset.name);
				this._toggleModelBrowser();
			});
			actions.appendChild(useBtn);

			if (!preset.cloud) {
				const pullBtn = document.createElement('button');
				pullBtn.classList.add('q3-agent-model-pull-button');
				pullBtn.textContent = 'Download';
				pullBtn.addEventListener('click', async () => {
					pullBtn.disabled = true;
					pullBtn.textContent = 'Downloading...';
					try {
						await this._modelService.pullModel(preset.name);
						pullBtn.textContent = 'Done';
					} catch (e: any) {
						pullBtn.textContent = 'Failed';
					}
				});
				actions.appendChild(pullBtn);
			} else {
				const cloudLabel = document.createElement('span');
				cloudLabel.classList.add('q3-agent-model-cloud-label');
				cloudLabel.textContent = 'â˜ Cloud';
				actions.appendChild(cloudLabel);
			}

			row.appendChild(actions);
			this._modelBrowserEl.appendChild(row);
		}
	}

	private async _refreshModels(): Promise<void> {
		await this._refreshModelsLlamaCpp();
	}

	private async _refreshModelsLlamaCpp(): Promise<void> {
		this._modelSelector.replaceChildren();

		const current = this._modelService.getCurrentModel();
		const addedModels = new Set<string>();

		// 1. Try querying /v1/models from the server (works even if service state is stale)
		try {
			const endpoint = this._llamaCppService.getEndpoint();
			const res = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(3000) });
			if (res.ok) {
				const data = await res.json() as any;
				const models: any[] = data.data || [];
				for (const m of models) {
					const name = m.id || m.name;
					if (name && !addedModels.has(name)) {
						const opt = document.createElement('option');
						opt.value = name;
						opt.textContent = name;
						if (name === current) { opt.selected = true; }
						this._modelSelector.appendChild(opt);
						addedModels.add(name);
					}
				}
			}
		} catch {
			// Server not reachable, fall through to local files
		}

		// 2. Add local GGUF files
		const localFiles = this._modelService.listLocalGGUFModels();
		for (const file of localFiles) {
			if (!addedModels.has(file)) {
				const opt = document.createElement('option');
				opt.value = file;
				opt.textContent = file;
				if (file === current) { opt.selected = true; }
				this._modelSelector.appendChild(opt);
				addedModels.add(file);
			}
		}

		// 3. Always show the configured model from settings
		if (current && !addedModels.has(current)) {
			const opt = document.createElement('option');
			opt.value = current;
				opt.textContent = current;
				opt.selected = true;
			this._modelSelector.appendChild(opt);
			addedModels.add(current);
		}

		// 4. If nothing was added, show placeholder
		if (addedModels.size === 0) {
			const opt = document.createElement('option');
			opt.value = '';
			opt.textContent = 'No model configured';
			this._modelSelector.appendChild(opt);
		}

		// Update backend status based on whether server is reachable
		try {
			const endpoint = this._llamaCppService.getEndpoint();
			const res = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(2000) });
			this._updateBackendStatus(res.ok ? 'running' : 'stopped');
		} catch {
			this._updateBackendStatus('stopped');
		}
	}

	private _updateBackendStatus(state: 'stopped' | 'starting' | 'running' | 'error'): void {
		this._backendStatusEl.classList.remove('q3-agent-backend-status-running', 'q3-agent-backend-status-stopped', 'q3-agent-backend-status-starting', 'q3-agent-backend-status-error');
		this._backendStatusEl.classList.add(`q3-agent-backend-status-${state}`);
		this._backendStatusEl.title = `Engine: ${state}`;
	}

	private _sendMessage(): void {
		const text = this._inputBox.value.trim();
		if (!text || this._agentService.isRunning()) { return; }

		this._addMessage({ role: 'user', content: text });
		this._inputBox.value = '';

		this._currentAssistantText = '';
		this._currentThoughtEl = undefined;
		this._streamingPendingText = '';
		this._showThoughtIndicator();
		this._updateThoughtText('Thinking...');

		// Gather context
		const activeEditor = this._editorService.activeTextEditorControl;
		const context: any = {};
		if (activeEditor) {
			const model = activeEditor.getModel() as ITextModel | undefined;
			if (model) {
				const selection = activeEditor.getSelection();
				const selectedText = selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined;
				const position = activeEditor.getPosition();
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

		// Add open tabs
		const openEditors = this._editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		if (openEditors && openEditors.length > 0) {
			context.openTabs = openEditors
				.map(e => e.editor.resource?.fsPath)
				.filter((p): p is string => !!p)
				.slice(0, 20);
		}

		// Add workspace root context
		const workspace = this._workspaceService.getWorkspace();
		if (workspace.folders.length > 0) {
			context.workspaceRoot = workspace.folders[0].uri.fsPath;
		}

		this._agentService.send({ prompt: text, context });
	}

	private _addMessage(msg: ChatMessage): void {
		this._messages.push(msg);
		const el = this._createMessageElement(msg);
		this._chatContainer.appendChild(el);
		this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
	}

	private _addStatusMessage(text: string): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.classList.add('q3-agent-message', 'q3-agent-message-system');
		const avatar = document.createElement('div');
		avatar.classList.add('q3-agent-message-avatar');
		avatar.textContent = '⚙';
		wrapper.appendChild(avatar);
		const content = document.createElement('div');
		content.classList.add('q3-agent-message-content');
		const textEl = document.createElement('div');
		textEl.classList.add('q3-agent-message-text', 'q3-agent-status-text');
		textEl.textContent = text;
		content.appendChild(textEl);
		wrapper.appendChild(content);
		this._chatContainer.appendChild(wrapper);
		this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
		return wrapper;
	}

	private _createMessageElement(msg: ChatMessage): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.classList.add('q3-agent-message', `q3-agent-message-${msg.role}`);

		const avatar = document.createElement('div');
		avatar.classList.add('q3-agent-message-avatar');
		avatar.textContent = msg.role === 'user' ? 'U' : msg.role === 'tool' ? 'T' : 'Q3';
		wrapper.appendChild(avatar);

		const content = document.createElement('div');
		content.classList.add('q3-agent-message-content');

		if (msg.toolName) {
			const toolLabel = document.createElement('div');
			toolLabel.classList.add('q3-agent-tool-label');
			toolLabel.textContent = `Tool: ${msg.toolName}`;
			content.appendChild(toolLabel);
		}

		const textEl = document.createElement('div');
		textEl.classList.add('q3-agent-message-text');
		this._renderMarkdownInto(textEl, msg.content);
		content.appendChild(textEl);

		if (msg.role === 'assistant' && msg.content) {
			const actions = document.createElement('div');
			actions.classList.add('q3-agent-message-actions');
			const copyBtn = document.createElement('button');
			copyBtn.classList.add('q3-agent-copy-button');
			copyBtn.textContent = 'Copy';
			copyBtn.addEventListener('click', () => {
				const textToCopy = msg.content;
				navigator.clipboard.writeText(textToCopy).then(() => {
					copyBtn.textContent = 'Copied!';
					setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
				});
			});
			actions.appendChild(copyBtn);
			content.appendChild(actions);
		}

		wrapper.appendChild(content);
		return wrapper;
	}

	private _markdownDisposables: IDisposable[] = [];

	private _renderMarkdownInto(target: HTMLElement, text: string): void {
		target.replaceChildren();

		const md: IMarkdownString = {
			value: text,
			isTrusted: true,
			supportHtml: true,
		};

		const rendered = this._markdownRendererService.render(md, {}, target);
		this._markdownDisposables.push(rendered);

		// Add copy buttons to code blocks
		const codeBlocks = target.querySelectorAll('pre > code');
		codeBlocks.forEach((codeEl) => {
			const pre = codeEl.parentElement as HTMLElement;
			if (!pre) { return; }

			const wrapper = document.createElement('div');
			wrapper.classList.add('q3-agent-code-wrapper');

			const header = document.createElement('div');
			header.classList.add('q3-agent-code-header');

			const langLabel = document.createElement('span');
			langLabel.classList.add('q3-agent-code-lang');
			langLabel.textContent = codeEl.className || 'code';
			header.appendChild(langLabel);

			const codeText = codeEl.textContent || '';
			const applyBtn = document.createElement('button');
			applyBtn.classList.add('q3-agent-apply-button');
			applyBtn.textContent = 'Apply';
			applyBtn.addEventListener('click', () => this._applyCode(codeText));
			header.appendChild(applyBtn);

			const copyBtn = document.createElement('button');
			copyBtn.classList.add('q3-agent-code-copy-button');
			copyBtn.textContent = 'Copy';
			copyBtn.addEventListener('click', () => {
				navigator.clipboard.writeText(codeText).then(() => {
					copyBtn.textContent = 'Copied!';
					setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
				});
			});
			header.appendChild(copyBtn);

			pre.parentElement?.insertBefore(wrapper, pre);
			wrapper.appendChild(header);
			wrapper.appendChild(pre);
		});
	}

	private _applyCode(code: string): void {
		const editor = this._editorService.activeEditorPane?.getControl() as any;
		if (editor && typeof editor.executeEdits === 'function') {
			const selection = editor.getSelection();
			editor.executeEdits('q3-agent', [{
				range: selection,
				text: code,
			}]);
			editor.focus();
		}
	}

	private _getLanguageFromPath(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase() || '';
		const langMap: Record<string, string> = {
			ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
			py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
			cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
			scala: 'scala', sh: 'bash', bash: 'bash', ps1: 'powershell',
			json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
			xml: 'xml', html: 'html', css: 'css', scss: 'scss', less: 'less',
			md: 'markdown', sql: 'sql', dockerfile: 'dockerfile',
			vue: 'vue', svelte: 'svelte', lua: 'lua', r: 'r',
		};
		return langMap[ext] || 'text';
	}

	private _computeDiffLines(oldText: string, newText: string): { type: 'add' | 'del' | 'context'; text: string; oldLine?: number; newLine?: number }[] {
		const oldLines = oldText.split('\n');
		const newLines = newText.split('\n');
		const diffLines: { type: 'add' | 'del' | 'context'; text: string; oldLine?: number; newLine?: number }[] = [];
		const maxDiffLines = 200;
		let oldIdx = 0;
		let newIdx = 0;

		while (oldIdx < oldLines.length || newIdx < newLines.length) {
			if (diffLines.length >= maxDiffLines) { break; }
			if (oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] === newLines[newIdx]) {
				diffLines.push({ type: 'context', text: oldLines[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
				oldIdx++;
				newIdx++;
			} else if (oldIdx < oldLines.length && (newIdx >= newLines.length || oldLines[oldIdx] !== newLines[newIdx])) {
				diffLines.push({ type: 'del', text: oldLines[oldIdx], oldLine: oldIdx + 1 });
				oldIdx++;
			} else if (newIdx < newLines.length) {
				diffLines.push({ type: 'add', text: newLines[newIdx], newLine: newIdx + 1 });
				newIdx++;
			}
		}

		return diffLines;
	}

	private _renderDiffTable(filePath: string, oldText: string, newText: string): HTMLElement {
		const diffLines = this._computeDiffLines(oldText, newText);
		let added = 0;
		let removed = 0;
		for (const l of diffLines) {
			if (l.type === 'add') { added++; }
			else if (l.type === 'del') { removed++; }
		}

		const container = document.createElement('div');
		container.classList.add('q3-agent-diff-preview');

		const statsEl = document.createElement('div');
		statsEl.classList.add('q3-agent-diff-preview-stats');
		const addSpan = document.createElement('span');
		addSpan.classList.add('q3-agent-diff-stats-add');
		addSpan.textContent = `+${added}`;
		const delSpan = document.createElement('span');
		delSpan.classList.add('q3-agent-diff-stats-del');
		delSpan.textContent = `-${removed}`;
		statsEl.appendChild(addSpan);
		statsEl.appendChild(delSpan);
		container.appendChild(statsEl);

		const table = document.createElement('table');
		table.classList.add('q3-agent-diff-table');

		const lang = this._getLanguageFromPath(filePath);

		for (const line of diffLines) {
			const tr = document.createElement('tr');
			tr.classList.add(`q3-agent-diff-line-${line.type}`);

			const oldNum = document.createElement('td');
			oldNum.classList.add('q3-agent-diff-line-num');
			oldNum.textContent = line.oldLine !== undefined ? String(line.oldLine) : '';
			tr.appendChild(oldNum);

			const newNum = document.createElement('td');
			newNum.classList.add('q3-agent-diff-line-num');
			newNum.textContent = line.newLine !== undefined ? String(line.newLine) : '';
			tr.appendChild(newNum);

			const marker = document.createElement('td');
			marker.classList.add('q3-agent-diff-marker');
			marker.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
			tr.appendChild(marker);

			const code = document.createElement('td');
			code.classList.add('q3-agent-diff-code');
			const codeEl = document.createElement('code');
			codeEl.classList.add(`language-${lang}`);
			codeEl.textContent = line.text;
			code.appendChild(codeEl);
			tr.appendChild(code);

			table.appendChild(tr);
		}

		container.appendChild(table);

		// Syntax highlighting is handled by CSS classes on the code elements
		// (language-xxx class triggers HighlightJS if available)

		return container;
	}

	private _getOrCreateToolActivityContainer(): HTMLElement {
		if (this._currentToolActivityEl && this._currentToolActivityEl.isConnected) {
			return this._currentToolActivityEl;
		}

		const wrapper = document.createElement('div');
		wrapper.classList.add('q3-agent-tool-activity');

		const header = document.createElement('div');
		header.classList.add('q3-agent-tool-activity-header');

		const icon = document.createElement('span');
		icon.classList.add('q3-agent-tool-activity-icon');
		icon.textContent = '\u25BC';
		header.appendChild(icon);

		const label = document.createElement('span');
		label.classList.add('q3-agent-tool-activity-label');
		label.textContent = 'Tool Activity';
		header.appendChild(label);

		const count = document.createElement('span');
		count.classList.add('q3-agent-tool-activity-count');
		count.textContent = '(0)';
		header.appendChild(count);

		wrapper.appendChild(header);

		const inner = document.createElement('div');
		inner.classList.add('q3-agent-tool-activity-inner');
		wrapper.appendChild(inner);

		header.addEventListener('click', () => {
			const isExpanded = inner.style.display !== 'none';
			inner.style.display = isExpanded ? 'none' : '';
			icon.textContent = isExpanded ? '\u25B6' : '\u25BC';
		});

		this._currentToolActivityEl = wrapper;
		this._currentToolActivityCount = 0;
		this._chatContainer.appendChild(wrapper);
		return wrapper;
	}

	private _closeToolActivityContainer(): void {
		if (this._currentToolActivityEl) {
			const count = this._currentToolActivityEl.querySelector('.q3-agent-tool-activity-count');
			if (count) {
				count.textContent = `(${this._currentToolActivityCount})`;
			}
			// Collapse after completion
			const inner = this._currentToolActivityEl.querySelector('.q3-agent-tool-activity-inner') as HTMLElement;
			const icon = this._currentToolActivityEl.querySelector('.q3-agent-tool-activity-icon');
			if (inner) { inner.style.display = 'none'; }
			if (icon) { icon.textContent = '\u25B6'; }
		}
		this._currentToolActivityEl = undefined;
	}

	private _createToolCallElement(toolName: string, toolArgs: string): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.classList.add('q3-agent-tool-call');

		const header = document.createElement('div');
		header.classList.add('q3-agent-tool-call-header');

		const icon = document.createElement('span');
		icon.classList.add('q3-agent-tool-call-icon');
		icon.textContent = '\u25B6';
		header.appendChild(icon);

		const label = document.createElement('span');
		label.classList.add('q3-agent-tool-call-label');
		label.textContent = toolName;
		header.appendChild(label);

		const argsPreview = document.createElement('span');
		argsPreview.classList.add('q3-agent-tool-call-args');
		try {
			const parsed = JSON.parse(toolArgs);
			argsPreview.textContent = Object.entries(parsed)
				.map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v.length > 60 ? v.substring(0, 57) + '...' : v}"` : String(v)}`)
				.join(', ');
		} catch {
			argsPreview.textContent = toolArgs.length > 80 ? toolArgs.substring(0, 77) + '...' : toolArgs;
		}
		header.appendChild(argsPreview);

		wrapper.appendChild(header);

		// Collapsible args section
		const argsDetail = document.createElement('div');
		argsDetail.classList.add('q3-agent-tool-call-detail');
		argsDetail.style.display = 'none';

		const argsCodeContainer = document.createElement('div');
		argsCodeContainer.classList.add('q3-agent-tool-call-code');
		let useDiffTable = false;
		let diffOldText = '';
		let diffNewText = '';
		let diffFilePath = '';
		let argsMarkdown: string;
		try {
			const parsed = JSON.parse(toolArgs);
			if (toolName === 'apply_edit' && parsed.path) {
				useDiffTable = true;
			diffOldText = parsed.old_string || '';
			diffNewText = parsed.new_string || '';
			diffFilePath = parsed.path;
				argsMarkdown = `**File:** \`${parsed.path}\``;
			} else if (toolName === 'batch_edit' && parsed.path) {
				const editCount = parsed.edits?.length || 0;
				argsMarkdown = `**File:** \`${parsed.path}\` (${editCount} edits)`;
			} else if (toolName === 'write_file' && parsed.path) {
				const lang = this._getLanguageFromPath(parsed.path);
				const content = parsed.content || '';
				argsMarkdown = `**File:** \`${parsed.path}\`\n\n\`\`\`${lang}\n${content}\n\`\`\``;
			} else if (toolName === 'run_command' && parsed.command) {
				argsMarkdown = `\`\`\`bash\n${parsed.command}\n\`\`\``;
			} else if (toolName === 'git_commit' && parsed.message) {
				argsMarkdown = `\`\`\`bash\ngit add -A && git commit -m "${parsed.message}"\n\`\`\``;
			} else {
				argsMarkdown = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
			}
		} catch {
			argsMarkdown = `\`\`\`\n${toolArgs}\n\`\`\``;
		}
		this._renderMarkdownInto(argsCodeContainer, argsMarkdown);
		argsDetail.appendChild(argsCodeContainer);

		if (useDiffTable) {
			const diffTable = this._renderDiffTable(diffFilePath, diffOldText, diffNewText);
			argsDetail.appendChild(diffTable);
		}

		wrapper.appendChild(argsDetail);

		header.addEventListener('click', () => {
			const isExpanded = argsDetail.style.display !== 'none';
			argsDetail.style.display = isExpanded ? 'none' : '';
			icon.textContent = isExpanded ? '\u25B6' : '\u25BC';
		});

		return wrapper;
	}

	private _createToolResultElement(toolName: string, toolResult: string): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.classList.add('q3-agent-tool-result');

		const header = document.createElement('div');
		header.classList.add('q3-agent-tool-result-header');

		const icon = document.createElement('span');
		icon.classList.add('q3-agent-tool-result-icon');
		icon.textContent = '\u25B6';
		header.appendChild(icon);

		const label = document.createElement('span');
		label.classList.add('q3-agent-tool-result-label');
		label.textContent = `Result: ${toolName}`;
		header.appendChild(label);

		const lineCount = toolResult.split('\n').length;
		const summary = document.createElement('span');
		summary.classList.add('q3-agent-tool-result-summary');
		summary.textContent = `(${lineCount} line${lineCount !== 1 ? 's' : ''})`;
		header.appendChild(summary);

		wrapper.appendChild(header);

		// Collapsible result content
		const content = document.createElement('div');
		content.classList.add('q3-agent-tool-result-content');
		content.style.display = 'none';

		const resultContainer = document.createElement('div');
		resultContainer.classList.add('q3-agent-tool-result-pre');
		const truncatedResult = toolResult.length > 5000 ? toolResult.substring(0, 5000) + '\n... (truncated)' : toolResult;
		this._renderMarkdownInto(resultContainer, truncatedResult);
		content.appendChild(resultContainer);
		wrapper.appendChild(content);

		header.addEventListener('click', () => {
			const isExpanded = content.style.display !== 'none';
			content.style.display = isExpanded ? 'none' : '';
			icon.textContent = isExpanded ? '\u25B6' : '\u25BC';
		});

		return wrapper;
	}

	private _streamingRenderTimer: number | undefined;
	private _streamingPendingText: string = '';

	private _showThoughtIndicator(): void {
		if (this._currentThoughtEl && this._currentThoughtEl.isConnected) {
			return;
		}
		const el = document.createElement('div');
		el.classList.add('q3-agent-message', 'q3-agent-message-assistant', 'q3-agent-streaming');

		const avatar = document.createElement('div');
		avatar.classList.add('q3-agent-message-avatar');
		avatar.textContent = 'Q3';
		el.appendChild(avatar);

		const content = document.createElement('div');
		content.classList.add('q3-agent-message-content');

		const textEl = document.createElement('div');
		textEl.classList.add('q3-agent-message-text');
		content.appendChild(textEl);

		const cursor = document.createElement('span');
		cursor.classList.add('q3-agent-streaming-cursor');
		cursor.textContent = '\u2588';
		content.appendChild(cursor);

		el.appendChild(content);
		this._currentThoughtEl = el;
		this._chatContainer.appendChild(el);
		this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
	}

	private _updateThoughtText(text: string): void {
		if (!this._currentThoughtEl) { return; }
		this._streamingPendingText = text;
		if (this._streamingRenderTimer) { return; }
		this._streamingRenderTimer = window.setTimeout(() => {
			this._streamingRenderTimer = undefined;
			const textEl = this._currentThoughtEl?.querySelector('.q3-agent-message-text');
			if (textEl) {
				this._renderMarkdownInto(textEl as HTMLElement, this._streamingPendingText);
			}
			this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
		}, 50);
	}

	private _removeThoughtIndicator(): void {
		if (this._streamingRenderTimer) {
			clearTimeout(this._streamingRenderTimer);
			this._streamingRenderTimer = undefined;
		}
		if (this._currentThoughtEl) {
			this._currentThoughtEl.remove();
			this._currentThoughtEl = undefined;
		}
		this._streamingPendingText = '';
	}

	private _finalizeStreamingMessage(): void {
		if (!this._currentAssistantText) {
			this._removeThoughtIndicator();
			return;
		}

		// Flush any pending render
		if (this._streamingRenderTimer) {
			clearTimeout(this._streamingRenderTimer);
			this._streamingRenderTimer = undefined;
		}

		// If we have a streaming element, convert it to a permanent message
		if (this._currentThoughtEl) {
			// Remove the streaming cursor
			const cursor = this._currentThoughtEl.querySelector('.q3-agent-streaming-cursor');
			cursor?.remove();

			// Remove the streaming class
			this._currentThoughtEl.classList.remove('q3-agent-streaming');

			// Do final markdown render
			const textEl = this._currentThoughtEl.querySelector('.q3-agent-message-text');
			if (textEl) {
				this._renderMarkdownInto(textEl as HTMLElement, this._currentAssistantText);
			}

			// Add copy button
			const content = this._currentThoughtEl.querySelector('.q3-agent-message-content');
			if (content && !content.querySelector('.q3-agent-message-actions')) {
				const actions = document.createElement('div');
				actions.classList.add('q3-agent-message-actions');
				const copyBtn = document.createElement('button');
				copyBtn.classList.add('q3-agent-copy-button');
				copyBtn.textContent = 'Copy';
				const textToCopy = this._currentAssistantText;
				copyBtn.addEventListener('click', () => {
					navigator.clipboard.writeText(textToCopy).then(() => {
						copyBtn.textContent = 'Copied!';
						setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
					});
				});
				actions.appendChild(copyBtn);
				content.appendChild(actions);
			}

			// Store as a permanent message
			const msg: ChatMessage = { role: 'assistant', content: this._currentAssistantText };
			this._messages.push(msg);
			this._currentThoughtEl = undefined;
		} else {
			// No streaming element, create a new one
			const msg: ChatMessage = { role: 'assistant', content: this._currentAssistantText };
			this._messages.push(msg);
			this._currentAssistantEl = this._createMessageElement(msg);
			this._chatContainer.appendChild(this._currentAssistantEl);
		}

		this._streamingPendingText = '';
	}

	private _progressEl: HTMLElement | undefined;

	private _updateProgress(step: number, maxSteps: number): void {
		if (!this._progressEl) {
			this._progressEl = document.createElement('div');
			this._progressEl.classList.add('q3-agent-progress');
			this._chatContainer.appendChild(this._progressEl);
		}
		this._progressEl.textContent = `Step ${step}/${maxSteps}`;
		this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
	}

	private _hideProgress(): void {
		if (this._progressEl) {
			this._progressEl.remove();
			this._progressEl = undefined;
		}
	}



	private async _showInlineDiffInEditor(filePath: string, oldText: string, newText: string, toolCallId: string): Promise<void> {
		if (!filePath || !this._inlineDiffController) { return; }
		try {
			let uri: URI;
			if (filePath.startsWith('/') || filePath.startsWith('\\') ||
				(/^[A-Za-z]:[\\/]/.test(filePath))) {
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
			console.warn('[Q3Agent] Failed to show inline diff in editor:', e);
		}
	}

	private _openFileInEditor(filePath: string): void {
		if (!filePath) { return; }
		try {
			let uri: URI;
			if (filePath.startsWith('/') || filePath.startsWith('\\') ||
				(/^[A-Za-z]:[\\/]/.test(filePath))) {
				uri = URI.file(filePath);
			} else {
				const workspace = this._workspaceService.getWorkspace();
				const root = workspace.folders[0]?.uri;
				if (!root) { return; }
				uri = joinPath(root, filePath);
			}
			this._editorService.openEditor({ resource: uri });
		} catch (e) {
			console.warn('[Q3Agent] Failed to open file in editor:', e);
		}
	}

	private async _showFileDiff(chunk: IQ3AgentResponseChunk): Promise<void> {
		if (!chunk.diffLines || chunk.diffLines.length === 0) { return; }

		// Show inline diff in editor for auto-approved edits
		if (chunk.filePath && chunk.oldText !== undefined && chunk.newText !== undefined) {
			this._showInlineDiffInEditor(chunk.filePath, chunk.oldText, chunk.newText, chunk.toolCallId || '');
		}

		const wrapper = document.createElement('div');
		wrapper.classList.add('q3-agent-file-diff');

		const header = document.createElement('div');
		header.classList.add('q3-agent-file-diff-header');

		const label = document.createElement('span');
		label.classList.add('q3-agent-file-diff-label');
		label.textContent = chunk.filePath || 'unknown';
		header.appendChild(label);

		const stats = document.createElement('span');
		stats.classList.add('q3-agent-file-diff-stats');
		stats.textContent = chunk.content || '';
		header.appendChild(stats);

		const icon = document.createElement('span');
		icon.classList.add('q3-agent-file-diff-icon');
		icon.textContent = '\u25B6';
		header.appendChild(icon);

		wrapper.appendChild(header);

		const diffBody = document.createElement('div');
		diffBody.classList.add('q3-agent-file-diff-body');
		diffBody.style.display = 'none';

		const table = document.createElement('table');
		table.classList.add('q3-agent-diff-table');

		const lang = this._getLanguageFromPath(chunk.filePath || '');

		for (let i = 0; i < chunk.diffLines.length; i++) {
			const line = chunk.diffLines[i];
			const tr = document.createElement('tr');
			tr.classList.add(`q3-agent-diff-line-${line.type}`);

			const oldNum = document.createElement('td');
			oldNum.classList.add('q3-agent-diff-line-num');
			oldNum.textContent = line.oldLine !== undefined ? String(line.oldLine) : '';
			tr.appendChild(oldNum);

			const newNum = document.createElement('td');
			newNum.classList.add('q3-agent-diff-line-num');
			newNum.textContent = line.newLine !== undefined ? String(line.newLine) : '';
			tr.appendChild(newNum);

			const marker = document.createElement('td');
			marker.classList.add('q3-agent-diff-marker');
			marker.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
			tr.appendChild(marker);

			const code = document.createElement('td');
			code.classList.add('q3-agent-diff-code');
			const codeEl = document.createElement('code');
			codeEl.classList.add(`language-${lang}`);
			codeEl.textContent = line.text;
			code.appendChild(codeEl);
			tr.appendChild(code);

			table.appendChild(tr);
		}

		diffBody.appendChild(table);

		// Syntax highlighting is handled by CSS classes on the code elements
		// (language-xxx class triggers HighlightJS if available)
		wrapper.appendChild(diffBody);

		// Add "Open File" button
		const openBtn = document.createElement('button');
		openBtn.classList.add('q3-agent-diff-open-btn');
		openBtn.textContent = 'Open File';
		openBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this._openFileInEditor(chunk.filePath || '');
		});
		header.appendChild(openBtn);

		header.addEventListener('click', () => {
			const isExpanded = diffBody.style.display !== 'none';
			diffBody.style.display = isExpanded ? 'none' : '';
			icon.textContent = isExpanded ? '\u25B6' : '\u25BC';
		});

		// Auto-open file in editor
		this._openFileInEditor(chunk.filePath || '');

		// Insert into tool activity container if active, otherwise standalone
		const activityEl = this._getOrCreateToolActivityContainer();
		const inner = activityEl.querySelector('.q3-agent-tool-activity-inner') as HTMLElement;
		inner.appendChild(wrapper);
		this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
	}

	private _handleChunk(chunk: IQ3AgentResponseChunk): void {
		if (chunk.type === 'step') {
			this._updateProgress(chunk.stepNumber || 1, chunk.maxSteps || 20);
		} else if (chunk.type === 'file_diff') {
			this._showFileDiff(chunk);
		} else if (chunk.type === 'token') {
			if (!this._currentThoughtEl) {
				this._currentAssistantText = '';
				this._showThoughtIndicator();
			} else if (this._currentAssistantText === 'Thinking...' || this._currentAssistantText === 'Generating...') {
				this._currentAssistantText = '';
			}
			this._currentAssistantText += chunk.content || '';
			this._updateThoughtText(this._currentAssistantText);
		} else if (chunk.type === 'tool_call') {
			// Clear placeholder text
			if (this._currentAssistantText === 'Thinking...' || this._currentAssistantText === 'Generating...') {
				this._currentAssistantText = '';
			}
		this._removeThoughtIndicator();
			this._currentAssistantText = '';

			// Get or create the grouped tool activity container
			const activityEl = this._getOrCreateToolActivityContainer();
			const inner = activityEl.querySelector('.q3-agent-tool-activity-inner') as HTMLElement;

			const el = this._createToolCallElement(chunk.toolName || '', chunk.toolArgs || '');
			inner.appendChild(el);
			this._currentToolActivityCount++;
			const count = activityEl.querySelector('.q3-agent-tool-activity-count');
			if (count) { count.textContent = `(${this._currentToolActivityCount})`; }
			this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
		} else if (chunk.type === 'tool_result') {
			const activityEl = this._getOrCreateToolActivityContainer();
			const inner = activityEl.querySelector('.q3-agent-tool-activity-inner') as HTMLElement;

			const el = this._createToolResultElement(chunk.toolName || '', chunk.toolResult || '');
			inner.appendChild(el);
			this._currentToolActivityCount++;
			const count = activityEl.querySelector('.q3-agent-tool-activity-count');
			if (count) { count.textContent = `(${this._currentToolActivityCount})`; }
			this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
		} else if (chunk.type === 'tool_approval') {
			// Approval handled by VS Code chat panel (q3ChatAgent)
		} else if (chunk.type === 'done') {
			this._finalizeStreamingMessage();
			this._removeThoughtIndicator();
			this._currentAssistantEl = undefined;
			this._currentAssistantText = '';
			this._closeToolActivityContainer();
			this._hideProgress();
		} else if (chunk.type === 'error') {
			this._removeThoughtIndicator();
			this._currentAssistantEl = undefined;
			this._currentAssistantText = '';
			this._closeToolActivityContainer();
			this._hideProgress();
			this._addMessage({ role: 'assistant', content: `Error: ${chunk.error}` });
		}
	}

	private _handleStateChange(state: 'idle' | 'thinking' | 'tool_executing'): void {
		if (state === 'idle') {
			this._sendButton.style.display = '';
			this._stopButton.style.display = 'none';
			this._inputBox.disabled = false;
			this._hideProgress();
		} else {
			this._sendButton.style.display = 'none';
			this._stopButton.style.display = '';
			this._inputBox.disabled = false;
			if (state === 'thinking' && !this._currentThoughtEl) {
				this._showThoughtIndicator();
				this._updateThoughtText('Generating...');
				this._currentAssistantText = 'Generating...';
			}
		}
	}

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}
}
