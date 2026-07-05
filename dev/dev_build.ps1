# Dev build: compile only, no packaging, no git reset
# Usage: powershell -ExecutionPolicy ByPass -File .\dev\dev_build.ps1

# Use Git Bash so `bash` is from Git, not WSL
$env:Path = "C:\Program Files\Git\bin;" + $env:Path

# Ensure conpty.dll exists (terminals won't work without it)
$ptyPath = "vscode/node_modules/node-pty/build/Release/conpty/conpty.dll"
if (-Not (Test-Path $ptyPath)) {
    Write-Host "[dev_build] conpty.dll missing, rebuilding node-pty..." -ForegroundColor Yellow
    Push-Location vscode
    npm rebuild node-pty 2>&1 | Out-Host
    Pop-Location
    if (Test-Path $ptyPath) {
        Write-Host "[dev_build] conpty.dll rebuilt successfully" -ForegroundColor Green
    } else {
        Write-Host "[dev_build] WARNING: conpty.dll still missing after rebuild" -ForegroundColor Red
    }
}

bash ./dev/build.sh -d -s
