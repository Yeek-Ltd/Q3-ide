# QwenCodeIDE — Architecture & Project Plan

## 1. Vision

A standalone, heavily modified VS Code fork with a deeply integrated offline AI agent powered by Qwen 3 Coder. No cloud dependencies. All inference runs locally.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    QwenCodeIDE (Electron App)              │
│                                                            │
│  ┌────────────────┐    ┌───────────────────────────────┐  │
│  │  Editor Shell   │    │        Agent System            │  │
│  │  (VS Code fork) │    │                                │  │
│  │                  │    │  ┌──────────┐  ┌───────────┐  │  │
│  │  - Monaco editor │◄──►│  │  Agent   │  │  Tool     │  │  │
│  │  - File explorer │    │  │  Core    │──│  Router   │  │  │
│  │  - Terminal      │    │  │          │  └───────────┘  │  │
│  │  - Git panel     │    │  │  Prompt  │  ┌───────────┐  │  │
│  │  - Settings      │    │  │  Builder │──│  Context  │  │  │
│  │  - Agent panel   │    │  │          │  │  Builder  │  │  │
│  │   (native)       │    │  └──────────┘  └───────────┘  │  │
│  │                  │    │       │                        │  │
│  └────────────────┘    │       ▼                        │  │
│                          │  ┌──────────────────────────┐  │  │
│                          │  │   LLM Bridge (IPC/HTTP)  │  │  │
│                          │  │   - Backend selector      │  │  │
│                          │  │   - Ollama API adapter    │  │  │
│                          │  │   - OpenAI API adapter    │  │  │
│                          │  └──────────────────────────┘  │  │
│                          └───────────┬────────────────────┘  │
│                                       │                      │
│                    ┌──────────────────┼──────────────────┐   │
│                    │                  │                  │   │
│           ┌────────▼───────┐  ┌───────▼────────┐         │   │
│           │  Ollama Server  │  │ TurboQuant     │         │   │
│           │  (Easy mode)    │  │ llama-server   │         │   │
│           │  :11434         │  │ (Fast mode)    │         │   │
│           │  - Auto model   │  │ :8080          │         │   │
│           │    management   │  │ - TurboQuant   │         │   │
│           │  - GGUF Q4_K_M  │  │ - MoE offload  │         │   │
│           │  - num_gpu: -1  │  │ - KV q8_0      │         │   │
│           │                 │  │ - Flash attn   │         │   │
│           │                 │  │ - TriAttention │         │   │
│           │                 │  │ - Unsloth UD   │         │   │
│           └─────────────────┘  └────────────────┘         │   │
│                                                            │
│  Electron Main Process (lifecycle, IPC, child processes)   │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Component Breakdown

### 3.1 Editor Shell (VS Code Fork)

| Component | Description | Location (VS Code source) |
|-----------|-------------|---------------------------|
| Branding | App name, icons, splash, about dialog | `product.json`, `resources/` |
| Agent Panel | Native view container in activity bar | `src/vs/workbench/contrib/agent/` (new) |
| Inline Completions | Qwen-powered ghost text | `src/vs/editor/contrib/inlineCompletions/` |
| Editor Hooks | Cursor, selection, file-open events | `src/vs/workbench/services/agent/` (new) |
| Settings UI | Model config, hardware, agent behavior | `src/vs/workbench/contrib/agent/browser/` |
| Terminal Bridge | Agent can run commands, read output | `src/vs/workbench/contrib/terminal/` |
| Diagnostics Feed | Agent reads Problems panel | `src/vs/workbench/contrib/markers/` |

### 3.2 Agent System

#### Agent Core
- Orchestrates the agent loop: receive request → build context → call LLM → parse response → execute tools → feed results back → repeat.
- Manages conversation history and session state.
- Implements stop/cancel for long-running agentic loops.

#### Prompt Builder
- Constructs the system prompt (agent identity, capabilities, rules).
- Injects editor context: active file, selection, cursor position, language, open tabs.
- Manages context window budget — truncates/summarizes when context exceeds model limits.

#### Context Builder
- Gathers workspace context: file tree, git status, recent edits, diagnostics.
- Provides tools to the agent: read_file, grep_search, list_dir, run_command, apply_edit, git operations.
- Respects file size limits and ignores (e.g., node_modules, .git).

#### Tool Router
- Maps LLM tool-call requests to actual editor operations.
- Sandboxes file writes (requires user approval for destructive ops).
- Streams tool execution results back to the LLM for multi-step reasoning.

### 3.3 LLM Bridge (Dual-Backend)

- Abstracts the inference engine behind a common interface (`IQ3LLMBridgeService`).
- Supports **two pluggable backends** selectable at install time and in settings:
  - **Ollama adapter** — talks to Ollama's `/api/chat` endpoint (Ollama-specific JSON format)
  - **OpenAI adapter** — talks to llama.cpp's `/v1/chat/completions` endpoint (OpenAI-compatible format)
- Backend selection is stored in `q3.agent.backend` setting (`"ollama"` or `"llamacpp"`).
- Each adapter handles: request formatting, streaming parsing, tool call extraction, error handling.
- The bridge automatically routes to the correct adapter based on the configured backend.
- Handles: streaming token generation, cancellation, retry logic.

### 3.4 Local Inference Engine (Dual-Backend)

#### Backend A: Ollama (Easy Mode)
- Simple HTTP API (`localhost:11434`).
- Handles model pulling, quantization, GPU detection automatically.
- Supports streaming via SSE.
- Qwen 3 Coder available as `ollama pull qwen3-coder`.
- Full GPU offload via `num_gpu: -1`.
- **Pros**: Zero configuration, automatic model management, simple installation.
- **Cons**: No KV cache quantization, no MoE expert offloading, no flash attention control, no speculative decoding, no TriAttention.
- **Target**: Users who want simplicity and automatic setup.

#### Backend B: TurboQuant llama.cpp (Fast Mode)
- Runs `llama-server.exe` from the [TurboQuant fork](https://github.com/atomicmilkshake/llama-cpp-turboquant) as a managed child process.
- OpenAI-compatible API at `localhost:8080/v1`.
- Uses Unsloth UD (Unsloth Dynamic) GGUF models from HuggingFace for optimized quantization.
- **Key optimizations** (not available in Ollama):
  - **TurboQuant** — custom CUDA kernels (turbo2/3/4) for faster quantized inference on RTX 2000+.
  - **MoE expert offloading** (`-ot ".ffn_.*_exps.=CPU"`) — keeps attention/shared layers on GPU, offloads expert FFN layers to CPU. Critical for MoE models like Qwen3-Coder-30B on consumer GPUs.
  - **KV cache quantization** (`-ctk q8_0 -ctv q8_0`) — halves KV cache memory, enabling larger context windows in less VRAM.
  - **Flash attention** (`--flash-attn on`) — faster attention computation.
  - **TriAttention** — GPU-accelerated KV cache pruning. Keeps only the most important tokens, enabling long context within fixed VRAM budget. 4.3x generation speedup.
  - **Single slot** (`-np 1`) — eliminates multi-request overhead for single-user desktop use.
  - **No mmap** (`--no-mmap`) — loads model fully into RAM, avoids page faults.
- **Requires**: CUDA 13.x runtime, NVIDIA RTX 2000+ GPU.
- **Expected performance on RTX 4070 12GB**: 30-40+ tokens/sec (based on 23-30 tps on RTX 4050 6GB).
- **Pros**: 2-4x faster inference, lower VRAM usage, speculative decoding support.
- **Cons**: Requires CUDA runtime, manual model download, larger installer, more complex setup.
- **Target**: Users who want maximum performance and have an NVIDIA RTX GPU.

#### Optimized launch command for Qwen3-Coder-30B on RTX 4070 12GB:
```bash
llama-server.exe \
  --model Qwen3-Coder-30B-A3B-UD-Q4_K_M.gguf \
  --ctx-size 32768 \
  --n-gpu-layers 99 \
  -ot ".ffn_.*_exps.=CPU" \
  -ctk q8_0 -ctv q8_0 \
  --flash-attn on \
  -np 1 \
  --no-mmap \
  --port 8080 \
  --alias qwen3-coder:30b
```

### 3.5 Model Management

- First-run wizard: detect GPU, recommend model size, download GGUF.
- Model selector in settings: switch between models (e.g., 4B, 8B, 14B depending on VRAM).
- VRAM/RAM monitor in status bar.
- Auto-unload model after idle period to free memory.

---

## 4. Data Flow

### 4.1 Chat Request

```
1. User types in Agent Panel: "Refactor this function to use async/await"
2. Agent Panel → postMessage → Agent Core
3. Context Builder gathers:
   - Active file content + cursor position
   - Language ID (typescript, python, etc.)
   - Open tabs list
   - Git diff (if any)
4. Prompt Builder assembles:
   [system_prompt] + [context] + [conversation_history] + [user_message]
5. LLM Bridge sends to inference engine (streaming)
6. Agent Core receives tokens, streams to Agent Panel
7. If LLM emits a tool call (e.g., apply_edit):
   - Tool Router executes the edit
   - Result fed back to LLM for continuation
   - Loop until LLM signals completion
8. Agent Panel renders final response with code blocks + "Apply" buttons
```

### 4.2 Inline Completion

```
1. User pauses typing (debounce 300ms)
2. Editor hooks → Context Builder (current line, surrounding context)
3. Prompt Builder → fill-in-the-middle prompt
4. LLM Bridge → inference engine (single completion, no streaming)
5. Result → InlineCompletionsProvider → ghost text rendered
6. User accepts (Tab) or rejects (Esc)
```

### 4.3 Agentic Multi-Step

```
1. User: "Fix the failing tests"
2. Agent Core → LLM: "I'll start by running the tests"
3. Tool Router → run_command("npm test")
4. Tool Router captures output → feeds back to LLM
5. LLM: "Test X fails because of Y. Let me read the file."
6. Tool Router → read_file("src/foo.ts")
7. LLM: "The bug is on line 42. Applying fix."
8. Tool Router → apply_edit("src/foo.ts", old_string, new_string)
9. LLM: "Re-running tests to verify."
10. Tool Router → run_command("npm test")
11. LLM: "All tests pass. Done."
```

---

## 5. Project Structure

```
QwenCodeIDE/
├── .vscode/                        # VS Code build configs
├── build/                          # Build scripts (gulp, electron builder)
├── extensions/                     # Built-in extensions (from VS Code)
├── product.json                    # Custom branding config
├── resources/                      # App icons, splash, installer assets
│   ├── icons/
│   └── splash/
├── src/
│   ├── vs/
│   │   ├── workbench/
│   │   │   ├── contrib/
│   │   │   │   └── agent/          # NEW: Agent panel & UI
│   │   │   │       ├── browser/
│   │   │   │       │   ├── agentPanel.ts
│   │   │   │       │   ├── agentView.ts
│   │   │   │       │   └── media/
│   │   │   │       │       ├── agent.css
│   │   │   │       │       └── agent.js
│   │   │   │       └── common/
│   │   │   │           └── agentConfig.ts
│   │   │   └── services/
│   │   │       └── agent/          # NEW: Agent core services
│   │   │           ├── agentCore.ts
│   │   │           ├── promptBuilder.ts
│   │   │           ├── contextBuilder.ts
│   │   │           ├── toolRouter.ts
│   │   │           └── llmBridge.ts
│   │   └── editor/
│   │       └── contrib/
│   │           └── inlineCompletions/
│   │               └── qwenProvider.ts  # Modified: Qwen inline provider
│   └── platform/                   # Platform-level changes
│       └── agent/
│           └── inferenceEngine.ts  # Child process management
├── package.json                    # VS Code root package.json
├── gulpfile.js                     # Build pipeline
└── ARCHITECTURE.md                 # This document
```

---

## 6. Technology Choices

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Base | VS Code OSS (Q3 IDE fork) | Telemetry-free, MIT licensed |
| UI Framework | VS Code's native DOM + Monaco | No extra framework, deep integration |
| LLM Engine | Dual: Ollama (Easy) + TurboQuant llama.cpp (Fast) | Ollama for simplicity; TurboQuant for 2-4x speedup on NVIDIA GPUs |
| Model Format | GGUF (Q4_K_M / Unsloth UD Q4_K_M) | Standard GGUF for Ollama; Unsloth Dynamic for TurboQuant |
| GPU Backend | CUDA (TurboQuant), Auto-detect for Ollama | TurboQuant requires CUDA 13.x + RTX 2000+; Ollama auto-detects |
| Agent Protocol | OpenAI-compatible tool calling | Qwen 3 Coder supports function calling |
| Build | VS Code's existing gulp + Electron Builder | Proven pipeline, minimal custom tooling |
| Packaging | Electron Builder | Cross-platform installers (.exe, .dmg, .AppImage) |

---

## 7. Task Breakdown

### Phase 1: Foundation (Weeks 1-2)

- [ ] **1.1** Fork VS Code OSS / Q3 IDE
- [ ] **1.2** Set up build environment (Node.js, Yarn, Python, VS Build Tools)
- [ ] **1.3** Verify clean build on Windows
- [ ] **1.4** Custom branding: app name, icons, product.json
- [ ] **1.5** First successful packaged build (`.exe`)

### Phase 2: LLM Integration (Weeks 3-4)

- [ ] **2.1** Implement `inferenceEngine.ts` — child process management for Ollama
- [ ] **2.2** Implement `llmBridge.ts` — HTTP client, streaming, cancellation
- [ ] **2.3** Implement model management: first-run wizard, settings, auto-download
- [ ] **2.4** Implement `promptBuilder.ts` — system prompt + context assembly
- [ ] **2.5** Validate: send a prompt to Qwen 3 Coder, receive streamed response

### Phase 3: Agent Panel UI (Weeks 5-6)

- [ ] **3.1** Create agent view container in activity bar
- [ ] **3.2** Build chat UI (message list, input box, send button)
- [ ] **3.3** Implement streaming token rendering with syntax highlighting
- [ ] **3.4** Add "Apply" buttons for code blocks
- [ ] **3.5** Add conversation history and session management
- [ ] **3.6** Add stop/cancel button for agent loops

### Phase 4: Context & Tools (Weeks 7-8)

- [ ] **4.1** Implement `contextBuilder.ts` — active file, selection, cursor, tabs
- [ ] **4.2** Implement `toolRouter.ts` — tool dispatch system
- [ ] **4.3** Tools: `read_file`, `list_dir`, `grep_search`, `apply_edit`
- [ ] **4.4** Tools: `run_command` (terminal bridge), `git_status`, `git_commit`
- [ ] **4.5** Tools: `read_diagnostics` (Problems panel)
- [ ] **4.6** User approval flow for destructive operations
- [ ] **4.7** Context window budget management (truncation/summarization)

### Phase 5: Inline Completions (Week 9)

- [ ] **5.1** Modify inline completions provider to use Qwen
- [ ] **5.2** Implement FIM (fill-in-the-middle) prompt format
- [ ] **5.3** Debounce and caching for completions
- [ ] **5.4** Settings: enable/disable, trigger delay, max tokens

### Phase 6: Agentic Loop (Weeks 10-11)

- [ ] **6.1** Implement multi-step agent loop in `agentCore.ts`
- [ ] **6.2** Tool call parsing from LLM output (function calling format)
- [ ] **6.3** Result feedback to LLM for continuation
- [ ] **6.4** Progress indicators during multi-step execution
- [ ] **6.5** Error handling and retry logic
- [ ] **6.6** Token usage tracking and display

### Phase 7: Polish & Distribution (Weeks 12-13)

- [ ] **7.1** Status bar: model name, VRAM usage, inference status
- [ ] **7.2** Keyboard shortcuts for agent interactions
- [ ] **7.3** Settings page: model selection, temperature, max tokens, GPU backend
- [ ] **7.4** Auto-update mechanism (for the IDE itself, not models)
- [ ] **7.5** Cross-platform testing (Windows, macOS, Linux)
- [ ] **7.6** Installer packaging (.exe, .dmg, .AppImage)
- [ ] **7.7** Documentation: README, user guide, build instructions

---

## 8. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| VS Code build complexity | High | Start from Q3 IDE which simplifies the build; document every step |
| Model size vs. performance | Medium | Default to Q4_K_M quantization; offer multiple model sizes; auto-detect VRAM |
| Context window limits | Medium | Implement smart truncation; prioritize active file + recent context |
| Inference latency | Medium | Stream tokens; use smaller model for inline completions; cache results |
| Upstream VS Code updates | Low | Pin to a specific VS Code version; rebase periodically |
| GPU driver issues | Medium | Auto-detect + fallback to CPU; clear error messages |

---

## 9. Configuration Schema (Preview)

```json
{
  "qwen.agent.model": "qwen3-coder:8b",
  "qwen.agent.endpoint": "http://localhost:11434",
  "qwen.agent.temperature": 0.7,
  "qwen.agent.maxTokens": 4096,
  "qwen.agent.contextWindow": 32768,
  "qwen.agent.gpuBackend": "auto",
  "qwen.agent.inlineCompletions": true,
  "qwen.agent.inlineDebounce": 300,
  "qwen.agent.autoApproveReads": true,
  "qwen.agent.autoApproveEdits": false,
  "qwen.agent.autoApproveCommands": false,
  "qwen.agent.maxLoopSteps": 20
}
```

---

## 10. Confirmed Decisions

| Decision | Choice | Confirmed |
|----------|--------|-----------|
| Base | Q3 IDE fork (Option A) | ✅ |
| LLM Engine | Dual: Ollama + TurboQuant llama.cpp | ✅ |
| GitHub Repo | https://github.com/yeekcay/Q3-ide | ✅ |
| Model | Qwen 3 Coder (GGUF, Q4_K_M) | ✅ |

## 11. Next Steps

1. ~~Confirm technology choices~~ ✅
2. ~~Set up the development environment~~ ✅
3. ~~Clone Q3 IDE as the base fork~~ ✅
4. ~~Apply custom branding~~ ✅
5. ~~Begin Phase 1 tasks~~ ✅
6. ~~Phases 2-7: Agent system, UI, tools, inline completions, agentic loop~~ ✅
7. **Phase 8: TurboQuant llama.cpp dual-backend integration** (CURRENT)

---

## 12. Phase 8: TurboQuant llama.cpp Dual-Backend Integration

### Goal
Add TurboQuant llama.cpp as a second inference backend alongside Ollama, giving users a choice at install time and in settings. TurboQuant provides 2-4x faster inference via TurboQuant quantization, MoE expert offloading, KV cache quantization, flash attention, and TriAttention KV cache pruning.

### Target Hardware
- User GPU: **RTX 4070 12GB VRAM** (Ada Lovelace, SM89)
- Expected: 30-40+ tokens/sec with Qwen3-Coder-30B-A3B

### Implementation Steps

#### Step 1: Configuration & Settings
- [ ] Add `q3.agent.backend` setting (`"ollama"` | `"llamacpp"`) to `q3Agent.contribution.ts`
- [ ] Add `q3.agent.llamacpp.port` setting (default 8080)
- [ ] Add `q3.agent.llamacpp.modelPath` setting (path to GGUF file)
- [ ] Add `q3.agent.llamacpp.ctxSize` setting (default 32768)
- [ ] Add `q3.agent.llamacpp.kvCacheType` setting (`"q8_0"` | `"q4_0"` | `"f16"`, default `"q8_0"`)
- [ ] Add `q3.agent.llamacpp.moeOffload` setting (boolean, default true)
- [ ] Add `q3.agent.llamacpp.triAttention` setting (boolean, default false)

#### Step 2: LLM Bridge Dual-Adapter
- [ ] Refactor `q3LLMBridgeService.ts` to support two API formats:
  - **Ollama adapter**: existing `/api/chat` format (unchanged)
  - **OpenAI adapter**: `/v1/chat/completions` format for llama.cpp server
- [ ] Add `getBackend()` method that reads `q3.agent.backend` setting
- [ ] Modify `chat()` to route to Ollama or OpenAI format based on backend
- [ ] Modify `chatStream()` to parse both Ollama NDJSON and OpenAI SSE streaming formats
- [ ] Modify `complete()` (FIM) to use `/v1/completions` for llama.cpp backend
- [ ] Ensure tool call parsing works with both API formats

#### Step 3: llama.cpp Process Manager
- [ ] Create `q3LlamaCppService.ts` in `services/q3Agent/common/`
- [ ] Interface: `IQ3LlamaCppService` with `start()`, `stop()`, `isRunning()`, `getPort()`
- [ ] Spawns `llama-server.exe` as child process with optimized flags
- [ ] Reads model path, port, context size, KV cache type from settings
- [ ] Constructs launch command with MoE offloading, flash attention, single slot
- [ ] Monitors process health, restarts on crash
- [ ] Logs stdout/stderr to output channel for debugging
- [ ] Graceful shutdown on IDE exit

#### Step 4: Model Management for llama.cpp
- [ ] Add Unsloth UD GGUF download support to `q3ModelService.ts`
- [ ] Download from HuggingFace: `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`
- [ ] Support multiple quantization levels: Q4_K_M, IQ4_NL, Q4_K_XL (MTP)
- [ ] Store models in `~/.q3ide/models/` directory
- [ ] Add model selection UI for llama.cpp backend (list available GGUF files)
- [ ] Show download progress in UI

#### Step 5: Startup Integration
- [ ] Modify `q3AgentStartup.ts` to check backend setting on startup
- [ ] If `llamacpp`: start `llama-server.exe` via process manager, wait for health check
- [ ] If `ollama`: existing Ollama startup logic (unchanged)
- [ ] Add backend status indicator in agent view (shows which backend is active)
- [ ] Health check: poll `http://localhost:8080/v1/models` until ready

#### Step 6: UI — Backend Selector
- [ ] Add backend selector dropdown in Q3 Agent view header (Ollama / TurboQuant)
- [ ] Add settings panel for llama.cpp options (model path, context size, KV cache, MoE offload, TriAttention)
- [ ] Show backend status indicator (running/stopped/error)
- [ ] Show estimated VRAM usage based on settings
- [ ] Add "Download Model" button for Unsloth UD GGUF

#### Step 7: Installer Integration
- [ ] Bundle TurboQuant `llama-server.exe` pre-built binary in installer
- [ ] Add installer page: "Choose Inference Engine"
  - Option A: "Ollama (Easy, recommended)" — installs Ollama, auto-pulls model
  - Option B: "TurboQuant llama.cpp (Fast, requires NVIDIA RTX)" — bundles llama-server.exe, downloads Unsloth GGUF
  - Option C: "I'll configure later" — skip, use settings to choose
- [ ] Check for CUDA 13.x runtime during install (option B)
- [ ] Download Unsloth UD GGUF during install (option B) or on first run

#### Step 8: Testing & Verification
- [ ] Test Ollama backend still works unchanged
- [ ] Test llama.cpp backend with Qwen3-Coder-30B on RTX 4070
- [ ] Benchmark: compare token generation speed (Ollama vs TurboQuant)
- [ ] Test tool calling works with both backends
- [ ] Test inline completions with both backends
- [ ] Test backend switching at runtime (stop one, start other)
- [ ] Test installer with both options
- [ ] Verify VRAM usage with different KV cache settings

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `q3agent_src/services/q3Agent/common/q3Agent.ts` | Modify | Add `IQ3LlamaCppService` interface |
| `q3agent_src/services/q3Agent/common/q3LLMBridgeService.ts` | Modify | Add OpenAI adapter, backend routing |
| `q3agent_src/services/q3Agent/common/q3LlamaCppService.ts` | **Create** | Process manager for llama-server.exe |
| `q3agent_src/services/q3Agent/common/q3ModelService.ts` | Modify | Add HuggingFace GGUF download support |
| `q3agent_src/contrib/q3Agent/browser/q3Agent.contribution.ts` | Modify | Add backend settings |
| `q3agent_src/contrib/q3Agent/browser/q3AgentStartup.ts` | Modify | Add llama.cpp startup logic |
| `q3agent_src/contrib/q3Agent/browser/q3AgentView.ts` | Modify | Add backend selector UI |
| `q3agent_src/contrib/q3Agent/browser/media/q3Agent.css` | Modify | Styles for backend selector |
| `vscode/build/win32/code.iss` | Modify | Add installer backend choice page |
| `resources/llamacpp/` | **Create** | Directory for bundled llama-server.exe |
