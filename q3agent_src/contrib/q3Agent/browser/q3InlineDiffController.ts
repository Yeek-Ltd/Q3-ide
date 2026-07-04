/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IModelDeltaDecoration } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { Range } from '../../../../editor/common/core/range.js';

export interface IQ3PendingEdit {
	filePath: string;
	oldText: string;
	newText: string;
	toolCallId: string;
}

interface IQ3ActiveDiff {
	edit: IQ3PendingEdit;
	editor: ICodeEditor;
	decorations: string[];
	widget: Q3DiffContentWidget | null;
	store: DisposableStore;
}

const addedLineDecoration = ModelDecorationOptions.register({
	description: 'q3-inline-diff-added',
	className: 'q3-inline-diff-added',
	isWholeLine: true,
	linesDecorationsClassName: 'q3-inline-diff-added-gutter',
	marginClassName: 'q3-inline-diff-added-margin',
});

const removedLineDecoration = ModelDecorationOptions.register({
	description: 'q3-inline-diff-removed',
	className: 'q3-inline-diff-removed',
	isWholeLine: true,
	linesDecorationsClassName: 'q3-inline-diff-removed-gutter',
	marginClassName: 'q3-inline-diff-removed-margin',
});

class Q3DiffContentWidget implements IDisposable {
	private _domNode: HTMLElement;
	private _position: { lineNumber: number; column: number } | null = null;
	private _added = false;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _onApprove: () => void,
		private readonly _onDeny: () => void,
		private readonly _filePath: string,
	) {
		this._domNode = document.createElement('div');
		this._domNode.className = 'q3-inline-diff-widget';

		const label = document.createElement('span');
		label.className = 'q3-inline-diff-widget-label';
		label.textContent = `Pending edit: ${this._filePath.split('/').pop() || this._filePath}`;
		this._domNode.appendChild(label);

		const approveBtn = document.createElement('button');
		approveBtn.className = 'q3-inline-diff-approve-btn';
		approveBtn.textContent = '✓ Accept';
		approveBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._onApprove();
		});
		this._domNode.appendChild(approveBtn);

		const denyBtn = document.createElement('button');
		denyBtn.className = 'q3-inline-diff-deny-btn';
		denyBtn.textContent = '✕ Reject';
		denyBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this._onDeny();
		});
		this._domNode.appendChild(denyBtn);
	}

	getId(): string {
		return 'q3-inline-diff-widget';
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): { position: { lineNumber: number; column: number }; preference: number[] } | null {
		if (!this._position) {
			return null;
		}
		return {
			position: this._position,
			preference: [1, 2],
		};
	}

	setPosition(lineNumber: number): void {
		this._position = { lineNumber, column: 1 };
	}

	show(): void {
		if (!this._added) {
			this._added = true;
			this._editor.addContentWidget(this);
		}
		this._editor.layoutContentWidget(this);
	}

	hide(): void {
		if (this._added) {
			this._added = false;
			this._editor.removeContentWidget(this);
		}
	}

	dispose(): void {
		this.hide();
	}
}

export class Q3InlineDiffController extends Disposable {
	private _activeDiffs: Map<string, IQ3ActiveDiff> = new Map();

	constructor() {
		super();
	}

	hasPending(filePath: string): boolean {
		return this._activeDiffs.has(this._normalizePath(filePath));
	}

	showDiff(editor: ICodeEditor, edit: IQ3PendingEdit): void {
		const key = this._normalizePath(edit.filePath);

		if (this._activeDiffs.has(key)) {
			this.clearDiff(key);
		}

		const store = new DisposableStore();
		const model = editor.getModel();
		if (!model) { return; }

		const oldLines = edit.oldText.split('\n');
		const newLines = edit.newText.split('\n');

		const decorations: IModelDeltaDecoration[] = [];

		let modelLine = 1;
		let oldIdx = 0;
		let newIdx = 0;
		let firstChangedLine = -1;

		while (oldIdx < oldLines.length || newIdx < newLines.length) {
			if (oldIdx < oldLines.length && newIdx < newLines.length && oldLines[oldIdx] === newLines[newIdx]) {
				oldIdx++;
				newIdx++;
				modelLine++;
				continue;
			}

			if (firstChangedLine < 0) {
				firstChangedLine = modelLine;
			}

			if (oldIdx < oldLines.length && (newIdx >= newLines.length || oldLines[oldIdx] !== newLines[newIdx])) {
				const lineCount = this._countConsecutiveDifferent(oldLines, oldIdx, newLines, newIdx, 'old');
				for (let i = 0; i < lineCount; i++) {
					decorations.push({
						range: new Range(modelLine, 1, modelLine, 1),
						options: removedLineDecoration,
					});
					oldIdx++;
					modelLine++;
				}
			} else if (newIdx < newLines.length) {
				const lineCount = this._countConsecutiveDifferent(oldLines, oldIdx, newLines, newIdx, 'new');
				for (let i = 0; i < lineCount; i++) {
					decorations.push({
						range: new Range(modelLine, 1, modelLine, 1),
						options: addedLineDecoration,
					});
					newIdx++;
					modelLine++;
				}
			}
		}

		if (firstChangedLine < 1) {
			firstChangedLine = 1;
		}

		const decorationIds = editor.deltaDecorations([], decorations);

		const widget = new Q3DiffContentWidget(
			editor,
			() => this._handleApprove(key),
			() => this._handleDeny(key),
			edit.filePath,
		);
		widget.setPosition(firstChangedLine);
		widget.show();

		store.add(widget);

		this._activeDiffs.set(key, {
			edit,
			editor,
			decorations: decorationIds,
			widget,
			store,
		});

		editor.revealLineInCenter(firstChangedLine);
	}

	private _countConsecutiveDifferent(oldLines: string[], oldIdx: number, newLines: string[], newIdx: number, side: 'old' | 'new'): number {
		let count = 0;
		if (side === 'old') {
			while (oldIdx + count < oldLines.length) {
				if (newIdx < newLines.length && oldLines[oldIdx + count] === newLines[newIdx]) {
					break;
				}
				count++;
			}
		} else {
			while (newIdx + count < newLines.length) {
				if (oldIdx < oldLines.length && newLines[newIdx + count] === oldLines[oldIdx]) {
					break;
				}
				count++;
			}
		}
		return Math.max(count, 1);
	}

	private _handleApprove(key: string): void {
		const diff = this._activeDiffs.get(key);
		if (!diff) { return; }
		this._onApprove?.(diff.edit.toolCallId);
		this.clearDiff(key);
	}

	private _handleDeny(key: string): void {
		const diff = this._activeDiffs.get(key);
		if (!diff) { return; }
		this._onDeny?.(diff.edit.toolCallId);
		this.clearDiff(key);
	}

	private _onApprove: ((toolCallId: string) => void) | null = null;
	private _onDeny: ((toolCallId: string) => void) | null = null;

	setApprovalCallbacks(onApprove: (toolCallId: string) => void, onDeny: (toolCallId: string) => void): void {
		this._onApprove = onApprove;
		this._onDeny = onDeny;
	}

	clearDiff(filePath: string): void {
		const key = typeof filePath === 'string' && this._activeDiffs.has(filePath) ? filePath : this._normalizePath(filePath);
		const diff = this._activeDiffs.get(key);
		if (!diff) { return; }

		diff.editor.deltaDecorations(diff.decorations, []);
		diff.store.dispose();
		this._activeDiffs.delete(key);
	}

	clearAll(): void {
		for (const key of this._activeDiffs.keys()) {
			this.clearDiff(key);
		}
	}

	private _normalizePath(filePath: string): string {
		return filePath.toLowerCase().replace(/\\/g, '/');
	}

	override dispose(): void {
		this.clearAll();
		super.dispose();
	}
}
