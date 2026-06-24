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
import { IQ3AgentService, IQ3AgentResponseChunk, IQ3ModelService } from '../../../services/q3Agent/common/q3Agent.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

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
	private _messages: ChatMessage[] = [];
	private _currentAssistantEl: HTMLElement | undefined;
	private _currentAssistantText: string = '';
	private readonly _disposables = new DisposableStore();

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
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = container;
		root.classList.add('q3-agent');

		// Model selector bar
		const toolbar = document.createElement('div');
		toolbar.classList.add('q3-agent-toolbar');
		root.appendChild(toolbar);

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

		this._refreshModels();

		// Chat container
		this._chatContainer = document.createElement('div');
		this._chatContainer.classList.add('q3-agent-chat');
		root.appendChild(this._chatContainer);

		// Welcome message
		this._addMessage({ role: 'assistant', content: 'Welcome to Q3 Agent! I\'m powered by Qwen 3 Coder running locally via Ollama. Ask me anything about your code.' });

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

	private async _refreshModels(): Promise<void> {
		const running = await this._modelService.isOllamaRunning();
		if (!running) {
			this._modelSelector.innerHTML = '<option value="">Ollama not running</option>';
			return;
		}
		const models = await this._modelService.getModels();
		this._modelSelector.innerHTML = '';
		if (models.length === 0) {
			const opt = document.createElement('option');
			opt.value = '';
			opt.textContent = 'No models installed';
			this._modelSelector.appendChild(opt);
			return;
		}
		const current = this._modelService.getCurrentModel();
		for (const model of models) {
			const opt = document.createElement('option');
			opt.value = model.name;
			opt.textContent = `${model.name} (${model.parameterSize})`;
			if (model.name === current) {
				opt.selected = true;
			}
			this._modelSelector.appendChild(opt);
		}
	}

	private _sendMessage(): void {
		const text = this._inputBox.value.trim();
		if (!text || this._agentService.isRunning()) { return; }

		this._addMessage({ role: 'user', content: text });
		this._inputBox.value = '';

		// Gather context
		const activeEditor = this._editorService.activeTextEditorControl;
		const context: any = {};
		if (activeEditor) {
			const model = activeEditor.getModel() as ITextModel | undefined;
			if (model) {
				const selection = activeEditor.getSelection();
				const selectedText = selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined;
				context.activeFile = {
					path: model.uri.fsPath,
					content: model.getValue(),
					language: model.getLanguageId(),
					selection: selectedText,
				};
			}
		}

		this._agentService.send({ prompt: text, context });
	}

	private _addMessage(msg: ChatMessage): void {
		this._messages.push(msg);
		const el = this._createMessageElement(msg);
		this._chatContainer.appendChild(el);
		this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
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
		textEl.innerHTML = this._renderMarkdown(msg.content);
		content.appendChild(textEl);

		wrapper.appendChild(content);
		return wrapper;
	}

	private _renderMarkdown(text: string): string {
		let html = text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');

		html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
			return `<pre class="q3-agent-code-block"><code>${code.trim()}</code></pre>`;
		});

		html = html.replace(/`([^`]+)`/g, '<code class="q3-agent-inline-code">$1</code>');

		html = html.replace(/\n/g, '<br>');

		return html;
	}

	private _handleChunk(chunk: IQ3AgentResponseChunk): void {
		if (chunk.type === 'token') {
			if (!this._currentAssistantEl) {
				this._currentAssistantText = '';
				const msg: ChatMessage = { role: 'assistant', content: '' };
				this._messages.push(msg);
				this._currentAssistantEl = this._createMessageElement(msg);
				this._chatContainer.appendChild(this._currentAssistantEl);
			}
			this._currentAssistantText += chunk.content || '';
			const textEl = this._currentAssistantEl.querySelector('.q3-agent-message-text');
			if (textEl) {
				textEl.innerHTML = this._renderMarkdown(this._currentAssistantText);
			}
			this._chatContainer.scrollTop = this._chatContainer.scrollHeight;
		} else if (chunk.type === 'tool_call') {
			this._currentAssistantEl = undefined;

			const msg: ChatMessage = {
				role: 'tool',
				content: `Calling ${chunk.toolName}(${chunk.toolArgs})`,
				toolName: chunk.toolName,
			};
			this._addMessage(msg);
		} else if (chunk.type === 'tool_result') {
			const msg: ChatMessage = {
				role: 'tool',
				content: chunk.toolResult || '',
				toolName: chunk.toolName,
			};
			this._addMessage(msg);
		} else if (chunk.type === 'done') {
			this._currentAssistantEl = undefined;
		} else if (chunk.type === 'error') {
			this._currentAssistantEl = undefined;
			this._addMessage({ role: 'assistant', content: `Error: ${chunk.error}` });
		}
	}

	private _handleStateChange(state: 'idle' | 'thinking' | 'tool_executing'): void {
		if (state === 'idle') {
			this._sendButton.style.display = '';
			this._stopButton.style.display = 'none';
			this._inputBox.disabled = false;
		} else {
			this._sendButton.style.display = 'none';
			this._stopButton.style.display = '';
			this._inputBox.disabled = true;
		}
	}

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}
}
