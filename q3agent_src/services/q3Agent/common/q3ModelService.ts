/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { IQ3ModelService, IQ3ModelInfo, IQ3ModelPreset } from './q3Agent.js';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8081';

export interface IQ3GGUFModelPreset {
	name: string;
	displayName: string;
	hfRepoId: string;
	hfFilePattern: string;
	description: string;
	size: string;
	category: 'coder' | 'general' | 'reasoning';
}

const GGUF_MODEL_PRESETS: IQ3GGUFModelPreset[] = [
	{ name: 'Qwen3-Coder-30B-Q4_K_M', displayName: 'Qwen3-Coder 30B (Q4_K_M)', hfRepoId: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', hfFilePattern: '*UD-Q4_K_M*.gguf', description: '30B MoE (3.3B active). Unsloth Dynamic Q4_K_M. Best speed/quality for RTX 4070.', size: '19 GB', category: 'coder' },
	{ name: 'Qwen3-Coder-30B-IQ4_NL', displayName: 'Qwen3-Coder 30B (IQ4_NL)', hfRepoId: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', hfFilePattern: '*UD-IQ4_NL*.gguf', description: '30B MoE. Slightly smaller than Q4_K_M, good quality.', size: '17 GB', category: 'coder' },
	{ name: 'Qwen3-Coder-30B-Q4_K_XL', displayName: 'Qwen3-Coder 30B (Q4_K_XL MTP)', hfRepoId: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', hfFilePattern: '*UD-Q4_K_XL*.gguf', description: '30B MoE with MTP (speculative decoding). Fastest variant.', size: '18 GB', category: 'coder' },
];

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

	// === Cloud Models ===
	{ name: 'glm-5.2:cloud', displayName: 'GLM-5.2 (Cloud)', description: 'Z.ai flagship. 744B MoE, 1M context. Cloud-only.', size: 'Cloud', cloud: true, category: 'coder' },
	{ name: 'kimi-k2.7-code:cloud', displayName: 'Kimi K2.7 Code (Cloud)', description: 'Moonshot coding model. 256K context, text+image. Cloud-only.', size: 'Cloud', cloud: true, category: 'coder' },
	{ name: 'kimi-k2.6:cloud', displayName: 'Kimi K2.6 (Cloud)', description: 'Moonshot general model. Cloud-only.', size: 'Cloud', cloud: true, category: 'general' },
];

export class Q3ModelService extends Disposable implements IQ3ModelService {
	declare readonly _serviceBrand: undefined;

	private _currentModel: string = 'qwen3-coder:30b';
	private _installedCache: IQ3ModelInfo[] | undefined;

	private readonly _onDidModelsChange = new Emitter<void>();
	readonly onDidModelsChange = this._onDidModelsChange.event;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IRequestService private readonly _requestService: IRequestService,
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

	async getModels(): Promise<IQ3ModelInfo[]> {
		if (this._installedCache) {
			return this._installedCache;
		}
		try {
			const text = await this._request(`${this.getEndpoint()}/api/tags`, 'GET');
			if (text === null) {
				return [];
			}
			const data = JSON.parse(text) as { models: any[] };
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
			await this._request(`${this.getEndpoint()}/api/pull`, 'POST', JSON.stringify({ name, stream: false }));
			this._installedCache = undefined;
			this._onDidModelsChange.fire();
		} catch {
			throw new Error(`Failed to pull model: ${name}`);
		}
	}

	async deleteModel(name: string): Promise<void> {
		try {
			await this._request(`${this.getEndpoint()}/api/delete`, 'DELETE', JSON.stringify({ name }));
			this._installedCache = undefined;
			this._onDidModelsChange.fire();
		} catch {
			throw new Error(`Failed to delete model: ${name}`);
		}
	}

	refreshModels(): void {
		this._installedCache = undefined;
		this._onDidModelsChange.fire();
	}

	getGGUFModelPresets(): IQ3GGUFModelPreset[] {
		return GGUF_MODEL_PRESETS;
	}

	getModelsDir(): string {
		const path = this._safeRequire('path');
		const os = this._safeRequire('os');
		const fs = this._safeRequire('fs');
		if (!path || !os || !fs) { return ''; }
		const dir = path.join(os.homedir(), '.q3ide', 'models');
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	private _safeRequire(module: string): any {
		try {
			return globalThis.require(module);
		} catch {
			return undefined;
		}
	}

	listLocalGGUFModels(): string[] {
		try {
			const fs = this._safeRequire('fs');
			const path = this._safeRequire('path');
			const os = this._safeRequire('os');
			if (!fs || !path || !os) { return []; }
			const dir = path.join(os.homedir(), '.q3ide', 'models');
			if (!fs.existsSync(dir)) { return []; }
			return fs.readdirSync(dir).filter((f: string) => f.endsWith('.gguf'));
		} catch {
			return [];
		}
	}

	async downloadGGUFModel(preset: IQ3GGUFModelPreset, onProgress?: (downloaded: number, total: number) => void): Promise<string> {
		const modelsDir = this.getModelsDir();

		// First, get the file listing from HuggingFace API
		const apiUrl = `https://huggingface.co/api/models/${preset.hfRepoId}`;
		const apiResponse = await fetch(apiUrl);
		if (!apiResponse.ok) {
			throw new Error(`Failed to fetch model info from HuggingFace: ${apiResponse.status}`);
		}
		const apiData = await apiResponse.json() as any;
		const siblings: { rfilename: string }[] = apiData.siblings || [];

		// Find matching file(s) — may be split across multiple shards
		const matchingFiles = siblings
			.map(s => s.rfilename)
			.filter(f => f.endsWith('.gguf') && this._matchesPattern(f, preset.hfFilePattern));

		if (matchingFiles.length === 0) {
			throw new Error(`No GGUF files matching pattern ${preset.hfFilePattern} found in ${preset.hfRepoId}`);
		}

		// Download each file
		const downloadedPaths: string[] = [];
		const path = globalThis.require('path');
		const fs = globalThis.require('fs');
		for (const file of matchingFiles) {
			const fileName = path.basename(file);
			const localPath = path.join(modelsDir, fileName);

			// Skip if already downloaded
			if (fs.existsSync(localPath)) {
				downloadedPaths.push(localPath);
				continue;
			}

			const downloadUrl = `https://huggingface.co/${preset.hfRepoId}/resolve/main/${file}`;
			await this._downloadFile(downloadUrl, localPath, onProgress);
			downloadedPaths.push(localPath);
		}

		// Return the first file path (llama-server can handle multi-shard automatically)
		return downloadedPaths[0];
	}

	private _matchesPattern(fileName: string, pattern: string): boolean {
		const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
		return regex.test(fileName);
	}

	private async _downloadFile(url: string, localPath: string, onProgress?: (downloaded: number, total: number) => void): Promise<void> {
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(`Download failed: ${res.status} ${res.statusText}`);
		}

		const fs = globalThis.require('fs');
		const total = parseInt(res.headers.get('content-length') || '0', 10);
		const reader = res.body!.getReader();
		const fileStream = fs.createWriteStream(localPath);
		let downloaded = 0;
	
		for (;;) {
			const { done, value } = await reader.read();
			if (done) { break; }
			fileStream.write(value);
			downloaded += value.length;
			if (onProgress && total > 0) {
				onProgress(downloaded, total);
			}
		}

			fileStream.end();
			await new Promise<void>((resolve) => fileStream.on('close', resolve));
	}

	private async _request(url: string, method: string, body?: string): Promise<string | null> {
		try {
			const context = await this._requestService.request({
				url,
				type: method,
				data: body,
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				callSite: 'q3agent',
			}, CancellationToken.None);
			if (context.res.statusCode && (context.res.statusCode < 200 || context.res.statusCode >= 300)) {
				return null;
			}
			const buffer = await streamToBuffer(context.stream);
			return buffer.toString();
		} catch {
			return null;
		}
	}
}

registerSingleton(IQ3ModelService, Q3ModelService, InstantiationType.Delayed);
