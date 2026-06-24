/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQ3ModelService } from '../../../services/q3Agent/common/q3Agent.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

const DISMISSAL_KEY = 'q3agent.modelDisclaimerDismissed';

export class Q3AgentStartupContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IQ3ModelService private readonly _modelService: IQ3ModelService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this._checkModelsAndPrompt();
		});
	}

	private async _checkModelsAndPrompt(): Promise<void> {
		try {
			const running = await this._modelService.isOllamaRunning();
			if (!running) {
				this._notificationService.info(
					nls.localize('q3agent.ollamaNotRunning',
						'Ollama is not running. Start Ollama to use the Q3 Agent. Download it from ollama.com')
				);
				return;
			}

			const models = await this._modelService.getModels();
			if (models.length > 0) {
				return;
			}

			const dismissed = this._storageService.getBoolean(DISMISSAL_KEY, StorageScope.APPLICATION, false);
			if (dismissed) {
				return;
			}

			const result = await this._dialogService.confirm({
				title: nls.localize('q3agent.welcomeTitle', 'Welcome to Q3 Agent'),
				message: nls.localize('q3agent.welcomeMessage',
					'No AI models are installed. Q3 Agent needs a model to function.\n\nThe recommended default is Qwen 3 Coder 30B:\n• Size: ~19 GB download\n• Parameters: 30B total (3.3B active)\n• Best for: Coding, debugging, refactoring\n• Runs entirely offline on your machine\n\nModels are stored in Ollama\'s model directory (controlled by the OLLAMA_MODELS environment variable). Make sure you have enough disk space.\n\nWould you like to download Qwen 3 Coder 30B now?'),
				primaryButton: nls.localize('q3agent.downloadNow', 'Download (19 GB)'),
				cancelButton: nls.localize('q3agent.later', 'Skip for now'),
			});

			if (result.confirmed) {
				this._notificationService.info(
					nls.localize('q3agent.downloading', 'Downloading Qwen 3 Coder 30B (~19 GB). This may take a while depending on your connection.')
				);
				try {
					await this._modelService.pullModel('qwen3-coder:30b');
					this._notificationService.info(
						nls.localize('q3agent.downloadComplete', 'Qwen 3 Coder 30B downloaded successfully! You can now use the Q3 Agent.')
					);
					this._storageService.store(DISMISSAL_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
				} catch (err: any) {
					this._notificationService.error(
						nls.localize('q3agent.downloadFailed', 'Failed to download model: {0}', err?.message || String(err))
					);
				}
			} else {
				this._storageService.store(DISMISSAL_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
			}
		} catch {
		}
	}
}
