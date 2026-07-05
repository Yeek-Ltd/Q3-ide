# Dev build: compile only, no packaging, no git reset
# Usage: powershell -ExecutionPolicy ByPass -File .\dev\dev_build.ps1

# Use Git Bash so `bash` is from Git, not WSL
$env:Path = "C:\Program Files\Git\bin;" + $env:Path

bash ./dev/build.sh -d -s
