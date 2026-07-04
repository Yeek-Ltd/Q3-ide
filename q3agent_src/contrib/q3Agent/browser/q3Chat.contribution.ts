/*---------------------------------------------------------------------------------------------}
 *  Copyright (c) Q3 IDE contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { ChatEntitlementContextKeys } from '../../../services/chat/common/chatEntitlementService.js';
import { Q3LanguageModelProvider, Q3_VENDOR_ID } from '../../../services/q3Agent/common/q3LanguageModelProvider.js';
import { Q3ChatAgent } from './q3ChatAgent.js';

export class Q3ChatContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.q3Chat';

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
	) {
		super();

		this._registerQ3Chat();
	}

	private _registerQ3Chat(): void {
		const disposables = this._register(new DisposableStore());

		// 1. Bypass Copilot setup gate: set chatSetupHidden = true
		//    This prevents ChatSetupContribution from registering Copilot setup agents.
		//    The chat view will still be visible because panelParticipantRegistered
		//    becomes true when we register our default agent with implementation below.
		const hiddenKey = ChatEntitlementContextKeys.Setup.hidden.bindTo(this._contextKeyService);
		hiddenKey.set(true);
		disposables.add({ dispose: () => hiddenKey.reset() });

		// 2. Register Q3 vendor
		const languageModelsService = this._instantiationService.invokeFunction(accessor => accessor.get(ILanguageModelsService));
		languageModelsService.deltaLanguageModelChatProviderDescriptors(
			[{
				vendor: Q3_VENDOR_ID,
				displayName: 'Q3 IDE',
				configuration: undefined,
				managementCommand: undefined,
				when: undefined,
			}],
			[]
		);

		// 3. Register Q3 language model provider
		const provider = this._instantiationService.createInstance(Q3LanguageModelProvider);
		disposables.add(languageModelsService.registerLanguageModelProvider(Q3_VENDOR_ID, provider));

		// 4. Register Q3 agent as default for the panel
		const chatAgentService = this._instantiationService.invokeFunction(accessor => accessor.get(IChatAgentService));

		const agentId = 'q3.agent';
		disposables.add(chatAgentService.registerAgent(agentId, {
			id: agentId,
			name: 'q3',
			fullName: 'Q3 Agent',
			description: localize('q3AgentDescription', "AI coding assistant powered by local LLM"),
			isDefault: true,
			isCore: true,
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionPublisherId: nullExtensionDescription.publisher,
			extensionDisplayName: nullExtensionDescription.name,
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			slashCommands: [],
			disambiguation: [],
			metadata: {
				helpTextPrefix: localize('q3AgentHelp', "I'm Q3 Agent, a local AI coding assistant. I can read files, edit code, run commands, and search your workspace."),
				sampleRequest: localize('q3AgentSample', "Help me fix a bug in my code"),
			},
		}));

		const agent = this._instantiationService.createInstance(Q3ChatAgent);
		disposables.add(agent);
		disposables.add(chatAgentService.registerAgentImplementation(agentId, agent));
	}
}
