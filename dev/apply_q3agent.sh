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

# Patch agentHostMain.ts: comment out removed copilot/claude/otel imports and usages
AGENT_HOST_MAIN="${VSCODE_DIR}/src/vs/platform/agentHost/node/agentHostMain.ts"
if [[ -f "${AGENT_HOST_MAIN}" ]]; then
  if grep -q "from './copilot/copilotAgent.js'" "${AGENT_HOST_MAIN}"; then
    echo "[q3agent] Patching agentHostMain.ts to remove copilot/claude/otel references..."
    sed -i "s|import { CopilotAgent } from './copilot/copilotAgent.js';|// import { CopilotAgent } from './copilot/copilotAgent.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { ClaudeAgent } from './claude/claudeAgent.js';|// import { ClaudeAgent } from './claude/claudeAgent.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { ClaudeAgentSdkService, IClaudeAgentSdkService } from './claude/claudeAgentSdkService.js';|// import { ClaudeAgentSdkService, IClaudeAgentSdkService } from './claude/claudeAgentSdkService.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { ClaudeProxyService, IClaudeProxyService } from './claude/claudeProxyService.js';|// import { ClaudeProxyService, IClaudeProxyService } from './claude/claudeProxyService.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { IAgentHostOTelService } from '../common/otel/agentHostOTelService.js';|// import { IAgentHostOTelService } from '../common/otel/agentHostOTelService.js';|" "${AGENT_HOST_MAIN}"
    sed -i "s|import { AgentHostOTelService } from './otel/agentHostOTelService.js';|// import { AgentHostOTelService } from './otel/agentHostOTelService.js';|" "${AGENT_HOST_MAIN}"
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

# Patch gulpfile.vscode.ts: skip prepareBuiltInCopilotRipgrepShim (copilot extension stripped)
GULPFILE="${VSCODE_DIR}/build/gulpfile.vscode.ts"
if [[ -f "${GULPFILE}" ]]; then
  if ! grep -q "Skip copilot ripgrep shim" "${GULPFILE}"; then
    echo "[q3agent] Patching gulpfile.vscode.ts to skip copilot ripgrep shim..."
    sed -i 's|prepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);|// Skip copilot ripgrep shim since copilot extension was stripped\n\t\t// prepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);|' "${GULPFILE}"
    echo "[q3agent] gulpfile.vscode.ts patched."
  fi
fi
