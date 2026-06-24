<!-- order: 16 -->

# Extension: GitHub Copilot

Unlike Visual Studio Code, in Q3 IDE, Copilot features are disabled and not configured.

## Update your settings

In your settings, sets:
```
"chat.disableAIFeatures": false,
```

## Configure product.json

You need to create a custom `product.json` at the following location (replace `Q3 IDE` by `Q3 IDE - Insiders` if you use that):
- Windows: `%APPDATA%\Q3 IDE` or `%USERPROFILE%\AppData\Roaming\Q3 IDE`
- macOS: `~/Library/Application Support/Q3 IDE`
- Linux: `$XDG_CONFIG_HOME/Q3 IDE` or `~/.config/Q3 IDE`

Then you will need to follow the guide [Running with Code OSS](https://github.com/microsoft/vscode-copilot-chat/blob/main/CONTRIBUTING.md#running-with-code-oss) with the `product.json` file created previously.
You will need to add the properties: `trustedExtensionAuthAccess` and `defaultChatAgent`.
