#!/usr/bin/env bash
# Applies Q3 Agent source files into the vscode/ directory.
# This must be run after prepare_vscode.sh (which resets vscode/) and before compilation.
set -e

VSCODE_DIR="${VSCODE_DIR:-vscode}"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SRC_DIR="${SCRIPT_DIR}/../q3agent_src"

if [[ ! -d "${VSCODE_DIR}/src/vs/workbench" ]]; then
  echo "Error: ${VSCODE_DIR}/src/vs/workbench not found. Run prepare_vscode.sh first."
  exit 1
fi

echo "[q3agent] Copying Q3 Agent source files into vscode/..."

# Create directories
mkdir -p "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common"
mkdir -p "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/media"

# Copy service files
cp -f "${SRC_DIR}/services/q3Agent/common/q3Agent.ts"        "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common/"
cp -f "${SRC_DIR}/services/q3Agent/common/q3ModelService.ts"  "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common/"
cp -f "${SRC_DIR}/services/q3Agent/common/q3LLMBridgeService.ts" "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common/"
cp -f "${SRC_DIR}/services/q3Agent/common/q3AgentService.ts"  "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common/"
cp -f "${SRC_DIR}/services/q3Agent/common/q3LlamaCppService.ts" "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common/"
cp -f "${SRC_DIR}/services/q3Agent/common/q3LanguageModelProvider.ts" "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common/"
cp -f "${SRC_DIR}/services/q3Agent/common/editHelper.ts"       "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common/"
cp -f "${SRC_DIR}/services/q3Agent/common/textUtils.ts"        "${VSCODE_DIR}/src/vs/workbench/services/q3Agent/common/"

# Copy contrib files
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3Agent.contribution.ts" "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3AgentStartup.ts"        "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
# q3AgentView.ts no longer copied — old custom UI replaced by native chat view
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3ChatAgent.ts"          "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3Chat.contribution.ts"  "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3InlineCompletions.ts"   "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3InlineDiffController.ts" "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
cp -f "${SRC_DIR}/contrib/q3Agent/browser/media/q3Agent.css"       "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/media/"

# Patch workbench.common.main.ts to register the contrib module
MAIN_FILE="${VSCODE_DIR}/src/vs/workbench/workbench.common.main.ts"
if ! grep -q "q3Agent" "${MAIN_FILE}"; then
  echo "[q3agent] Patching workbench.common.main.ts..."
  sed -i '/^\/\/ Output View$/a\
// Q3 Agent (AI coding assistant)\
import '\''./services/q3Agent/common/q3ModelService.js'\'';\
import '\''./services/q3Agent/common/q3LLMBridgeService.js'\'';\
import '\''./services/q3Agent/common/q3LlamaCppService.js'\'';\
import '\''./services/q3Agent/common/q3AgentService.js'\'';\
import '\''./contrib/q3Agent/browser/q3Agent.contribution.js'\'';\
' "${MAIN_FILE}"
  echo "[q3agent] workbench.common.main.ts patched."
else
  echo "[q3agent] workbench.common.main.ts already has q3Agent imports, skipping."
fi

echo "[q3agent] Done."

# Disable VS Code's built-in auth and remote coding agents (Q3 IDE uses local LLM)
# Note: chat services must stay enabled — debug, terminal, notebook, search depend on them
if grep -q "contrib/authentication/browser/authentication.contribution" "${MAIN_FILE}" && ! grep -q "// import.*contrib/authentication" "${MAIN_FILE}"; then
  echo "[q3agent] Disabling VS Code auth/remoteCodingAgents contributions..."
  sed -i 's|^import .*/contrib/authentication/browser/authentication\.contribution\.js.;|// &|' "${MAIN_FILE}"
  sed -i 's|^import .*/contrib/remoteCodingAgents/browser/remoteCodingAgents\.contribution\.js.;|// &|' "${MAIN_FILE}"
  echo "[q3agent] VS Code auth/remoteCodingAgents contributions disabled."
fi

# Patch CSP in workbench.html to allow fetch() to localhost (for llama-swap)
WORKBENCH_HTML="${VSCODE_DIR}/src/vs/code/electron-browser/workbench/workbench.html"
if [[ -f "${WORKBENCH_HTML}" ]]; then
  if ! grep -q "127.0.0.1" "${WORKBENCH_HTML}"; then
    echo "[q3agent] Patching CSP in workbench.html to allow localhost connections..."
    sed -i "/ws:/a\\\t\t\t\t\thttp://127.0.0.1:*\n\t\t\t\t\thttp://localhost:*" "${WORKBENCH_HTML}"
    echo "[q3agent] CSP patched."
  fi
fi

# .moduleignore already has correct vscode-policy-watcher.node — no patch needed

# Patch chatSetupContributions.ts: disable Copilot setup agent registration
# Q3 IDE registers its own chat agent, so Copilot setup agents are not needed.
SETUP_CONTRIB="${VSCODE_DIR}/src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts"
if [[ -f "${SETUP_CONTRIB}" ]]; then
  if ! grep -q "Q3 IDE: setup agents disabled" "${SETUP_CONTRIB}"; then
    echo "[q3agent] Patching chatSetupContributions.ts to disable Copilot setup agents..."
    sed -i 's|this\.registerSetupAgents(context, controller);|// Q3 IDE: setup agents disabled — Q3ChatContribution registers its own agent\n\t\tvoid context; void controller; // suppress unused warnings\n\t\tvoid this.registerSetupAgents; // suppress unused method warning\n\t\t// this.registerSetupAgents(context, controller);|' "${SETUP_CONTRIB}"
    echo "[q3agent] chatSetupContributions.ts patched."
  fi
fi

# Patch product.json: replace Copilot defaultChatAgent with Q3 config
PRODUCT_JSON="${VSCODE_DIR}/product.json"
if [[ -f "${PRODUCT_JSON}" ]]; then
  if grep -q '"extensionId": "GitHub.copilot"' "${PRODUCT_JSON}"; then
    echo "[q3agent] Patching product.json to replace Copilot defaultChatAgent with Q3..."
    sed -i 's|"extensionId": "GitHub.copilot"|"extensionId": "q3-ide"|' "${PRODUCT_JSON}"
    sed -i 's|"chatExtensionId": "GitHub.copilot-chat"|"chatExtensionId": "q3-ide"|' "${PRODUCT_JSON}"
    sed -i 's|"chatExtensionOutputId": "GitHub.copilot-chat.GitHub Copilot Chat.log"|"chatExtensionOutputId": "q3-ide.Q3 Agent.log"|' "${PRODUCT_JSON}"
    sed -i 's|"chatExtensionOutputExtensionStateCommand": "github.copilot.debug.extensionState"|"chatExtensionOutputExtensionStateCommand": ""|' "${PRODUCT_JSON}"
    sed -i 's|"documentationUrl": "https://aka.ms/github-copilot-overview"|"documentationUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"termsStatementUrl": "https://aka.ms/github-copilot-terms-statement"|"termsStatementUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"privacyStatementUrl": "https://aka.ms/github-copilot-privacy-statement"|"privacyStatementUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"skusDocumentationUrl": "https://aka.ms/github-copilot-plans"|"skusDocumentationUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"publicCodeMatchesUrl": "https://aka.ms/github-copilot-match-public-code"|"publicCodeMatchesUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"managePlanUrl": "https://aka.ms/github-copilot-manage-plan"|"managePlanUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"upgradePlanUrl": "https://aka.ms/github-copilot-upgrade-plan"|"upgradePlanUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"signUpUrl": "https://aka.ms/github-sign-up"|"signUpUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"providerExtensionId": "vscode.github-authentication"|"providerExtensionId": ""|' "${PRODUCT_JSON}"
    sed -i 's|"providerUriSetting": "github-enterprise.uri"|"providerUriSetting": ""|' "${PRODUCT_JSON}"
    sed -i 's|"entitlementUrl": "https://api.github.com/copilot_internal/user"|"entitlementUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"entitlementSignupLimitedUrl": "https://api.github.com/copilot_internal/subscribe_limited_user"|"entitlementSignupLimitedUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"chatQuotaExceededContext": "github.copilot.chat.quotaExceeded"|"chatQuotaExceededContext": ""|' "${PRODUCT_JSON}"
    sed -i 's|"completionsQuotaExceededContext": "github.copilot.completions.quotaExceeded"|"completionsQuotaExceededContext": ""|' "${PRODUCT_JSON}"
    sed -i 's|"walkthroughCommand": "github.copilot.open.walkthrough"|"walkthroughCommand": ""|' "${PRODUCT_JSON}"
    sed -i 's|"completionsMenuCommand": "github.copilot.toggleStatusMenu"|"completionsMenuCommand": ""|' "${PRODUCT_JSON}"
    sed -i 's|"chatRefreshTokenCommand": "github.copilot.refreshToken"|"chatRefreshTokenCommand": ""|' "${PRODUCT_JSON}"
    sed -i 's|"generateCommitMessageCommand": "github.copilot.git.generateCommitMessage"|"generateCommitMessageCommand": ""|' "${PRODUCT_JSON}"
    sed -i 's|"resolveMergeConflictsCommand": "github.copilot.git.resolveMergeConflicts"|"resolveMergeConflictsCommand": ""|' "${PRODUCT_JSON}"
    sed -i 's|"completionsAdvancedSetting": "github.copilot.advanced"|"completionsAdvancedSetting": ""|' "${PRODUCT_JSON}"
    sed -i 's|"completionsEnablementSetting": "github.copilot.enable"|"completionsEnablementSetting": ""|' "${PRODUCT_JSON}"
    sed -i 's|"nextEditSuggestionsSetting": "github.copilot.nextEditSuggestions.enabled"|"nextEditSuggestionsSetting": ""|' "${PRODUCT_JSON}"
    sed -i 's|"tokenEntitlementUrl": "https://api.github.com/copilot_internal/v2/token"|"tokenEntitlementUrl": ""|' "${PRODUCT_JSON}"
    sed -i 's|"mcpRegistryDataUrl": "https://api.github.com/copilot/mcp_registry"|"mcpRegistryDataUrl": ""|' "${PRODUCT_JSON}"
    echo "[q3agent] product.json patched."
  fi
fi

# Disable welcome onboarding (requires defaultChatAgent with Copilot-specific URLs)
if grep -q "welcomeOnboarding/browser/welcomeOnboarding.contribution" "${MAIN_FILE}"; then
  echo "[q3agent] Disabling welcome onboarding contribution..."
  sed -i 's|import .*/contrib/welcomeOnboarding/browser/welcomeOnboarding\.contribution\.js.;|// &|' "${MAIN_FILE}"
  echo "[q3agent] Welcome onboarding disabled."
fi

# Patch startupPage.ts: remove onboarding imports and tryShowOnboarding method
STARTUP_PAGE="${VSCODE_DIR}/src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts"
if [[ -f "${STARTUP_PAGE}" ]]; then
  if grep -q "tryShowOnboarding" "${STARTUP_PAGE}"; then
    echo "[q3agent] Patching startupPage.ts to remove onboarding..."
    sed -i "/import { isWeb } from '..\/..\/..\/..\/base\/common\/platform.js';/d" "${STARTUP_PAGE}"
    sed -i "/import { IOnboardingService } from '..\/..\/welcomeOnboarding\/common\/onboardingService.js';/d" "${STARTUP_PAGE}"
    sed -i "/import { ONBOARDING_STORAGE_KEY } from '..\/..\/welcomeOnboarding\/common\/onboardingTypes.js';/d" "${STARTUP_PAGE}"
    sed -i '/@IOnboardingService private readonly onboardingService/d' "${STARTUP_PAGE}"
    sed -i '/this\.tryShowOnboarding();/d' "${STARTUP_PAGE}"
    sed -i '/private tryShowOnboarding/,/^	}/d' "${STARTUP_PAGE}"
    echo "[q3agent] startupPage.ts patched."
  fi
fi

# Patch agentHostMain.ts: comment out removed copilot/claude/otel imports and usages
AGENT_HOST_MAIN="${VSCODE_DIR}/src/vs/platform/agentHost/node/agentHostMain.ts"
if [[ -f "${AGENT_HOST_MAIN}" ]]; then
  if grep -q "from './copilot/copilotAgent.js'" "${AGENT_HOST_MAIN}"; then
    echo "[q3agent] Patching agentHostMain.ts to remove copilot/claude/otel references..."
    sed -i "s|import { CopilotAgent } from './copilot/copilotAgent.js';|// import { CopilotAgent } from './copilot/copilotAgent.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { CopilotApiService, ICopilotApiService } from './shared/copilotApiService.js';|// import { CopilotApiService, ICopilotApiService } from './shared/copilotApiService.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { ClaudeAgent } from './claude/claudeAgent.js';|// import { ClaudeAgent } from './claude/claudeAgent.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { ClaudeAgentSdkService, IClaudeAgentSdkService } from './claude/claudeAgentSdkService.js';|// import { ClaudeAgentSdkService, IClaudeAgentSdkService } from './claude/claudeAgentSdkService.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { ClaudeProxyService, IClaudeProxyService } from './claude/claudeProxyService.js';|// import { ClaudeProxyService, IClaudeProxyService } from './claude/claudeProxyService.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { IAgentHostOTelService } from '../common/otel/agentHostOTelService.js';|// import { IAgentHostOTelService } from '../common/otel/agentHostOTelService.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { AgentHostOTelService } from './otel/agentHostOTelService.js';|// import { AgentHostOTelService } from './otel/agentHostOTelService.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|const copilotApiService = instantiationService.createInstance(CopilotApiService, undefined);|// const copilotApiService = instantiationService.createInstance(CopilotApiService, undefined);|" "${AGENT_HOST_MAIN}"
    sed -i "s|diServices.set(ICopilotApiService, copilotApiService);|// diServices.set(ICopilotApiService, copilotApiService);|" "${AGENT_HOST_MAIN}"
    sed -i "s|const claudeProxyService = disposables.add(instantiationService.createInstance(ClaudeProxyService));|// const claudeProxyService = disposables.add(instantiationService.createInstance(ClaudeProxyService));|" "${AGENT_HOST_MAIN}"
    sed -i "s|diServices.set(IClaudeProxyService, claudeProxyService);|// diServices.set(IClaudeProxyService, claudeProxyService);|" "${AGENT_HOST_MAIN}"
    sed -i "s|const claudeAgentSdkService = instantiationService.createInstance(ClaudeAgentSdkService);|// const claudeAgentSdkService = instantiationService.createInstance(ClaudeAgentSdkService);|" "${AGENT_HOST_MAIN}"
    sed -i "s|diServices.set(IClaudeAgentSdkService, claudeAgentSdkService);|// diServices.set(IClaudeAgentSdkService, claudeAgentSdkService);|" "${AGENT_HOST_MAIN}"
    sed -i "s|const agentHostOTelService = disposables.add(instantiationService.createInstance(AgentHostOTelService));|// const agentHostOTelService = disposables.add(instantiationService.createInstance(AgentHostOTelService));|" "${AGENT_HOST_MAIN}"
    sed -i "s|diServices.set(IAgentHostOTelService, agentHostOTelService);|// diServices.set(IAgentHostOTelService, agentHostOTelService);|" "${AGENT_HOST_MAIN}"
    sed -i "s|agentService.registerProvider(instantiationService.createInstance(CopilotAgent));|// agentService.registerProvider(instantiationService.createInstance(CopilotAgent));|" "${AGENT_HOST_MAIN}"
    sed -i "s|agentService.registerProvider(instantiationService.createInstance(ClaudeAgent));|// agentService.registerProvider(instantiationService.createInstance(ClaudeAgent));|" "${AGENT_HOST_MAIN}"
    echo "[q3agent] agentHostMain.ts patched."
  fi
fi

# Patch agentHostServerMain.ts: comment out removed copilot/claude/otel imports and usages
AGENT_HOST_SERVER_MAIN="${VSCODE_DIR}/src/vs/platform/agentHost/node/agentHostServerMain.ts"
if [[ -f "${AGENT_HOST_SERVER_MAIN}" ]]; then
  if grep -q "from './copilot/copilotAgent.js'" "${AGENT_HOST_SERVER_MAIN}"; then
    echo "[q3agent] Patching agentHostServerMain.ts to remove copilot/claude/otel references..."
    sed -i "s|import { CopilotAgent } from './copilot/copilotAgent.js';|// import { CopilotAgent } from './copilot/copilotAgent.js';|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|import { CopilotApiService, ICopilotApiService } from './shared/copilotApiService.js';|// import { CopilotApiService, ICopilotApiService } from './shared/copilotApiService.js';|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|import { ClaudeAgent } from './claude/claudeAgent.js';|// import { ClaudeAgent } from './claude/claudeAgent.js';|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|import { ClaudeAgentSdkService, IClaudeAgentSdkService } from './claude/claudeAgentSdkService.js';|// import { ClaudeAgentSdkService, IClaudeAgentSdkService } from './claude/claudeAgentSdkService.js';|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|import { ClaudeProxyService, IClaudeProxyService } from './claude/claudeProxyService.js';|// import { ClaudeProxyService, IClaudeProxyService } from './claude/claudeProxyService.js';|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|import { IAgentHostOTelService } from '../common/otel/agentHostOTelService.js';|// import { IAgentHostOTelService } from '../common/otel/agentHostOTelService.js';|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|import { AgentHostOTelService } from './otel/agentHostOTelService.js';|// import { AgentHostOTelService } from './otel/agentHostOTelService.js';|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|const copilotApiService = instantiationService.createInstance(CopilotApiService, undefined);|// const copilotApiService = instantiationService.createInstance(CopilotApiService, undefined);|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|diServices.set(ICopilotApiService, copilotApiService);|// diServices.set(ICopilotApiService, copilotApiService);|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|const claudeProxyService = disposables.add(instantiationService.createInstance(ClaudeProxyService));|// const claudeProxyService = disposables.add(instantiationService.createInstance(ClaudeProxyService));|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|diServices.set(IClaudeProxyService, claudeProxyService);|// diServices.set(IClaudeProxyService, claudeProxyService);|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|const claudeAgentSdkService = instantiationService.createInstance(ClaudeAgentSdkService);|// const claudeAgentSdkService = instantiationService.createInstance(ClaudeAgentSdkService);|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|diServices.set(IClaudeAgentSdkService, claudeAgentSdkService);|// diServices.set(IClaudeAgentSdkService, claudeAgentSdkService);|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|const agentHostOTelService = disposables.add(instantiationService.createInstance(AgentHostOTelService));|// const agentHostOTelService = disposables.add(instantiationService.createInstance(AgentHostOTelService));|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|diServices.set(IAgentHostOTelService, agentHostOTelService);|// diServices.set(IAgentHostOTelService, agentHostOTelService);|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|const copilotAgent = disposables.add(instantiationService.createInstance(CopilotAgent));|// const copilotAgent = disposables.add(instantiationService.createInstance(CopilotAgent));|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|agentService.registerProvider(copilotAgent);|// agentService.registerProvider(copilotAgent);|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|const claudeAgent = disposables.add(instantiationService.createInstance(ClaudeAgent));|// const claudeAgent = disposables.add(instantiationService.createInstance(ClaudeAgent));|" "${AGENT_HOST_SERVER_MAIN}"
    sed -i "s|agentService.registerProvider(claudeAgent);|// agentService.registerProvider(claudeAgent);|" "${AGENT_HOST_SERVER_MAIN}"
    echo "[q3agent] agentHostServerMain.ts patched."
  fi
fi

# Patch historyRecordFixtures.ts: stub out removed copilot module imports
HISTORY_FIXTURES="${VSCODE_DIR}/src/vs/platform/agentHost/test/node/historyRecordFixtures.ts"
if [[ -f "${HISTORY_FIXTURES}" ]]; then
  if grep -q "from '../../node/copilot/copilotToolDisplay.js'" "${HISTORY_FIXTURES}"; then
    echo "[q3agent] Patching historyRecordFixtures.ts to stub removed copilot imports..."
    sed -i "s|import { getInvocationMessage, getPastTenseMessage, getShellLanguage, getSubagentMetadata, getToolDisplayName, getToolInputString, getToolKind, isEditTool, isHiddenTool, synthesizeSkillToolCall } from '../../node/copilot/copilotToolDisplay.js';|// Stubs for removed copilot modules\nfunction getInvocationMessage(_toolName: string, displayName: string, _params?: any): string { return displayName; }\nfunction getPastTenseMessage(_toolName: string, displayName: string, _params?: any, _success?: boolean): string { return displayName; }\nfunction getShellLanguage(_toolName: string): string \| undefined { return undefined; }\nfunction getSubagentMetadata(_params?: any): { agentName?: string; description?: string } \| undefined { return undefined; }\nfunction getToolDisplayName(toolName: string): string { return toolName; }\nfunction getToolInputString(_toolName: string, _params?: any, toolArgs?: string): string \| undefined { return toolArgs; }\nfunction getToolKind(_toolName: string): 'search' \| 'terminal' \| 'subagent' \| undefined { return undefined; }\nfunction isEditTool(_toolName: string, _command?: string): boolean { return false; }\nfunction isHiddenTool(_toolName: string): boolean { return false; }\nfunction synthesizeSkillToolCall(_data: any, id: string): { toolCallId: string; toolName: string; displayName: string; invocationMessage: string; pastTenseMessage: string } { return { toolCallId: id, toolName: 'skill', displayName: 'Skill', invocationMessage: 'Skill', pastTenseMessage: 'Skill' }; }|" "${HISTORY_FIXTURES}"
    sed -i "s|import type { ISessionEvent, ISessionEventMessage, ISessionEventSkillInvoked, ISessionEventSubagentStarted, ISessionEventToolComplete, ISessionEventToolStart } from '../../node/copilot/mapSessionEvents.js';|// Stubs for removed copilot event types\ntype ISessionEvent = any;\ntype ISessionEventMessage = any;\ntype ISessionEventSkillInvoked = any;\ntype ISessionEventSubagentStarted = any;\ntype ISessionEventToolComplete = any;\ntype ISessionEventToolStart = any;|" "${HISTORY_FIXTURES}"
    sed -i "s|d?.toolRequests?.map(tr => ({|d?.toolRequests?.map((tr: any) => ({" "${HISTORY_FIXTURES}"
    echo "[q3agent] historyRecordFixtures.ts patched."
  fi
fi

# Patch esbuild.ts: remove --mangle-privates flag
ESBUILD_FILE="${VSCODE_DIR}/build/lib/esbuild.ts"
if [[ -f "${ESBUILD_FILE}" ]]; then
  if grep -q "mangle-privates" "${ESBUILD_FILE}"; then
    echo "[q3agent] Patching esbuild.ts to remove --mangle-privates..."
    sed -i "/args.push('--mangle-privates')/d" "${ESBUILD_FILE}"
    echo "[q3agent] esbuild.ts patched."
  fi
fi

# Patch gulpfile.vscode.ts: remove Copilot refs + restructure prepack/packing tasks
GULPFILE_VSCODE="${VSCODE_DIR}/build/gulpfile.vscode.ts"
if [[ -f "${GULPFILE_VSCODE}" ]]; then
  echo "[q3agent] Patching gulpfile.vscode.ts..."
  # Remove copilot imports
  sed -i 's|, compileCopilotExtensionBuildTask||g' "${GULPFILE_VSCODE}"
  sed -i 's|compileCopilotExtensionBuildTask, ||g' "${GULPFILE_VSCODE}"
  sed -i "/import { getCopilotExcludeFilter, prepareBuiltInCopilotRipgrepShim } from/d" "${GULPFILE_VSCODE}"
  # Remove copilot filter call
  sed -i '/\.pipe(filter(getCopilotExcludeFilter(platform, arch)))/d' "${GULPFILE_VSCODE}"
  # Remove prepareCopilotRipgrepShimTask function and call
  sed -i '/^function prepareCopilotRipgrepShimTask(/,/^}/d' "${GULPFILE_VSCODE}"
  sed -i '/prepareCopilotRipgrepShimTask(platform, arch, destinationFolderName)/d' "${GULPFILE_VSCODE}"
  echo "[q3agent] gulpfile.vscode.ts patched."
fi

# Patch gulpfile.reh.ts: remove Copilot refs
GULPFILE_REH="${VSCODE_DIR}/build/gulpfile.reh.ts"
if [[ -f "${GULPFILE_REH}" ]]; then
  echo "[q3agent] Patching gulpfile.reh.ts..."
  sed -i 's|, compileCopilotExtensionBuildTask||g' "${GULPFILE_REH}"
  sed -i 's|compileCopilotExtensionBuildTask, ||g' "${GULPFILE_REH}"
  sed -i "/import { getCopilotExcludeFilter, prepareBuiltInCopilotRipgrepShim } from/d" "${GULPFILE_REH}"
  sed -i '/\.pipe(filter(getCopilotExcludeFilter(platform, arch)))/d' "${GULPFILE_REH}"
  sed -i '/^function prepareCopilotRipgrepShimTaskREH(/,/^}/d' "${GULPFILE_REH}"
  sed -i '/prepareCopilotRipgrepShimTaskREH(platform, arch, destinationFolderName)/d' "${GULPFILE_REH}"
  echo "[q3agent] gulpfile.reh.ts patched."
fi

# Patch postinstall.ts: replace async spawn with execSync to fix cmd.exe ENOENT on Windows
POSTINSTALL_FILE="${VSCODE_DIR}/build/npm/postinstall.ts"
if [[ -f "${POSTINSTALL_FILE}" ]]; then
  if grep -q "child_process.spawn(command, args" "${POSTINSTALL_FILE}"; then
    echo "[q3agent] Patching postinstall.ts to use execSync..."
    python3 -c "
with open('${POSTINSTALL_FILE}', 'r') as f:
    content = f.read()
old = '''function spawnAsync(command: string, args: string[], opts: child_process.SpawnOptions): Promise<string> {
\treturn new Promise((resolve, reject) => {
\t\tconst child = child_process.spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
\t\tlet output = '';
\t\tchild.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
\t\tchild.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
\t\tchild.on('error', reject);
\t\tchild.on('close', (code) => {
\t\t\tif (code !== 0) {
\t\t\t\treject(new Error(\`Process exited with code: \${code}\\\n\${output}\`));
\t\t\t} else {
\t\t\t\tresolve(output);
\t\t\t}
\t\t});
\t});'''
new = '''function spawnAsync(command: string, args: string[], opts: child_process.SpawnOptions): Promise<string> {
\treturn new Promise((resolve, reject) => {
\t\ttry {
\t\t\tconst fullCommand = \`\${command} \${args.join(' ')}\`;
\t\t\tconst { shell, ...restOpts } = opts;
\t\t\tconst result = child_process.execSync(fullCommand, { ...restOpts, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8' });
\t\t\tresolve(result as string);
\t\t} catch (err: any) {
\t\t\tif (err.stdout || err.stderr) {
\t\t\t\treject(new Error(\`Process exited with code: \${err.status}\\\n\${err.stdout?.toString()}\\\n\${err.stderr?.toString()}\`));
\t\t\t} else {
\t\t\t\treject(err);
\t\t\t}
\t\t}
\t});'''
if old in content:
    content = content.replace(old, new)
    with open('${POSTINSTALL_FILE}', 'w') as f:
        f.write(content)
    print('[q3agent] postinstall.ts patched.')
else:
    print('[q3agent] postinstall.ts already patched or pattern not found.')
"
  fi
fi
