# Unity MCP — Reimplementation Design

Reimplement the `unity-recompile` plugin as `unity-mcp`: a transport-agnostic core module with MCP server and hook adapters.

## Goals

- Replace commands/agents with MCP tools via `@modelcontextprotocol/sdk`
- Extract monolithic hook (`src/index.ts`) into composable core functions
- Keep hook behavior unchanged (Stop + SubagentStop triggers)
- No behavioral changes — structural refactor only

## Architecture

```
plugins/unity-mcp/
  src/
    core/        # 4 public functions — transport-agnostic
    lib/         # Implementation internals (bridge, compile, project)
    mcp/         # MCP server adapter (stdio transport)
    hook/        # Hook adapter (thin pipeline)
```

Two entry points consume the same core:
- **MCP server** (`src/mcp/server.ts`) — stdio transport, Claude Code manages lifecycle
- **Hook** (`src/hook/index.ts`) — runs after turns, file logger, exit codes

## Core API

All functions are async. All accept an optional injectable `Logger`.

```typescript
interface Logger {
  log(message: string): void;
  error(message: string): void;
}

// core/detect.ts
detectProject(cwd: string): Promise<string | null>

// core/recompile.ts
recompile(projectPath: string, logger?: Logger): Promise<RecompileResult>
// RecompileResult: { success: boolean, skipped: boolean, errors: CompilationError[] }

// core/status.ts
getStatus(projectPath: string, logger?: Logger): Promise<StatusResult>
// StatusResult: { editorRunning: boolean, bridgeReady: boolean, unityVersion: string, ... }

// core/lint.ts
lint(projectPath: string, logger?: Logger): Promise<LintResult>
// LintResult: { filesLinted: number, success: boolean }
```

Design decisions:
- `projectPath` is always explicit — callers handle detection
- Return typed result objects, not exit codes — adapters translate
- `recompile` handles the full pipeline internally (changes check, bridge install, orchestration, marker touch)

## MCP Server

```typescript
// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
```

Four tools registered:

| Tool | Description | Input |
|------|-------------|-------|
| `unity_detect_project` | Detect if directory is inside a Unity project | `cwd: string` |
| `unity_recompile` | Trigger Unity recompilation | `projectPath: string` |
| `unity_status` | Show project and bridge diagnostics | `projectPath: string` |
| `unity_lint` | Run JetBrains cleanup on changed C# files | `projectPath: string` |

- Stdio transport — Claude Code spawns and manages the process
- Logger writes to stderr (stdout reserved for JSON-RPC)
- Returns `isError: true` when compilation fails
- Stateful: caches project root in memory (stable for session lifetime)

## Hook Adapter

```typescript
// src/hook/index.ts — ~20 lines of glue
const cwd = /* from stdin JSON or process.cwd() */;
const logger = createFileLogger();

const projectPath = await detectProject(cwd);
if (!projectPath) process.exit(0);
if (skipMarkerExists(projectPath)) process.exit(0);

const result = await recompile(projectPath, logger);
if (result.skipped) process.exit(0);
if (result.success) { await lint(projectPath, logger); process.exit(0); }
process.exit(2);
```

- Same exit code contract: 0 = success/skip, 2 = compilation errors
- Skip marker check is adapter-level policy
- `hooks.json` and shell wrapper stay, path updated

## Plugin Configuration

```json
{
  "name": "unity-mcp",
  "description": "Unity Editor integration — recompilation, diagnostics, and linting via MCP",
  "mcpServers": {
    "unity-mcp": {
      "command": "npx",
      "args": ["--yes", "tsx", "src/mcp/server.ts"]
    }
  }
}
```

- `commands/` and `agents/` directories deleted
- No more slash commands — Claude calls MCP tools directly

## Directory Structure

```
plugins/unity-mcp/
├── .claude-plugin/
│   └── plugin.json
├── package.json                  # Adds @modelcontextprotocol/sdk, zod
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── core/
│   │   ├── recompile.ts
│   │   ├── status.ts
│   │   ├── detect.ts
│   │   └── lint.ts
│   ├── lib/
│   │   ├── bridge/
│   │   │   ├── types.ts
│   │   │   ├── install.ts
│   │   │   ├── ipc.ts
│   │   │   └── orchestrate.ts
│   │   ├── compile/
│   │   │   ├── applescript.ts
│   │   │   └── cli-fallback.ts
│   │   ├── project/
│   │   │   ├── detect.ts
│   │   │   └── changes.ts
│   │   ├── config.ts
│   │   └── logger.ts
│   ├── mcp/
│   │   └── server.ts
│   └── hook/
│       └── index.ts
├── templates/
│   └── ClaudeRecompileBridge.cs
├── hooks/
│   ├── hooks.json
│   ├── unity-recompile.sh
│   └── TripleDot.DotSettings
└── __tests__/
    ├── core/
    ├── lib/
    └── integration/
```

## Migration Summary

**Moved:**
- `src/bridge/`, `src/compile/`, `src/project/` → `src/lib/`
- `src/index.ts` logic → `src/core/` functions + `src/hook/index.ts`

**New:**
- `src/mcp/server.ts`
- `src/core/` (4 files)
- Dependencies: `@modelcontextprotocol/sdk`, `zod`

**Deleted:**
- `commands/` directory
- `agents/` directory
- `src/index.ts` (replaced by hook + core)

**Unchanged:**
- All `src/lib/` internals (same logic, relocated)
- `templates/ClaudeRecompileBridge.cs`
- `hooks/hooks.json`, `hooks/unity-recompile.sh`, `hooks/TripleDot.DotSettings`
- Marker-based change detection, bridge IPC protocol, AppleScript

## Testing

- Existing tests reorganized under `__tests__/lib/` — same tests, updated imports
- New `__tests__/core/` tests for the 4 core functions
- New `__tests__/mcp/` test for server tool registration and response format
- Integration test updated to use core functions
