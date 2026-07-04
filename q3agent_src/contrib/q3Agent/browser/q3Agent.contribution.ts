/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainer, IViewContainersRegistry, ViewContainerLocation, Extensions as ViewContainerExtensions, IViewsRegistry } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Q3AgentViewPane } from './q3AgentView.js';
import { Q3AgentStartupContribution } from './q3AgentStartup.js';
import { Q3InlineCompletionsProvider } from './q3InlineCompletions.js';
import '../../../services/q3Agent/common/q3LlamaCppService.js';

export const Q3_AGENT_VIEW_ID = 'workbench.view.q3Agent';

const agentViewIcon = registerIcon('q3-agent-view-icon', Codicon.copilot, nls.localize('q3AgentViewIcon', 'View icon of the Q3 Agent view.'));

const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: Q3_AGENT_VIEW_ID,
	title: nls.localize2('q3Agent', 'Q3 Agent'),
	icon: agentViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [Q3_AGENT_VIEW_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: Q3_AGENT_VIEW_ID,
	hideIfEmpty: false,
	order: 1,
}, ViewContainerLocation.AuxiliaryBar);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: 'workbench.q3Agent',
	name: nls.localize2('q3Agent', 'Q3 Agent'),
	containerIcon: agentViewIcon,
	canMoveView: true,
	canToggleVisibility: true,
	ctorDescriptor: new SyncDescriptor(Q3AgentViewPane),
	openCommandActionDescriptor: {
		id: 'workbench.action.q3Agent.open',
		title: nls.localize2('q3Agent.open', 'Open Q3 Agent'),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
		},
		order: 1,
	},
}], VIEW_CONTAINER);

// Register startup contribution (model download prompt)
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(Q3AgentStartupContribution, LifecyclePhase.Restored);

// Register inline completions provider
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(Q3InlineCompletionsProvider, LifecyclePhase.Restored);

// Register configuration
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'q3.agent',
	title: nls.localize('q3AgentSettings', 'Q3 Agent'),
	type: 'object',
	properties: {
		'q3.agent.model': {
			type: 'string',
			default: 'qwen3-coder:30b',
			description: nls.localize('q3.agent.model', 'The model alias to use for the agent.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.endpoint': {
			type: 'string',
			default: 'http://127.0.0.1:8081',
			description: nls.localize('q3.agent.endpoint', 'The llama-swap API endpoint URL.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.binaryPath': {
			type: 'string',
			default: '',
			description: nls.localize('q3.agent.llamacpp.binaryPath', 'Path to llama-server.exe. Leave empty to use bundled binary.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.modelPath': {
			type: 'string',
			default: '',
			description: nls.localize('q3.agent.llamacpp.modelPath', 'Path to the GGUF model file for llama.cpp backend.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.port': {
			type: 'number',
			default: 8080,
			minimum: 1024,
			maximum: 65535,
			description: nls.localize('q3.agent.llamacpp.port', 'Port for the llama.cpp server.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.ctxSize': {
			type: 'number',
			default: 32768,
			minimum: 2048,
			maximum: 131072,
			description: nls.localize('q3.agent.llamacpp.ctxSize', 'Context window size for llama.cpp. Larger uses more VRAM for KV cache.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.kvCacheType': {
			type: 'string',
			enum: ['f16', 'q8_0', 'q4_0'],
			default: 'q8_0',
			enumDescriptions: [
				nls.localize('q3.agent.llamacpp.kvCacheType.f16', 'Full precision — best quality, most VRAM'),
				nls.localize('q3.agent.llamacpp.kvCacheType.q8_0', '8-bit quantized — good quality, half the VRAM (recommended)'),
				nls.localize('q3.agent.llamacpp.kvCacheType.q4_0', '4-bit quantized — lower quality, quarter VRAM'),
			],
			description: nls.localize('q3.agent.llamacpp.kvCacheType', 'KV cache quantization type. Reduces VRAM usage for context window.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.moeOffload': {
			type: 'boolean',
			default: true,
			description: nls.localize('q3.agent.llamacpp.moeOffload', 'Offload MoE expert layers to CPU. Reduces VRAM usage for MoE models like Qwen3-Coder-30B.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.triAttention': {
			type: 'boolean',
			default: false,
			description: nls.localize('q3.agent.llamacpp.triAttention', 'Enable TriAttention KV cache pruning. Reduces memory for long contexts. Requires calibration file.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.triAttentionBudget': {
			type: 'number',
			default: 4096,
			minimum: 512,
			maximum: 32768,
			description: nls.localize('q3.agent.llamacpp.triAttentionBudget', 'Maximum tokens to keep in KV cache when TriAttention is enabled.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.gpuLayers': {
			type: 'number',
			default: 99,
			minimum: 0,
			maximum: 999,
			description: nls.localize('q3.agent.llamacpp.gpuLayers', 'Number of model layers to offload to GPU (99 = all non-MoE layers).'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.llamaSwapPath': {
			type: 'string',
			default: '',
			description: nls.localize('q3.agent.llamacpp.llamaSwapPath', 'Path to llama-swap binary. If set, Q3 will use llama-swap as a proxy with TTL auto-unload. Leave empty for direct llama-server launch.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.serverBinaryPath': {
			type: 'string',
			default: '',
			description: nls.localize('q3.agent.llamacpp.serverBinaryPath', 'Path to llama-server.exe for use with llama-swap. Required when llamaSwapPath is set.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.llamacpp.ttl': {
			type: 'number',
			default: 300,
			minimum: 0,
			maximum: 3600,
			description: nls.localize('q3.agent.llamacpp.ttl', 'Time-to-live in seconds for auto-unloading idle model when using llama-swap. 0 = never unload.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.temperature': {
			type: 'number',
			default: 0,
			minimum: 0,
			maximum: 2,
			description: nls.localize('q3.agent.temperature', 'Temperature for LLM generation (0=deterministic, 2=creative).'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.maxTokens': {
			type: 'number',
			default: 4096,
			minimum: 256,
			maximum: 32768,
			description: nls.localize('q3.agent.maxTokens', 'Maximum number of tokens to generate per response.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.maxLoopSteps': {
			type: 'number',
			default: 30,
			minimum: 1,
			maximum: 100,
			description: nls.localize('q3.agent.maxLoopSteps', 'Maximum number of agentic loop steps before stopping.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.autoApproveTools': {
			type: 'boolean',
			default: false,
			description: nls.localize('q3.agent.autoApproveTools', 'Automatically approve tool calls without user confirmation.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.maxRetries': {
			type: 'number',
			default: 3,
			minimum: 0,
			maximum: 10,
			description: nls.localize('q3.agent.maxRetries', 'Maximum number of retry attempts for failed LLM requests.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.retryDelay': {
			type: 'number',
			default: 1000,
			minimum: 100,
			maximum: 30000,
			description: nls.localize('q3.agent.retryDelay', 'Base delay in milliseconds for retry backoff (doubles each retry).'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.warmUpModel': {
			type: 'boolean',
			default: true,
			description: nls.localize('q3.agent.warmUpModel', 'Pre-load the model into GPU memory on startup for faster first response.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.inlineCompletion.enabled': {
			type: 'boolean',
			default: true,
			description: nls.localize('q3.inlineCompletion.enabled', 'Enable AI-powered inline code completions (ghost text).'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.inlineCompletion.model': {
			type: 'string',
			default: '',
			description: nls.localize('q3.inlineCompletion.model', 'The model to use for inline completions. Leave empty to use the agent model.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.inlineCompletion.maxTokens': {
			type: 'number',
			default: 128,
			minimum: 16,
			maximum: 1024,
			description: nls.localize('q3.inlineCompletion.maxTokens', 'Maximum number of tokens to generate per inline completion.'),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});
