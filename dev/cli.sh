export CARGO_NET_GIT_FETCH_WITH_CLI="true"
export VSCODE_CLI_APP_NAME="Q3 IDE"
export VSCODE_CLI_BINARY_NAME="q3ide-server-insiders"
export VSCODE_CLI_DOWNLOAD_URL="https://github.com/Q3 IDE/Q3 IDE-insiders/releases"
export VSCODE_CLI_QUALITY="insider"
export VSCODE_CLI_UPDATE_URL="https://raw.githubusercontent.com/Q3 IDE/versions/refs/heads/master"

cargo build --release --target aarch64-apple-darwin --bin=code

cp target/aarch64-apple-darwin/release/code "../../VSCode-darwin-arm64/Q3 IDE - Insiders.app/Contents/Resources/app/bin/q3ide-tunnel-insiders"

"../../VSCode-darwin-arm64/Q3 IDE - Insiders.app/Contents/Resources/app/bin/q3ide-insiders" serve-web
