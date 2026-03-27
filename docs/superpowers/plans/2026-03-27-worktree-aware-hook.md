# Worktree-Aware Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the unity-recompile hook target worktree directories instead of the main project when a session has an active worktree.

**Architecture:** A new `worktree-state.ts` module manages a JSON state file mapping session IDs to worktree paths. The hook entry point reads `hook_event_name` from stdin to route between worktree bookkeeping (`WorktreeCreate`/`WorktreeRemove`) and recompilation (`Stop`/`SubagentStop`). `hooks.json` registers all four events.

**Tech Stack:** TypeScript, Node.js fs, Vitest

---

## File Structure

- **Create:** `plugins/unity-mcp/src/hook/worktree-state.ts` — state file read/write/resolve logic
- **Modify:** `plugins/unity-mcp/src/hook/index.ts` — parse new stdin fields, route by event, use `resolveTarget()`
- **Modify:** `plugins/unity-mcp/hooks/hooks.json` — add `WorktreeCreate` and `WorktreeRemove` events
- **Create:** `plugins/unity-mcp/__tests__/hook/worktree-state.test.ts` — unit tests for state module
- **Create:** `plugins/unity-mcp/__tests__/hook/index.test.ts` — unit tests for hook routing

---

### Task 1: Worktree State Module — Tests

**Files:**
- Create: `plugins/unity-mcp/__tests__/hook/worktree-state.test.ts`

- [ ] **Step 1: Write tests for readState, writeState, register, unregister, resolve, and pruning**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readState,
  registerWorktree,
  unregisterWorktree,
  resolveTarget,
  _setStateFilePathForTest,
} from "../../src/hook/worktree-state.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-state-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("worktree-state", () => {
  let stateFile: string;

  beforeEach(() => {
    stateFile = path.join(tmpDir, "worktrees.json");
    _setStateFilePathForTest(stateFile);
  });

  it("returns empty state when file does not exist", () => {
    expect(readState()).toEqual({});
  });

  it("registerWorktree writes session entry", () => {
    registerWorktree("sess-1", "/path/to/worktree");
    const state = readState();
    expect(state["sess-1"]).toBeDefined();
    expect(state["sess-1"].path).toBe("/path/to/worktree");
    expect(state["sess-1"].createdAt).toBeTypeOf("number");
  });

  it("unregisterWorktree removes session entry", () => {
    registerWorktree("sess-1", "/path/to/worktree");
    unregisterWorktree("sess-1");
    expect(readState()).toEqual({});
  });

  it("resolveTarget returns worktree path when session has entry", () => {
    registerWorktree("sess-1", "/path/to/worktree");
    expect(resolveTarget("sess-1", "/fallback")).toBe("/path/to/worktree");
  });

  it("resolveTarget returns fallback cwd when no entry exists", () => {
    expect(resolveTarget("sess-unknown", "/fallback")).toBe("/fallback");
  });

  it("prunes entries older than 24 hours on read", () => {
    // Write a stale entry directly
    const staleState = {
      "old-sess": {
        path: "/old/worktree",
        createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      },
      "new-sess": {
        path: "/new/worktree",
        createdAt: Date.now(),
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(staleState));
    const state = readState();
    expect(state["old-sess"]).toBeUndefined();
    expect(state["new-sess"]).toBeDefined();
  });

  it("handles concurrent sessions without overwriting", () => {
    registerWorktree("sess-a", "/worktree-a");
    registerWorktree("sess-b", "/worktree-b");
    const state = readState();
    expect(state["sess-a"].path).toBe("/worktree-a");
    expect(state["sess-b"].path).toBe("/worktree-b");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/hook/worktree-state.test.ts`
Expected: FAIL — module `../../src/hook/worktree-state.js` not found

- [ ] **Step 3: Commit**

```bash
git add plugins/unity-mcp/__tests__/hook/worktree-state.test.ts
git commit -m "test: add worktree-state unit tests (red)"
```

---

### Task 2: Worktree State Module — Implementation

**Files:**
- Create: `plugins/unity-mcp/src/hook/worktree-state.ts`

- [ ] **Step 1: Implement the worktree-state module**

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface WorktreeEntry {
  path: string;
  createdAt: number;
}

type WorktreeState = Record<string, WorktreeEntry>;

const DEFAULT_STATE_FILE_PATH = path.join(os.tmpdir(), "unity-mcp-worktrees.json");
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

let stateFilePath = DEFAULT_STATE_FILE_PATH;

/** Test-only: override state file path. */
export function _setStateFilePathForTest(p: string): void {
  stateFilePath = p;
}

export { stateFilePath as STATE_FILE_PATH };

export function readState(): WorktreeState {
  let state: WorktreeState;
  try {
    const raw = fs.readFileSync(stateFilePath, "utf-8");
    state = JSON.parse(raw);
  } catch {
    return {};
  }

  // Prune stale entries
  const now = Date.now();
  let pruned = false;
  for (const key of Object.keys(state)) {
    if (now - state[key].createdAt > STALE_THRESHOLD_MS) {
      delete state[key];
      pruned = true;
    }
  }
  if (pruned) {
    writeState(state);
  }
  return state;
}

export function writeState(state: WorktreeState): void {
  const dir = path.dirname(stateFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = stateFilePath + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFilePath);
}

export function registerWorktree(sessionId: string, worktreePath: string): void {
  const state = readState();
  state[sessionId] = { path: worktreePath, createdAt: Date.now() };
  writeState(state);
}

export function unregisterWorktree(sessionId: string): void {
  const state = readState();
  delete state[sessionId];
  writeState(state);
}

export function resolveTarget(sessionId: string, fallbackCwd: string): string {
  const state = readState();
  return state[sessionId]?.path ?? fallbackCwd;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/hook/worktree-state.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add plugins/unity-mcp/src/hook/worktree-state.ts
git commit -m "feat: add worktree-state module for tracking active worktrees"
```

---

### Task 3: Hook Entry Point — Tests

**Files:**
- Create: `plugins/unity-mcp/__tests__/hook/index.test.ts`

- [ ] **Step 1: Write tests for hook routing by event name**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock dependencies before importing
const mockRecompile = vi.fn().mockResolvedValue({ skipped: true });
const mockLint = vi.fn().mockResolvedValue(undefined);
const mockDetectProject = vi.fn().mockReturnValue(null);
const mockRegisterWorktree = vi.fn();
const mockUnregisterWorktree = vi.fn();
const mockResolveTarget = vi.fn((_, fallback) => fallback);

vi.mock("../../src/core/recompile.js", () => ({ recompile: mockRecompile }));
vi.mock("../../src/core/lint.js", () => ({ lint: mockLint }));
vi.mock("../../src/core/detect.js", () => ({ detectProject: mockDetectProject }));
vi.mock("../../src/hook/worktree-state.js", () => ({
  registerWorktree: mockRegisterWorktree,
  unregisterWorktree: mockUnregisterWorktree,
  resolveTarget: mockResolveTarget,
}));
vi.mock("../../src/lib/logger.js", () => ({ log: vi.fn() }));

// We test the parseStdin + routing logic by extracting it to a testable function.
// The actual index.ts will export a `handleHook` function for testability.
import { handleHook } from "../../src/hook/index.js";

describe("hook routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("WorktreeCreate registers worktree and exits", async () => {
    const result = await handleHook({
      hook_event_name: "WorktreeCreate",
      session_id: "sess-1",
      cwd: "/main/project",
      worktree_path: "/tmp/worktree-feat",
    });
    expect(mockRegisterWorktree).toHaveBeenCalledWith("sess-1", "/tmp/worktree-feat");
    expect(result).toBe("registered");
    expect(mockRecompile).not.toHaveBeenCalled();
  });

  it("WorktreeRemove unregisters worktree and exits", async () => {
    const result = await handleHook({
      hook_event_name: "WorktreeRemove",
      session_id: "sess-1",
      cwd: "/main/project",
      worktree_path: "/tmp/worktree-feat",
    });
    expect(mockUnregisterWorktree).toHaveBeenCalledWith("sess-1");
    expect(result).toBe("unregistered");
    expect(mockRecompile).not.toHaveBeenCalled();
  });

  it("Stop resolves target via worktree state", async () => {
    mockResolveTarget.mockReturnValue("/tmp/worktree-feat");
    mockDetectProject.mockReturnValue("/tmp/worktree-feat");
    mockRecompile.mockResolvedValue({ skipped: true });

    await handleHook({
      hook_event_name: "Stop",
      session_id: "sess-1",
      cwd: "/main/project",
    });

    expect(mockResolveTarget).toHaveBeenCalledWith("sess-1", "/main/project");
    expect(mockDetectProject).toHaveBeenCalledWith("/tmp/worktree-feat");
  });

  it("SubagentStop resolves target via worktree state", async () => {
    mockResolveTarget.mockReturnValue("/fallback");
    mockDetectProject.mockReturnValue(null);

    await handleHook({
      hook_event_name: "SubagentStop",
      session_id: "sess-2",
      cwd: "/fallback",
    });

    expect(mockResolveTarget).toHaveBeenCalledWith("sess-2", "/fallback");
    expect(mockDetectProject).toHaveBeenCalledWith("/fallback");
    expect(mockRecompile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/hook/index.test.ts`
Expected: FAIL — `handleHook` is not exported from `../../src/hook/index.js`

- [ ] **Step 3: Commit**

```bash
git add plugins/unity-mcp/__tests__/hook/index.test.ts
git commit -m "test: add hook routing unit tests (red)"
```

---

### Task 4: Hook Entry Point — Refactor to Support Routing

**Files:**
- Modify: `plugins/unity-mcp/src/hook/index.ts`

- [ ] **Step 1: Refactor index.ts — extract `handleHook`, parse new stdin fields, route by event**

Replace the entire contents of `plugins/unity-mcp/src/hook/index.ts` with:

```typescript
import fs from "node:fs";
import { detectProject } from "../core/detect.js";
import { recompile } from "../core/recompile.js";
import { lint } from "../core/lint.js";
import { log } from "../lib/logger.js";
import { registerWorktree, unregisterWorktree, resolveTarget } from "./worktree-state.js";
import type { Logger } from "../core/types.js";

export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  worktree_path?: string;
}

function parseStdinInput(): HookInput {
  try {
    const stdin = fs.readFileSync(0, "utf-8");
    if (stdin) {
      const data = JSON.parse(stdin);
      return {
        session_id: data.session_id ?? "",
        cwd: data.cwd ?? process.cwd(),
        hook_event_name: data.hook_event_name ?? "",
        worktree_path: data.worktree_path,
      };
    }
  } catch {
    // Ignore parse errors
  }
  return { session_id: "", cwd: process.cwd(), hook_event_name: "" };
}

const logger: Logger = {
  log(msg) { log(msg); },
  error(msg) { log(`ERROR: ${msg}`); },
};

export async function handleHook(input: HookInput): Promise<string> {
  logger.log(`=== Hook started (${input.hook_event_name}) ===`);

  // Worktree bookkeeping events
  if (input.hook_event_name === "WorktreeCreate") {
    if (input.worktree_path && input.session_id) {
      registerWorktree(input.session_id, input.worktree_path);
      logger.log(`Registered worktree: ${input.worktree_path} for session ${input.session_id}`);
    }
    return "registered";
  }

  if (input.hook_event_name === "WorktreeRemove") {
    if (input.session_id) {
      unregisterWorktree(input.session_id);
      logger.log(`Unregistered worktree for session ${input.session_id}`);
    }
    return "unregistered";
  }

  // Recompile events (Stop, SubagentStop, etc.)
  const target = resolveTarget(input.session_id, input.cwd);
  logger.log(`target: ${target} (cwd: ${input.cwd}, session: ${input.session_id})`);

  const projectPath = detectProject(target);
  if (!projectPath) {
    logger.log(`Not a Unity project: ${target}`);
    return "not-unity";
  }
  logger.log(`Unity project: ${projectPath}`);

  // Skip marker check (adapter-level policy)
  const skipMarker = `${projectPath}/.claude/hooks-skip-recompile`;
  if (fs.existsSync(skipMarker)) {
    logger.log("Skipping: project has .claude/hooks-skip-recompile marker");
    return "skipped-marker";
  }

  const result = await recompile(projectPath, logger);

  if (result.skipped) {
    logger.log("No changes detected, exiting");
    return "skipped";
  }

  if (result.success) {
    logger.log("SUCCESS: Unity recompilation complete");
    process.stderr.write("Unity compiled successfully\n");
    await lint(projectPath, { logger });
    return "success";
  }

  // Compilation errors
  logger.log("FAILED: Unity compilation errors found");
  process.stderr.write("Unity compilation failed:\n\n");
  process.stderr.write(result.errors.map((e) => e.message).join("\n") + "\n\n");
  process.stderr.write("Fix these errors to continue.\n");
  return "failed";
}

async function main(): Promise<void> {
  const input = parseStdinInput();
  const result = await handleHook(input);

  if (result === "failed") {
    process.exit(2);
  }
}

main().catch((err) => {
  logger.error(`Unhandled error: ${err}`);
  process.stderr.write(`Unity recompile hook error: ${err}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Run hook routing tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/hook/index.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 3: Run worktree-state tests to verify nothing broke**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/hook/worktree-state.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 4: Commit**

```bash
git add plugins/unity-mcp/src/hook/index.ts
git commit -m "feat: refactor hook entry point with worktree-aware routing"
```

---

### Task 5: Update hooks.json

**Files:**
- Modify: `plugins/unity-mcp/hooks/hooks.json`

- [ ] **Step 1: Add WorktreeCreate and WorktreeRemove events**

Replace the entire contents of `plugins/unity-mcp/hooks/hooks.json` with:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/unity-recompile.sh"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/unity-recompile.sh"
          }
        ]
      }
    ],
    "WorktreeCreate": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/unity-recompile.sh"
          }
        ]
      }
    ],
    "WorktreeRemove": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/unity-recompile.sh"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/hooks/hooks.json
git commit -m "feat: register WorktreeCreate and WorktreeRemove hook events"
```

---

### Task 6: Build and Verify

**Files:**
- No new files

- [ ] **Step 1: Run the full test suite**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests pass (existing + new)

- [ ] **Step 2: Build the project**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Clean build, `dist/hook.mjs` regenerated with new routing logic

- [ ] **Step 3: Increment version in package.json**

Bump the patch version in `plugins/unity-mcp/package.json`.

- [ ] **Step 4: Commit**

```bash
git add plugins/unity-mcp/package.json plugins/unity-mcp/dist/
git commit -m "chore: build dist, bump version for worktree-aware hook"
```
