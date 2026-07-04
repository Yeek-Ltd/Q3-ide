# Q3 IDE — Architecture & Project Plan

## 1. Vision

A standalone, heavily modified VS Code fork with a deeply integrated offline AI agent powered by Qwen 3 Coder. No cloud dependencies. All inference runs locally via ik_llama.cpp and llama-swap.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Q3 IDE (Electron App)                  │
│                                                          │
│  ┌────────────────┐    ┌───────────────────────────────┐ │
│  │  Editor Shell   │    │        Agent System           │ │
│  │  (VS Code fork) │    │                               │ │
│  │                  │    │  ┌──────────┐  ┌───────────┐ │ │
│  │  - Monaco editor │◄──►│  │  Agent   │  │  Tool     │ │ │
│  │  - File explorer │    │  │  Core    │──│  Router   │ │ │
│  │  - Terminal      │    │  │          │  └───────────┘ │ │
│  │  - Git panel     │    │  │  Prompt  │  ┌───────────┐ │ │
│  │  - Settings      │    │  │  Builder │──│  Context  │ │ │
│  │  - Agent panel   │    │  │          │  │  Builder  │ │ │
│  │   (native)       │    │  └──────────┘  └───────────┘ │ │
│  │  - Inline diff   │    │       │                       │ │
│  │   (approve/deny) │    │       ▼                       │ │
│  └────────────────┘    │  ┌──────────────────────────┐  │ │
│                          │  │   LLM Bridge (fetch)     │  │ │
│                          │  │   - OpenAI API adapter   │  │ │
│                          │  │   - Streaming (SSE)      │  │ │
│                          │  │   - Retry with backoff   │  │ │
│                          │  └──────────────────────────┘  │ │
│                          └───────────┬────────────────────┘ │
│                                       │                     │
│                          ┌────────────▼──────────────┐      │
│                          │   llama-swap (:8080)       │      │
│                          │   - Reverse proxy          │      │
│                          │   - TTL auto-unload (300s) │      │
│                          │   - Model swapping         │      │
│                          └────────────┬──────────────┘      │
│                                       │                     │
│                          ┌────────────▼──────────────┐      │
│                          │  ik_llama.cpp llama-server │      │
│                          │  - Fused MoE ops           │      │
│                          │  - MoE expert offload      │      │
│                          │  - KV cache q8_0           │      │
│                          │  - Flash attention         │      │
│                          │  - Speculative decoding    │      │
│                          │  - Unsloth UD Q4_K_XL GGUF │      │
│                          └───────────────────────────┘      │
│                                                          │
│  Electron Main Process (lifecycle, IPC, child processes) │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Component Breakdown

### 3.1 Editor Shell (VS Code Fork)

| Component | Description | Location |
|-----------|-------------|----------|
| Branding | App name, icons, splash, about dialog | `product.json`, `resources/` |
| Agent Panel | Native view container in activity bar | `q3agent_src/contrib/q3Agent/browser/` |
| Inline Completions | Qwen-powered ghost text | `q3agent_src/contrib/q3Agent/browser/q3InlineCompletions.ts` |
| Inline Diff Controller | Green/red diff decorations + approve/deny widget | `q3agent_src/contrib/q3Agent/browser/q3InlineDiffController.ts` |
| Editor Hooks | Cursor, selection, file-open events | `q3agent_src/services/q3Agent/common/` |
| Settings UI | Model config, hardware, agent behavior | `q3agent_src/contrib/q3Agent/browser/q3Agent.contribution.ts` |
| Terminal Bridge | Agent can run commands, read output | `q3agent_src/services/q3Agent/common/q3AgentService.ts` |
| Diagnostics Feed | Agent reads Problems panel | `q3agent_src/services/q3Agent/common/q3AgentService.ts` |

### 3.2 Agent System

#### Agent Core (`q3AgentService.ts`)
- Orchestrates the agent loop: receive request → build context → call LLM → parse response → execute tools → feed results back → repeat.
- Manages conversation history and session state.
- Implements stop/cancel for long-running agentic loops.
- Tools: `read_file`, `list_dir`, `grep_search`, `apply_edit`, `batch_edit`, `write_file`, `run_command`, `git_status`, `git_commit`, `read_diagnostics`.
- Auto-approve for read-only operations (reads, grep, list, git status).
- User approval gates for destructive operations (edits, writes, commands, git commit).

#### Prompt Builder
- Constructs the system prompt (agent identity, capabilities, rules).
- Injects editor context: active file, selection, cursor position, language, open tabs.
- Manages context window budget — truncates/summarizes when context exceeds model limits.

#### Context Builder
- Gathers workspace context: file tree, git status, recent edits, diagnostics.
- Respects file size limits and ignores (e.g., node_modules, .git).

#### Tool Router
- Maps LLM tool-call requests to actual editor operations.
- Sandboxes file writes (requires user approval for destructive ops).
- Streams tool execution results back to the LLM for multi-step reasoning.
- `batch_edit` tool: applies multiple edits to a single file in one call, reducing LLM round-trips.

### 3.3 LLM Bridge (`q3LLMBridgeService.ts`)

- Uses plain `fetch()` to talk to llama-swap's OpenAI-compatible API.
- Endpoint: `http://127.0.0.1:8080/v1/chat/completions`.
- Handles: streaming token generation (SSE), cancellation, retry logic with exponential backoff.
- `_fetchWithRetry`: max 3 retries, 5-minute timeout, exponential backoff.
- CSP note: `workbench.html` `connect-src` includes `http://127.0.0.1:*` and `http://localhost:*` to allow renderer `fetch()` to localhost (patched via `apply_q3agent.sh`).

### 3.4 Local Inference Engine

#### llama-swap (Reverse Proxy)
- [llama-swap](https://github.com/mostlygeek/llama-swap) — reverse proxy for OpenAI-compatible servers.
- Installed via `winget install mostlygeek.llama-swap`.
- Listens on port 8080, dynamically spawns llama-server instances.
- TTL auto-unload: models unload after idle timeout (default 300s), freeing GPU memory.
- Config auto-generated at `~/.q3ide/llamacpp/llama-swap.yaml`.
- Q3 IDE launches llama-swap in a transient terminal on startup.

#### ik_llama.cpp (Inference Engine)
- [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp) — llama.cpp fork with better CPU + hybrid GPU/CPU performance.
- Built from source with VS 2022 + CUDA 12.6 + CMake 4.0.2.
- Key features: auto-fit VRAM offload, fused FFN for MoE, FlashMLA, speculative decoding, function calls.
- Better MoE CUDA performance than mainline llama.cpp (fused MoE ops, better TG for MoE on CUDA).

#### Optimized launch command for Qwen3-30B-A3B on RTX 4070 12GB:
```bash
llama-server.exe \
  --model Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL.gguf \
  --ctx-size 16384 \
  --n-gpu-layers 99 \
  -ot ".ffn_.*_exps.=CPU" \
  -ctk q8_0 -ctv q8_0 \
  --flash-attn on \
  --jinja \
  --repeat-penalty 1.15 \
  --repeat-last-n -1 \
  -np 1 \
  --port 8080 \
  --alias qwen3-coder:30b
```

### 3.5 Model Management

- Model path configured in settings (`q3.agent.llamacpp.modelPath`).
- Model warm-up on startup: sends a minimal chat completion to load model into GPU memory.
- Auto-unload after idle TTL (default 300s) via llama-swap.
- Model selector in agent view: refresh available models from llama-swap.

---

## 4. Data Flow

### 4.1 Chat Request

```
1. User types in Agent Panel: "Refactor this function to use async/await"
2. Agent Panel → Agent Core
3. Context Builder gathers: active file, cursor position, language, open tabs, git diff
4. Prompt Builder assembles: [system_prompt] + [context] + [history] + [user_message]
5. LLM Bridge sends to llama-swap via fetch() (streaming SSE)
6. Agent Core receives tokens, streams to Agent Panel
7. If LLM emits a tool call (e.g., apply_edit):
   - Tool Router executes the edit
   - Inline Diff Controller shows green/red decorations in editor
   - User approves or denies via floating widget or chat buttons
   - Result fed back to LLM for continuation
   - Loop until LLM signals completion
8. Agent Panel renders final response
```

### 4.2 Inline Completion

```
1. User pauses typing (debounce 300ms)
2. Editor hooks → Context Builder (current line, surrounding context)
3. Prompt Builder → fill-in-the-middle prompt
4. LLM Bridge → llama-swap (single completion, no streaming)
5. Result → InlineCompletionsProvider → ghost text rendered
6. User accepts (Tab) or rejects (Esc)
```

### 4.3 Agentic Multi-Step

```
1. User: "Fix the failing tests"
2. Agent Core → LLM: "I'll start by running the tests"
3. Tool Router → run_command("npm test") — auto-approved? No, requires approval
4. Tool Router captures output → feeds back to LLM
5. LLM: "Test X fails because of Y. Let me read the file."
6. Tool Router → read_file("src/foo.ts") — auto-approved (read-only)
7. LLM: "The bug is on line 42. Applying fix."
8. Tool Router → batch_edit("src/foo.ts", [{old, new}, ...]) — requires approval
9. Inline Diff Controller shows diff in editor → user approves
10. LLM: "Re-running tests to verify."
11. Tool Router → run_command("npm test")
12. LLM: "All tests pass. Done."
```

---

## 5. Project Structure

```
QwenCodeIDE/
├── q3agent_src/                      # Q3 Agent source (applied to vscode/ at build time)
│   ├── services/q3Agent/common/
│   │   ├── q3Agent.ts                # Interfaces (IQ3LlamaCppService, tool definitions)
│   │   ├── q3AgentService.ts         # Agent core: tool dispatch, loop, approval flow
│   │   ├── q3LLMBridgeService.ts     # LLM bridge: fetch(), streaming, retry logic
│   │   ├── q3LlamaCppService.ts      # llama-swap lifecycle: start, stop, readiness polling
│   │   ├── q3ModelService.ts         # Model management: path resolution, warm-up
│   │   ├── editHelper.ts             # Edit application utilities
│   │   └── textUtils.ts              # Text processing utilities
│   └── contrib/q3Agent/browser/
│       ├── q3Agent.contribution.ts   # Settings schema, view registration
│       ├── q3AgentStartup.ts         # Startup flow: start llama-swap, warm-up model
│       ├── q3AgentView.ts            # Chat UI, tool approval, model selector
│       ├── q3InlineCompletions.ts    # Inline ghost text provider
│       ├── q3InlineDiffController.ts # Inline diff decorations + approve/deny widget
│       └── media/
│           └── q3Agent.css           # Agent panel + diff widget styles
├── dev/
│   ├── apply_q3agent.sh              # Copies q3agent_src into vscode/, patches CSP
│   ├── build.sh                      # Build orchestration
│   └── ...
├── vscode/                           # VS Code source (git submodule, reset on build)
├── VSCode-win32-x64/                 # Build output
├── ARCHITECTURE.md                   # This document
├── README.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
└── LICENSE
```

---

## 6. Technology Choices

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Base | VS Code OSS (Q3 IDE fork) | Telemetry-free, MIT licensed |
| UI Framework | VS Code's native DOM + Monaco | No extra framework, deep integration |
| Inference Engine | ik_llama.cpp via llama-swap | Fused MoE ops, best MoE TG on CUDA, FlashMLA, speculative decoding |
| Model Format | GGUF (Unsloth UD Q4_K_XL) | Dynamic quantization, optimized layer distribution |
| GPU Backend | CUDA 12.6+ | Required for MoE fused ops and flash attention |
| Agent Protocol | OpenAI-compatible tool calling | Qwen 3 Coder supports function calling via Jinja templates |
| Build | VS Code's existing gulp + Electron Builder | Proven pipeline, minimal custom tooling |
| Packaging | Electron Builder | Cross-platform installers (.exe, .dmg, .AppImage) |

---

## 7. Key Design Decisions

### Why llama-swap instead of direct llama-server management?
- **TTL auto-unload**: Models unload after idle timeout, freeing 12GB+ VRAM for other tasks.
- **Model swapping**: Switch between models without restarting the server.
- **Process isolation**: llama-swap manages llama-server lifecycle, crash recovery, and health checks.
- **OpenAI-compatible API**: Consistent endpoint regardless of which model is loaded.

### Why ik_llama.cpp instead of mainline llama.cpp or TurboQuant?
- **Fused MoE ops**: Significantly better token generation for MoE models on CUDA.
- **CUDA 12.6 compatible**: TurboQuant required CUDA 13.0 which is harder to obtain.
- **FlashMLA**: Faster MLA attention computation.
- **Auto-fit VRAM offload**: Automatically determines optimal GPU/CPU layer split.

### Why plain fetch() instead of IRequestService?
- VS Code's `IRequestService` adds proxy and CORS layers that can interfere with localhost requests.
- Plain `fetch()` is simpler and works reliably once CSP is configured.
- CSP `connect-src` patched to allow `http://127.0.0.1:*` and `http://localhost:*`.

### Why was Ollama removed?
- No KV cache quantization, no MoE expert offloading, no flash attention control.
- Cannot kill Ollama processes reliably from VS Code terminal (process management issues).
- llama-swap provides better lifecycle management with TTL auto-unload.
- ik_llama.cpp provides significantly better MoE performance.

---

## 8. Configuration Schema

```json
{
  "q3.agent.model": "qwen3-coder:30b",
  "q3.agent.temperature": 0.7,
  "q3.agent.maxTokens": 4096,
  "q3.agent.maxSteps": 30,
  "q3.agent.warmUpModel": true,
  "q3.agent.maxRetries": 3,
  "q3.agent.retryDelay": 1000,
  "q3.agent.llamacpp.modelPath": "C:\\Users\\Ceete\\.q3ide\\models\\Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL.gguf",
  "q3.agent.llamacpp.ctxSize": 16384,
  "q3.agent.llamacpp.kvCacheType": "q8_0",
  "q3.agent.llamacpp.moeOffload": true,
  "q3.agent.llamacpp.gpuLayers": 99,
  "q3.agent.llamacpp.ttl": 300,
  "q3.agent.llamacpp.llamaSwapPath": "",
  "q3.agent.llamacpp.serverBinaryPath": "",
  "q3.inlineCompletion.enabled": true,
  "q3.inlineCompletion.maxTokens": 128
}
```

---

## 9. Build System

### Build Flow
1. `build.sh` runs `prepare_vscode.sh` → resets `vscode/` to clean state (`git reset --hard HEAD`)
2. `apply_q3agent.sh` copies `q3agent_src/` into `vscode/src/` and patches:
   - `workbench.common.main.ts` — registers Q3 Agent modules
   - `workbench.html` — CSP `connect-src` to allow localhost HTTP
   - `.moduleignore` — fixes vscodium-policy-watcher.node filename
3. `gulp vscode-min-prepack` compiles TypeScript, bundles, and minifies
4. Output goes to `VSCode-win32-x64/`

### Key Build Files
- `dev/build.sh` — main build orchestration
- `dev/apply_q3agent.sh` — applies Q3 Agent source + patches to vscode/
- `vscode/gulpfile.vscode.ts` — gulp build tasks

---

## 10. Hardware Target

- **GPU**: RTX 4070 12GB VRAM (Ada Lovelace, SM89)
- **Model**: Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL.gguf (~17GB)
- **Settings**: ctxSize 16384, gpuLayers 99, kvCache q8_0, MoE experts on CPU, TTL 300s
- **Expected performance**: 30-40+ tokens/sec

---

## 11. Links

- **Website**: [https://yeek.ltd](https://yeek.ltd)
- **GitHub**: [https://github.com/yeekcay/Q3-ide](https://github.com/yeekcay/Q3-ide)
- **Contact**: [contact@yeek.ltd](mailto:contact@yeek.ltd)
