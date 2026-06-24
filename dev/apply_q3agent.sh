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

# Copy contrib files
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3Agent.contribution.ts" "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3AgentStartup.ts"        "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
cp -f "${SRC_DIR}/contrib/q3Agent/browser/q3AgentView.ts"          "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/"
cp -f "${SRC_DIR}/contrib/q3Agent/browser/media/q3Agent.css"       "${VSCODE_DIR}/src/vs/workbench/contrib/q3Agent/browser/media/"

# Patch workbench.common.main.ts to register the contrib module
MAIN_FILE="${VSCODE_DIR}/src/vs/workbench/workbench.common.main.ts"
if ! grep -q "q3Agent" "${MAIN_FILE}"; then
  echo "[q3agent] Patching workbench.common.main.ts..."
  sed -i '/^\/\/ Output View$/a\
// Q3 Agent (AI coding assistant)\
import '\''./services/q3Agent/common/q3ModelService.js'\'';\
import '\''./services/q3Agent/common/q3LLMBridgeService.js'\'';\
import '\''./services/q3Agent/common/q3AgentService.js'\'';\
import '\''./contrib/q3Agent/browser/q3Agent.contribution.js'\'';\
' "${MAIN_FILE}"
  echo "[q3agent] workbench.common.main.ts patched."
else
  echo "[q3agent] workbench.common.main.ts already has q3Agent imports, skipping."
fi

echo "[q3agent] Done."
