/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQ3LlamaCppService } from '../../../services/q3Agent/common/q3Agent.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';

export class Q3AgentStartupContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IQ3LlamaCppService private readonly _llamaCppService: IQ3LlamaCppService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();

		lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this._checkBackendAndStart();
		});
	}

	private async _checkBackendAndStart(): Promise<void> {
		this._logService.info('[q3agent] Backend: llamacpp (only backend)');
		await this._startLlamaCpp();
	}

	private async _startLlamaCpp(): Promise<void> {
		const modelPath = this._configService.getValue<string>('q3.agent.llamacpp.modelPath');
		if (!modelPath) {
			this._notificationService.info(
				nls.localize('q3agent.llamacppNoModel', 'No llama.cpp model configured. Go to Settings > Q3 Agent to set a model path.')
			);
			return;
		}

		this._llamaCppService.fireStatusMessage('Starting llama-swap engine...');
		this._notificationService.info(
			nls.localize('q3agent.llamacppStarting', 'Starting ik_llama.cpp server via llama-swap...')
		);

		const started = await this._llamaCppService.start();
		if (started) {
			this._llamaCppService.fireStatusMessage('llama-swap engine ready. Loading model into GPU memory...');
			this._notificationService.info(
				nls.localize('q3agent.llamacppReady', 'ik_llama.cpp server is ready.')
			);
			this._warmUpModelLlamaCpp();
		} else {
			this._llamaCppService.fireStatusMessage('Failed to start llama-swap engine. Check logs for details.');
			this._notificationService.error(
				nls.localize('q3agent.llamacppFailed', 'Failed to start llama.cpp server. Check the log for details. Ensure CUDA runtime is installed and the model path is correct.')
			);
		}
	}

	private async _warmUpModelLlamaCpp(): Promise<void> {
		const warmupEnabled = this._configService.getValue<boolean>('q3.agent.warmUpModel') ?? true;
		if (!warmupEnabled) { return; }

		const model = this._configService.getValue<string>('q3.agent.model') || 'qwen3-coder:30b';
		const endpoint = this._llamaCppService.getEndpoint();
		this._logService.info(`[q3agent] Warming up model via llama.cpp: ${model}`);
		this._llamaCppService.fireStatusMessage(`Warming up model: ${model}. Loading into GPU memory, please wait...`);

		try {
			const body = JSON.stringify({
				model,
				messages: [{ role: 'user', content: 'Hello' }],
				max_tokens: 1,
				stream: false,
			});
			const maxRetries = 3;
			const baseDelay = 5000;
			let lastError: Error | undefined;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				const cts = new CancellationTokenSource();
				try {
					this._logService.info(`[q3agent] Warm-up attempt ${attempt + 1}/${maxRetries + 1} POST ${endpoint}/v1/chat/completions`);
					this._logService.info(`[q3agent] Warm-up body: ${body}`);
					const context = await this._requestService.request({
						url: `${endpoint}/v1/chat/completions`,
						type: 'POST',
						data: body,
						headers: { 'Content-Type': 'application/json' },
						callSite: 'q3agent',
					}, cts.token);
					const responseBuffer = await streamToBuffer(context.stream);
					const responseText = responseBuffer.toString();
					const status = context.res.statusCode ?? 0;
					const ok = status >= 200 && status < 300;
					this._logService.info(`[q3agent] Warm-up response status: ${status}, body: ${responseText}`);
					if (ok) {
						this._logService.info(`[q3agent] Model ${model} warmed up successfully via llama.cpp.`);
						this._llamaCppService.fireStatusMessage(`Model ${model} loaded and ready. You can start chatting!`);
						return;
					}
					lastError = new Error(`llama.cpp warm-up failed: ${status} - ${responseText}`);
					this._logService.warn(`[q3agent] Warm-up attempt ${attempt + 1} failed: ${lastError.message}`);
					if (attempt < maxRetries) {
						const delay = baseDelay * (attempt + 1);
						this._logService.info(`[q3agent] Retrying warm-up in ${delay}ms...`);
						await this._sleep(delay);
					}
				} finally {
					cts.dispose();
				}
			}
			throw lastError ?? new Error('llama.cpp warm-up failed after retries');
		} catch (err: any) {
			this._logService.warn(`[q3agent] llama.cpp warm-up failed: ${err?.message || err}`);
			this._llamaCppService.fireStatusMessage(`Model warm-up failed: ${err?.message || err}. The engine is still ready - try sending a message.`);
		}
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
