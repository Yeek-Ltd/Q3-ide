# Q3 IDE

A standalone, heavily modified VS Code fork with a deeply integrated offline AI agent powered by **Qwen 3 Coder**. No cloud dependencies  all inference runs locally.

## Features

- **Offline AI Agent**  Chat, code completion, refactoring, and multi-step agentic workflows powered by Qwen 3 Coder running locally via Ollama
- **Inline Completions**  Ghost text suggestions using fill-in-the-middle (FIM) prompts
- **Agentic Tools**  Read/write files, grep search, run terminal commands, git operations  all with user approval gates
- **Privacy First**  Zero network calls for AI inference. Your code never leaves your machine
- **Based on VS Code**  Full compatibility with VS Code extensions via Open VSX registry

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (see `.nvmrc` for required version)
- [Python](https://www.python.org/) (for native module builds)
- [Git](https://git-scm.com/)
- [Ollama](https://ollama.com/) (for local LLM inference)
- Windows: Visual Studio Build Tools with C++ workload
- macOS: Xcode Command Line Tools
- Linux: `build-essential`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`

### Build from Source

```bash
# Clone this repo
git clone https://github.com/yeekcay/Q3-ide.git
cd Q3-ide

# Pull Qwen 3 Coder model
ollama pull qwen3-coder

# Build (requires Git Bash on Windows)
./dev/build.sh
```

### Download Pre-built

Download the latest release from [GitHub Releases](https://github.com/yeekcay/Q3-ide/releases).

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `qwen.agent.model` | `qwen3-coder:8b` | Ollama model tag |
| `qwen.agent.endpoint` | `http://localhost:11434` | Ollama API endpoint |
| `qwen.agent.temperature` | `0.7` | LLM temperature |
| `qwen.agent.maxTokens` | `4096` | Max tokens per response |
| `qwen.agent.inlineCompletions` | `true` | Enable inline ghost text |
| `qwen.agent.autoApproveReads` | `true` | Auto-approve file read operations |
| `qwen.agent.autoApproveEdits` | `false` | Require approval for file edits |
| `qwen.agent.autoApproveCommands` | `false` | Require approval for terminal commands |
| `qwen.agent.maxLoopSteps` | `20` | Max agentic loop iterations |

See the full [Architecture Document](ARCHITECTURE.md) for details.

## License

MIT  See [LICENSE](LICENSE)