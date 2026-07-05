#!/usr/bin/env bash
# Generates dev/q3agent.patch from sed patches in apply_q3agent.sh
# Usage: bash dev/generate_patch.sh
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
VSCODE_DIR="${ROOT_DIR}/vscode"
PATCH_FILE="${SCRIPT_DIR}/q3agent.patch"

PATCHED_FILES=(
  "src/vs/workbench/workbench.common.main.ts"
  "src/vs/code/electron-browser/workbench/workbench.html"
  "src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts"
  "product.json"
  "src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts"
  "src/vs/platform/agentHost/node/agentHostMain.ts"
  "src/vs/platform/agentHost/node/agentHostServerMain.ts"
  "src/vs/platform/agentHost/test/node/historyRecordFixtures.ts"
  "build/lib/esbuild.ts"
  "build/gulpfile.vscode.ts"
  "build/gulpfile.reh.ts"
  "build/npm/postinstall.ts"
)

# Step 1: Reset all patched files to committed state
echo "[patch-gen] Resetting patched files to committed state..."
cd "${VSCODE_DIR}"
for f in "${PATCHED_FILES[@]}"; do
  git checkout -- "${f}" 2>/dev/null || true
done
cd "${ROOT_DIR}"

# Step 2: Apply sed patches (PATCHES_ONLY=1 skips junctions)
echo "[patch-gen] Applying sed patches..."
export PATCHES_ONLY=1
export VSCODE_DIR="${VSCODE_DIR}"
. "${SCRIPT_DIR}/apply_q3agent.sh" || true
unset PATCHES_ONLY

# Step 3: Generate diff
echo "[patch-gen] Generating patch file..."
cd "${VSCODE_DIR}"
git diff -- "${PATCHED_FILES[@]}" > "${PATCH_FILE}"
cd "${ROOT_DIR}"

PATCH_LINES=$(wc -l < "${PATCH_FILE}")
echo "[patch-gen] Generated ${PATCH_FILE} (${PATCH_LINES} lines)"

if [[ "${PATCH_LINES}" -eq 0 ]]; then
  echo "[patch-gen] ERROR: Patch is empty. Files may not have been patched."
  exit 1
fi

# Step 4: Verify patch applies cleanly
echo "[patch-gen] Verifying patch..."
cd "${VSCODE_DIR}"
for f in "${PATCHED_FILES[@]}"; do
  git checkout -- "${f}" 2>/dev/null || true
done

if git apply --check "${PATCH_FILE}" 2>/dev/null; then
  git apply "${PATCH_FILE}"
  echo "[patch-gen] Patch verified and applied successfully."
else
  echo "[patch-gen] WARNING: Patch does not apply cleanly."
  exit 1
fi
cd "${ROOT_DIR}"

echo "[patch-gen] Done. Patch file: ${PATCH_FILE}"
