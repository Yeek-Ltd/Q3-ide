# Watch mode: recompile TypeScript on save
# Usage: powershell -ExecutionPolicy ByPass -File .\dev\dev_watch.ps1
#
# Edits in q3agent_src/ are visible through junctions to vscode/src/
# This watches for changes and recompiles incrementally (~2-5 sec per change)
# After recompile, relaunch: cd vscode && .\scripts\code.bat

$env:Path = "C:\Program Files\Git\bin;" + $env:Path

Write-Host "[dev-watch] Starting gulp compile-watch-build in vscode/..."
Write-Host "[dev-watch] Edit files in q3agent_src/ — changes are visible via junctions"
Write-Host "[dev-watch] After recompile, relaunch: cd vscode && .\scripts\code.bat"
Write-Host ""

Push-Location vscode
npx gulp compile-watch-build
Pop-Location
