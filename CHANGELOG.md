# Changelog

All notable changes to Q3 IDE will be documented in this file.

## [Unreleased]

### Fixed
- **CSP blocking fetch() to llama-swap** — Added `http://127.0.0.1:*` and `http://localhost:*` to `connect-src` CSP directive in `workbench.html`. The Electron renderer's `fetch()` calls to `http://127.0.0.1:8080` were being blocked by Content Security Policy, causing "Failed to fetch" errors during llama-swap startup. Patch is applied via `apply_q3agent.sh` to survive `git reset --hard` during builds.

### Changed
- **Replaced Ollama with llama-swap + ik_llama.cpp** — Ollama backend removed entirely. llama-swap is now the only inference backend, providing TTL auto-unload, model swapping, and better lifecycle management.
- **Replaced TurboQuant with ik_llama.cpp** — ik_llama.cpp provides fused MoE ops, better MoE token generation on CUDA, FlashMLA, and works with CUDA 12.6 (TurboQuant required CUDA 13.0).
- **Reverted to plain fetch()** — Removed `IRequestService` usage in `q3LlamaCppService.ts` and `q3LLMBridgeService.ts`. VS Code's request service added proxy/CORS layers that interfered with localhost requests. Plain `fetch()` works reliably once CSP is configured.
- **Updated README, ARCHITECTURE, CODE_OF_CONDUCT, CONTRIBUTING** — Reflects new backend, updated contact info (contact@yeek.ltd), website (https://yeek.ltd).

### Added
- **batch_edit tool** — Apply multiple edits to a single file in one tool call, reducing LLM round-trips.
- **Auto-approve for read-only operations** — `read_file`, `list_dir`, `grep_search`, `git_status`, `read_diagnostics` no longer require user approval.
- **Inline Diff Controller** — Agent-proposed edits show as green/red diff decorations directly in the editor with per-file approve/deny floating buttons.
- **Inline Completions** — Ghost text suggestions using fill-in-the-middle (FIM) prompts via `q3InlineCompletions.ts`.
- **editHelper.ts** — Edit application utilities for reliable string replacement.
- **textUtils.ts** — Text processing utilities.
- **CSP patch in apply_q3agent.sh** — Automatically patches `workbench.html` CSP on every build.

### Removed
- **Ollama backend** — No longer supported. Ollama process management was unreliable from VS Code terminal, and it lacked KV cache quantization, MoE expert offloading, and flash attention control.
- **TurboQuant backend** — Replaced by ik_llama.cpp which has better MoE performance and CUDA 12.6 compatibility.
- **Dual-backend selector** — No longer needed since there's only one backend.
- **`IRequestService` usage** — Replaced with plain `fetch()`.
- **Node.js `http` module workaround** — Was added to bypass CSP but is unnecessary now that CSP is properly configured.

## [1.121.0] — Initial Q3 IDE Release

- VS Code fork with custom branding (Q3 IDE)
- Q3 Agent panel with chat interface
- Ollama backend for local LLM inference
- Agentic tools: read_file, list_dir, grep_search, apply_edit, run_command
- User approval gates for destructive operations
- Settings schema for agent configuration
