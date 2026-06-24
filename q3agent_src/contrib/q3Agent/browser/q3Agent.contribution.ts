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
import { Q3AgentViewPane } from './q3AgentView.js';

export const Q3_AGENT_VIEW_ID = 'workbench.view.q3Agent';

const agentViewIcon = registerIcon('q3-agent-view-icon', Codicon.copilot, nls.localize('q3AgentViewIcon', 'View icon of the Q3 Agent view.'));

const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: Q3_AGENT_VIEW_ID,
	title: nls.localize2('q3Agent', 'Q3 Agent'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [Q3_AGENT_VIEW_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: Q3_AGENT_VIEW_ID,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);

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

// Register configuration
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'q3.agent',
	title: nls.localize('q3AgentSettings', 'Q3 Agent'),
	type: 'object',
	properties: {
		'q3.agent.model': {
			type: 'string',
			default: 'qwen3-coder:8b',
			description: nls.localize('q3.agent.model', 'The Ollama model to use for the agent.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.endpoint': {
			type: 'string',
			default: 'http://localhost:11434',
			description: nls.localize('q3.agent.endpoint', 'The Ollama API endpoint URL.'),
			scope: ConfigurationScope.APPLICATION,
		},
		'q3.agent.temperature': {
			type: 'number',
			default: 0.7,
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
			default: 20,
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
	},
});
