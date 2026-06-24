/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQ3ModelService, IQ3ModelInfo, IQ3ModelPreset } from './q3Agent.js';

const DEFAULT_ENDPOINT = 'http://localhost:11434';

const MODEL_PRESETS: IQ3ModelPreset[] = [
	// === Coding Models (Local, Free) ===
	{ name: 'qwen3-coder:30b', displayName: 'Qwen 3 Coder 30B', description: '30B params (3.3B active). Best local coding model for most machines.', size: '19 GB', cloud: false, category: 'coder' },
	{ name: 'qwen3-coder:480b', displayName: 'Qwen 3 Coder 480B', description: '480B params (35B active). Frontier-grade coding, needs 250GB+ RAM.', size: '290 GB', cloud: false, category: 'coder' },
	{ name: 'qwen3.6:27b', displayName: 'Qwen 3.6 27B', description: '27B params. Top overall on consumer hardware. 77% SWE-bench. Fits 24GB at Q4.', size: '16 GB', cloud: false, category: 'coder' },
	{ name: 'qwen3:7b', displayName: 'Qwen 3 7B', description: '7B params. Lightweight coding & chat. Good for 8GB+ machines.', size: '4.7 GB', cloud: false, category: 'coder' },
	{ name: 'devstral:24b', displayName: 'Devstral Small 24B', description: 'Mistral coding model. 24B params, optimized for code generation & IDE agents.', size: '14 GB', cloud: false, category: 'coder' },
	{ name: 'gpt-oss:20b', displayName: 'GPT-OSS 20B', description: 'OpenAI open-weight model. 20B params, strong general + coding. 17B active MoE.', size: '12 GB', cloud: false, category: 'coder' },

	// === General Models (Local, Free) ===
	{ name: 'llama3.2:3b', displayName: 'Llama 3.2 3B', description: 'Meta lightweight model. 3B params. Fast, runs on 4GB+ machines.', size: '2.0 GB', cloud: false, category: 'general' },
	{ name: 'llama3.3:70b', displayName: 'Llama 3.3 70B', description: 'Meta flagship. 70B params. Strong general purpose. Needs 40GB+ RAM.', size: '40 GB', cloud: false, category: 'general' },
	{ name: 'gemma3:1b', displayName: 'Gemma 3 1B', description: 'Google lightweight. 1B params. Ultra-fast, runs on any machine.', size: '0.8 GB', cloud: false, category: 'general' },
	{ name: 'gemma4:e4b', displayName: 'Gemma 4 E4B', description: 'Google latest. 4B effective params. Vision + tool calling. Fits 8GB.', size: '2.5 GB', cloud: false, category: 'general' },
	{ name: 'mistral-small3.1:24b', displayName: 'Mistral Small 3.1 24B', description: 'Mistral compact model. 24B params. Good balance of speed & quality.', size: '14 GB', cloud: false, category: 'general' },

	// === Reasoning Models (Local, Free) ===
	{ name: 'deepseek-r1:7b', displayName: 'DeepSeek R1 7B', description: 'Reasoning model with chain-of-thought. 7B params. Great for math & logic.', size: '4.7 GB', cloud: false, category: 'reasoning' },
	{ name: 'deepseek-r1:14b', displayName: 'DeepSeek R1 14B', description: 'Reasoning model. 14B params. Better accuracy, needs 10GB RAM.', size: '9 GB', cloud: false, category: 'reasoning' },
	{ name: 'deepseek-r1:32b', displayName: 'DeepSeek R1 32B', description: 'Reasoning model. 32B params. Competition-level math & logic. 20GB RAM.', size: '20 GB', cloud: false, category: 'reasoning' },

	// === Cloud Models (Require Ollama account + billing) ===
	{ name: 'glm-5.2:cloud', displayName: 'GLM-5.2 (Cloud)', description: 'Z.ai flagship. 744B MoE, 1M context. Cloud-only via Ollama.', size: 'Cloud', cloud: true, category: 'coder' },
	{ name: 'kimi-k2.7-code:cloud', displayName: 'Kimi K2.7 Code (Cloud)', description: 'Moonshot coding model. 256K context, text+image. Cloud-only.', size: 'Cloud', cloud: true, category: 'coder' },
	{ name: 'kimi-k2.6:cloud', displayName: 'Kimi K2.6 (Cloud)', description: 'Moonshot general model. Cloud-only via Ollama.', size: 'Cloud', cloud: true, category: 'general' },
];

export class Q3ModelService extends Disposable implements IQ3ModelService {
	declare readonly _serviceBrand: undefined;

	private _currentModel: string = 'qwen3-coder:30b';
	private _installedCache: IQ3ModelInfo[] | undefined;

	private readonly _onDidModelsChange = new Emitter<void>();
	readonly onDidModelsChange = this._onDidModelsChange.event;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();
		this._currentModel = this._configService.getValue<string>('q3.agent.model') || 'qwen3-coder:30b';
	}

	getEndpoint(): string {
		return this._configService.getValue<string>('q3.agent.endpoint') || DEFAULT_ENDPOINT;
	}

	getCurrentModel(): string {
		return this._configService.getValue<string>('q3.agent.model') || this._currentModel;
	}

	setCurrentModel(model: string): void {
		this._currentModel = model;
		this._configService.updateValue('q3.agent.model', model);
	}

	getModelPresets(): IQ3ModelPreset[] {
		return MODEL_PRESETS;
	}

	async isOllamaRunning(): Promise<boolean> {
		try {
			const resp = await fetch(`${this.getEndpoint()}/api/tags`);
			return resp.ok;
		} catch {
			return false;
		}
	}

	async getModels(): Promise<IQ3ModelInfo[]> {
		if (this._installedCache) {
			return this._installedCache;
		}
		try {
			const resp = await fetch(`${this.getEndpoint()}/api/tags`);
			if (!resp.ok) {
				return [];
			}
			const data = await resp.json() as { models: any[] };
			this._installedCache = (data.models || []).map((m: any) => ({
				name: m.name,
				parameterSize: m.details?.parameter_size || 'unknown',
				quantizationLevel: m.details?.quantization_level || 'unknown',
				size: m.size || 0,
			}));
			return this._installedCache;
		} catch {
			return [];
		}
	}

	async pullModel(name: string): Promise<void> {
		try {
			await fetch(`${this.getEndpoint()}/api/pull`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, stream: false }),
			});
			this._installedCache = undefined;
			this._onDidModelsChange.fire();
		} catch {
			throw new Error(`Failed to pull model: ${name}`);
		}
	}

	async deleteModel(name: string): Promise<void> {
		try {
			await fetch(`${this.getEndpoint()}/api/delete`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name }),
			});
			this._installedCache = undefined;
			this._onDidModelsChange.fire();
		} catch {
			throw new Error(`Failed to delete model: ${name}`);
		}
	}
}

registerSingleton(IQ3ModelService, Q3ModelService, InstantiationType.Delayed);
