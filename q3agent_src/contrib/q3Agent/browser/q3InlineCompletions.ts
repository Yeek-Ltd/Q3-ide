/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { InlineCompletion, InlineCompletionContext, InlineCompletions, InlineCompletionsProvider, InlineCompletionTriggerKind } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IQ3LLMBridgeService, IQ3ModelService, IQ3FIMRequest } from '../../../services/q3Agent/common/q3Agent.js';

const DEBOUNCE_MS = 300;
const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 2000;

class Q3InlineCompletionList implements InlineCompletions {
	constructor(
		public readonly items: InlineCompletion[],
	) { }

	disposeInlineCompletions(): void { }
}

export class Q3InlineCompletionsProvider extends Disposable implements IWorkbenchContribution, InlineCompletionsProvider<InlineCompletions> {
	declare readonly _serviceBrand: undefined;

	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChangeInlineCompletions: Event<void> = this._onDidChange.event;

	readonly groupId = 'q3-inline';
	readonly displayName = 'Q3 Inline Completions';

	constructor(
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IQ3LLMBridgeService private readonly _llmBridge: IQ3LLMBridgeService,
		@IQ3ModelService private readonly _modelService: IQ3ModelService,
	) {
		super();

		if (this._configService.getValue<boolean>('q3.inlineCompletion.enabled') !== false) {
			this._register(this._languageFeaturesService.inlineCompletionsProvider.register('*', this));
		}
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions | undefined> {
		if (this._configService.getValue<boolean>('q3.inlineCompletion.enabled') === false) {
			return undefined;
		}

		// Only trigger on explicit invoke or after typing
		if (context.triggerKind === InlineCompletionTriggerKind.Automatic && model.getLineCount() === 1 && position.column === 1) {
			return undefined;
		}

		// Debounce: wait before making the request
		await this._debounce(token);
		if (token.isCancellationRequested) {
			return undefined;
		}

		// Build prefix/suffix from cursor position
		const prefix = this._getPrefix(model, position);
		const suffix = this._getSuffix(model, position);

		if (prefix.trim().length === 0) {
			return undefined;
		}

		const fimRequest: IQ3FIMRequest = {
			prefix,
			suffix,
			language: model.getLanguageId(),
		};

		const modelName = this._configService.getValue<string>('q3.inlineCompletion.model')
			|| this._modelService.getCurrentModel();

		try {
			const completion = await this._llmBridge.complete(modelName, fimRequest, {
				temperature: 0.2,
				maxTokens: this._configService.getValue<number>('q3.inlineCompletion.maxTokens') ?? 128,
			});

			if (token.isCancellationRequested || !completion || completion.trim().length === 0) {
				return undefined;
			}

			// Clean up the completion - remove leading whitespace that duplicates existing text
			const cleanedCompletion = this._cleanCompletion(completion, prefix);

			if (!cleanedCompletion) {
				return undefined;
			}

			const replaceRange = new Range(
				position.lineNumber,
				position.column,
				position.lineNumber,
				position.column,
			);

			const item: InlineCompletion = {
				insertText: cleanedCompletion,
				range: replaceRange,
				completeBracketPairs: true,
			};

			return new Q3InlineCompletionList([item]);
		} catch {
			return undefined;
		}
	}

	disposeInlineCompletions(_completions: InlineCompletions, _reason: any): void {
		// Nothing to dispose
	}

	private _debounce(token: CancellationToken): Promise<void> {
		return new Promise<void>((resolve) => {
			if (this._debounceTimer) {
				clearTimeout(this._debounceTimer);
			}
			this._debounceTimer = setTimeout(() => {
				this._debounceTimer = undefined;
				resolve();
			}, DEBOUNCE_MS);

			token.onCancellationRequested(() => {
				if (this._debounceTimer) {
					clearTimeout(this._debounceTimer);
					this._debounceTimer = undefined;
				}
				resolve();
			});
		});
	}

	private _getPrefix(model: ITextModel, position: Position): string {
		const startLine = Math.max(1, position.lineNumber - 50);
		const prefixRange = new Range(startLine, 1, position.lineNumber, position.column);
		let prefix = model.getValueInRange(prefixRange);
		if (prefix.length > MAX_PREFIX_CHARS) {
			prefix = prefix.substring(prefix.length - MAX_PREFIX_CHARS);
		}
		return prefix;
	}

	private _getSuffix(model: ITextModel, position: Position): string {
		const endLine = Math.min(model.getLineCount(), position.lineNumber + 50);
		const suffixRange = new Range(position.lineNumber, position.column, endLine, model.getLineMaxColumn(endLine));
		let suffix = model.getValueInRange(suffixRange);
		if (suffix.length > MAX_SUFFIX_CHARS) {
			suffix = suffix.substring(0, MAX_SUFFIX_CHARS);
		}
		return suffix;
	}

	private _cleanCompletion(completion: string, prefix: string): string {
		// Remove leading whitespace if the completion starts with the same indentation as the current line
		const currentLineIndent = prefix.split('\n').pop()?.match(/^\s*/)?.[0] ?? '';
		if (completion.startsWith(currentLineIndent)) {
			return completion.substring(currentLineIndent.length);
		}
		return completion;
	}
}
