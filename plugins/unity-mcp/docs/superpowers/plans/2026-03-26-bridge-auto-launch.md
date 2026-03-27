# Bridge Auto-Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CLI batch-mode fallback with automatic Unity launch integrated into the bridge, so all tools work uniformly whether Unity is running or not.

**Architecture:** New `launch.ts` module provides `ensureUnityRunning()` called at the top of `sendBridgeRequest()`. It spawns Unity interactively (detached) and polls for the process to appear. The separate `cli-fallback.ts` is deleted and `recompile.ts` loses its branching logic.

**Tech Stack:** Node.js child_process (spawn), vitest for unit/e2e tests

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/bridge/launch.ts` | Create | `ensureUnityRunning()`, `readUnityVersion()`, `resolveUnityBinary()` |
| `src/lib/bridge/__tests__/launch.test.ts` | Create | Unit tests for launch module |
| `src/lib/bridge/request.ts` | Modify | Replace `unity_not_running` early return with `ensureUnityRunning()` call; pass dynamic bootstrap timeout |
| `src/lib/bridge/__tests__/request.test.ts` | Modify | Update mock for `ensureUnityRunning`; replace `unity_not_running` test |
| `src/lib/compile/cli-fallback.ts` | Delete | No longer needed |
| `src/core/recompile.ts` | Modify | Remove fallback branch, always use bridge |
| `__tests__/core/recompile.test.ts` | Modify | Remove cli-fallback mock, mock `sendBridgeRequest` instead |
| `src/lib/config.ts` | Modify | Add `UNITY_LAUNCH_TIMEOUT_MS`, `BRIDGE_READY_LAUNCH_TIMEOUT_MS` constants |
| `__tests__/e2e/helpers/state.ts` | Modify | Remove `unityPid` from `E2EState` |
| `__tests__/e2e/helpers/unity.ts` | Modify | Add `findUnityPidForProject()` helper using `findUnityPid` from production code |
| `__tests__/e2e/global-setup.ts` | Modify | Remove Unity launch steps; use dynamic PID for cleanup |
| `__tests__/e2e/global-teardown.ts` | Modify | Use dynamic PID detection instead of state |
| `__tests__/e2e/01-bridge-lifecycle.test.ts` | Modify | Remove `unityPid` from state; use dynamic PID |

---

### Task 1: Add timeout constants to config

**Files:**
- Modify: `src/lib/config.ts:8-12`

- [ ] **Step 1: Add the new timeout constants**

In `src/lib/config.ts`, add after the existing timeout constants (line 12):

```typescript
export const UNITY_LAUNCH_TIMEOUT_MS = 30_000;
export const BRIDGE_READY_LAUNCH_TIMEOUT_MS = 300_000;
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/config.ts
git commit -m "feat: add Unity launch timeout constants"
```

---

### Task 2: Create `launch.ts` with tests (TDD)

**Files:**
- Create: `src/lib/bridge/launch.ts`
- Create: `src/lib/bridge/__tests__/launch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/bridge/__tests__/launch.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../compile/applescript.js", () => ({
  unityIsRunning: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

describe("readUnityVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses version from ProjectVersion.txt", async () => {
    const fs = (await import("node:fs")).default;
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "m_EditorVersion: 2022.3.0f1\nm_EditorVersionWithRevision: 2022.3.0f1 (abc123)",
    );

    const { readUnityVersion } = await import("../launch.js");
    expect(readUnityVersion("/project")).toBe("2022.3.0f1");
  });

  it("returns null when file is missing", async () => {
    const fs = (await import("node:fs")).default;
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { readUnityVersion } = await import("../launch.js");
    expect(readUnityVersion("/project")).toBeNull();
  });

  it("returns null when version line is missing", async () => {
    const fs = (await import("node:fs")).default;
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("some other content");

    const { readUnityVersion } = await import("../launch.js");
    expect(readUnityVersion("/project")).toBeNull();
  });
});

describe("resolveUnityBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns path when binary exists", async () => {
    const fs = (await import("node:fs")).default;
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { resolveUnityBinary } = await import("../launch.js");
    expect(resolveUnityBinary("2022.3.0f1")).toBe(
      "/Applications/Unity/Hub/Editor/2022.3.0f1/Unity.app/Contents/MacOS/Unity",
    );
  });

  it("throws when binary does not exist", async () => {
    const fs = (await import("node:fs")).default;
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { resolveUnityBinary } = await import("../launch.js");
    expect(() => resolveUnityBinary("2022.3.0f1")).toThrow("unity_not_found");
  });
});

describe("ensureUnityRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns immediately when Unity is already running", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { ensureUnityRunning } = await import("../launch.js");
    await ensureUnityRunning("/project");

    const { spawn } = await import("node:child_process");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns Unity detached with correct args when not running", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const fs = (await import("node:fs")).default;
    const { spawn } = await import("node:child_process");

    // Not running initially, then running after spawn
    (unityIsRunning as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(false)  // initial check
      .mockReturnValueOnce(true);  // poll after spawn

    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "m_EditorVersion: 2022.3.0f1",
    );
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const mockUnref = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue({ unref: mockUnref });

    const { ensureUnityRunning } = await import("../launch.js");
    await ensureUnityRunning("/project");

    expect(spawn).toHaveBeenCalledWith(
      "/Applications/Unity/Hub/Editor/2022.3.0f1/Unity.app/Contents/MacOS/Unity",
      ["-projectPath", "/project"],
      { detached: true, stdio: "ignore" },
    );
    expect(mockUnref).toHaveBeenCalled();
  });

  it("throws unity_launch_failed when process never appears", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const fs = (await import("node:fs")).default;
    const { spawn } = await import("node:child_process");

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "m_EditorVersion: 2022.3.0f1",
    );
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const mockUnref = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue({ unref: mockUnref });

    const { ensureUnityRunning } = await import("../launch.js");
    // Use a short timeout for the test
    await expect(ensureUnityRunning("/project", 100)).rejects.toThrow("unity_launch_failed");
  });

  it("throws when version cannot be read", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const fs = (await import("node:fs")).default;

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { ensureUnityRunning } = await import("../launch.js");
    await expect(ensureUnityRunning("/project")).rejects.toThrow(
      "Could not detect Unity version",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/launch.test.ts`
Expected: FAIL — module `../launch.js` not found

- [ ] **Step 3: Implement launch.ts**

Create `src/lib/bridge/launch.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { unityIsRunning } from "../compile/applescript.js";
import { log } from "../logger.js";
import { UNITY_LAUNCH_TIMEOUT_MS, POLL_INTERVAL_MS } from "../config.js";

const UNITY_HUB_EDITOR_DIR = "/Applications/Unity/Hub/Editor";

/**
 * Read the Unity version from ProjectSettings/ProjectVersion.txt.
 */
export function readUnityVersion(projectPath: string): string | null {
  const versionFile = path.join(projectPath, "ProjectSettings", "ProjectVersion.txt");
  try {
    const content = fs.readFileSync(versionFile, "utf-8");
    const match = content.match(/m_EditorVersion:\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the full path to the Unity binary for a given version.
 * Throws with error code "unity_not_found" if the binary doesn't exist.
 */
export function resolveUnityBinary(version: string): string {
  const binaryPath = path.join(
    UNITY_HUB_EDITOR_DIR,
    version,
    "Unity.app",
    "Contents/MacOS/Unity",
  );
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `unity_not_found: Unity ${version} not found at ${binaryPath}. Ensure it is installed via Unity Hub.`,
    );
  }
  return binaryPath;
}

/**
 * Ensure Unity Editor is running for the given project.
 * If not running, launches it interactively (detached) and waits for the process to appear.
 */
export async function ensureUnityRunning(
  projectPath: string,
  launchTimeoutMs: number = UNITY_LAUNCH_TIMEOUT_MS,
): Promise<boolean> {
  if (unityIsRunning(projectPath)) {
    return false; // was already running
  }

  const version = readUnityVersion(projectPath);
  if (!version) {
    throw new Error(
      `Could not detect Unity version from ProjectVersion.txt in ${projectPath}`,
    );
  }

  const binaryPath = resolveUnityBinary(version);

  log(`Launching Unity ${version} for project: ${projectPath}`);
  process.stderr.write(
    `Unity not running. Launching Unity ${version} (this may take a moment)...\n`,
  );

  const child = spawn(binaryPath, ["-projectPath", projectPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll until Unity process appears
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    if (unityIsRunning(projectPath)) {
      log("Unity process detected after launch");
      return true; // was freshly launched
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `unity_launch_failed: Unity process did not appear within ${launchTimeoutMs / 1000}s. Check Unity installation.`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/launch.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bridge/launch.ts src/lib/bridge/__tests__/launch.test.ts
git commit -m "feat: add ensureUnityRunning with auto-launch logic"
```

---

### Task 3: Integrate `ensureUnityRunning` into `sendBridgeRequest`

**Files:**
- Modify: `src/lib/bridge/request.ts:1-54`
- Modify: `src/lib/bridge/__tests__/request.test.ts`

- [ ] **Step 1: Update the request.test.ts mock and tests**

In `src/lib/bridge/__tests__/request.test.ts`, replace the `applescript.js` mock with a `launch.js` mock and update affected tests:

Replace the mock at the top (lines 5-8):
```typescript
vi.mock("../../compile/applescript.js", () => ({
  unityIsRunning: vi.fn(),
  triggerEditorRefreshOnly: vi.fn(),
}));
```

With:
```typescript
vi.mock("../launch.js", () => ({
  ensureUnityRunning: vi.fn(),
}));

vi.mock("../../compile/applescript.js", () => ({
  triggerEditorRefreshOnly: vi.fn(),
}));
```

Replace the first test (lines 37-49) — `"returns unity_not_running when Unity is not running"`:
```typescript
  it("throws when ensureUnityRunning fails", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("unity_launch_failed: Unity process did not appear within 30s."),
    );

    const { sendBridgeRequest } = await import("../request.js");
    await expect(sendBridgeRequest("/project", "list_tests")).rejects.toThrow(
      "unity_launch_failed",
    );
  });
```

In the remaining tests, replace all occurrences of:
```typescript
    const { unityIsRunning } = await import("../../compile/applescript.js");
    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
```

With:
```typescript
    const { ensureUnityRunning } = await import("../launch.js");
    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);
```

This applies to tests on lines 51, 79, 108, 126, and 144. The mock returns `false` meaning Unity was already running (not freshly launched).

Add a new test after the bootstrap tests to verify the extended timeout when Unity was freshly launched:

```typescript
  it("uses extended bootstrap timeout when Unity was freshly launched", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    const { bridgeReadyMatchesProject, waitForBridgeReady, waitForBridgeStatus } = await import("../ipc.js");

    // ensureUnityRunning returns true = freshly launched
    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (waitForBridgeReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    // Should have used the 300s launch timeout, not the default 120s
    expect(waitForBridgeReady).toHaveBeenCalledWith(
      expect.any(String),
      "/project",
      300_000,
    );
    expect(result).toEqual({
      ok: false,
      error: "bridge_bootstrap_failed",
      message: "Bridge did not become ready after bootstrap refresh.",
    });
  });
```

- [ ] **Step 2: Run tests to verify the new test fails and others still work with updated mocks**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: The new "extended timeout" test FAILS (production code not updated yet). The "throws when ensureUnityRunning fails" test FAILS (still returns `unity_not_running` instead of throwing).

- [ ] **Step 3: Update request.ts to use ensureUnityRunning**

In `src/lib/bridge/request.ts`, make these changes:

Replace the import (line 13-14):
```typescript
import {
  triggerEditorRefreshOnly,
  unityIsRunning,
} from "../compile/applescript.js";
```

With:
```typescript
import { triggerEditorRefreshOnly } from "../compile/applescript.js";
import { ensureUnityRunning } from "./launch.js";
```

Add import for the new config constant (line 6, after `BRIDGE_VERSION`):
```typescript
import {
  bridgePaths,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_READY_LAUNCH_TIMEOUT_MS,
  BRIDGE_READY_TIMEOUT_MS,
  BRIDGE_STATUS_TIMEOUT_MS,
  BRIDGE_VERSION,
  TEST_STATUS_TIMEOUT_MS,
} from "../config.js";
```

Replace lines 51-54 (the `unityIsRunning` check):
```typescript
  // 1. Check Unity running
  if (!unityIsRunning(projectPath)) {
    return { ok: false, error: "unity_not_running", message: "Unity editor is not running." };
  }
```

With:
```typescript
  // 1. Ensure Unity is running (launches if needed)
  const freshlyLaunched = await ensureUnityRunning(projectPath);
```

Replace line 67 (the `waitForBridgeReady` call):
```typescript
    const ready = await waitForBridgeReady(paths.readyFile, projectPath, BRIDGE_READY_TIMEOUT_MS);
```

With:
```typescript
    const bootstrapTimeout = freshlyLaunched ? BRIDGE_READY_LAUNCH_TIMEOUT_MS : BRIDGE_READY_TIMEOUT_MS;
    const ready = await waitForBridgeReady(paths.readyFile, projectPath, bootstrapTimeout);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bridge/request.ts src/lib/bridge/__tests__/request.test.ts
git commit -m "feat: integrate ensureUnityRunning into sendBridgeRequest"
```

---

### Task 4: Simplify `recompile.ts` and update its tests

**Files:**
- Modify: `src/core/recompile.ts:1-65`
- Modify: `__tests__/core/recompile.test.ts`

- [ ] **Step 1: Update recompile.test.ts**

Replace the mock block at lines 10-20:
```typescript
vi.mock("../../src/lib/compile/applescript.js", () => ({
  unityIsRunning: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/lib/compile/cli-fallback.js", () => ({
  runCliFallback: vi.fn().mockResolvedValue({
    success: true,
    didCompile: true,
    errors: [],
  }),
}));
```

With:
```typescript
vi.mock("../../src/lib/bridge/request.js", () => ({
  sendBridgeRequest: vi.fn().mockResolvedValue({
    ok: true,
    status: {
      protocolVersion: 1,
      bridgeVersion: "4",
      requestId: "test-001",
      projectPath: "/project",
      state: "completed",
      isSuccess: true,
      didCompile: true,
      errors: [],
      summary: "",
    },
  }),
}));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/recompile.test.ts`
Expected: FAIL — `recompile.ts` still imports `cli-fallback.js` and `applescript.js`

- [ ] **Step 3: Simplify recompile.ts**

Remove these imports from `src/core/recompile.ts`:
```typescript
import { unityIsRunning } from "../lib/compile/applescript.js";
import { runCliFallback } from "../lib/compile/cli-fallback.js";
```

Replace the compile section (lines 42-65):
```typescript
  // 3. Compile
  let compileErrors: string[];
  let success: boolean;
  let didCompile: boolean;

  if (unityIsRunning(projectPath)) {
    const result = await sendBridgeRequest(projectPath, "recompile");
    if (!result.ok) {
      return {
        success: false,
        skipped: false,
        errors: [{ assembly: "", file: "", line: 0, column: 0, message: result.message, type: "error" }],
      };
    }
    const parsed = parseBridgeStatusToResult(result.status);
    success = parsed.success;
    didCompile = parsed.didCompile;
    compileErrors = parsed.errors;
  } else {
    const cliResult = await runCliFallback(projectPath);
    success = cliResult.success;
    didCompile = cliResult.didCompile;
    compileErrors = cliResult.errors;
  }
```

With:
```typescript
  // 3. Compile via bridge (auto-launches Unity if needed)
  const result = await sendBridgeRequest(projectPath, "recompile");
  if (!result.ok) {
    return {
      success: false,
      skipped: false,
      errors: [{ assembly: "", file: "", line: 0, column: 0, message: result.message, type: "error" }],
    };
  }
  const parsed = parseBridgeStatusToResult(result.status);
  const success = parsed.success;
  const didCompile = parsed.didCompile;
  const compileErrors = parsed.errors;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/recompile.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/recompile.ts __tests__/core/recompile.test.ts
git commit -m "refactor: remove CLI fallback from recompile, use bridge exclusively"
```

---

### Task 5: Delete `cli-fallback.ts`

**Files:**
- Delete: `src/lib/compile/cli-fallback.ts`

- [ ] **Step 1: Verify no remaining imports**

Run: `grep -r "cli-fallback" plugins/unity-mcp/src/` — should return nothing (after Task 4 removed the import from `recompile.ts`).

- [ ] **Step 2: Delete the file**

```bash
rm plugins/unity-mcp/src/lib/compile/cli-fallback.ts
```

- [ ] **Step 3: Run all unit tests to confirm nothing breaks**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All unit tests PASS

- [ ] **Step 4: Commit**

```bash
git add -u plugins/unity-mcp/src/lib/compile/cli-fallback.ts
git commit -m "refactor: delete cli-fallback.ts, replaced by bridge auto-launch"
```

---

### Task 6: Update E2E state helper

**Files:**
- Modify: `__tests__/e2e/helpers/state.ts`

- [ ] **Step 1: Remove `unityPid` from `E2EState`**

Replace the `E2EState` interface:
```typescript
export interface E2EState {
  projectPath: string;
  unityVersion: string;
  unityPid: number;
  jbAvailable: boolean;
}
```

With:
```typescript
export interface E2EState {
  projectPath: string;
  unityVersion: string;
  jbAvailable: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git add __tests__/e2e/helpers/state.ts
git commit -m "refactor(e2e): remove unityPid from E2EState"
```

---

### Task 7: Update E2E global setup

**Files:**
- Modify: `__tests__/e2e/global-setup.ts`

- [ ] **Step 1: Update imports**

Replace the imports (lines 5-12):
```typescript
import {
  findLatestUnityVersion,
  unityBinaryPath,
  createUnityProject,
  openUnityEditor,
  waitForUnityProcess,
  isJbAvailable,
  closeUnity,
} from "./helpers/unity.js";
```

With:
```typescript
import {
  findLatestUnityVersion,
  unityBinaryPath,
  createUnityProject,
  isJbAvailable,
  closeUnityForProject,
} from "./helpers/unity.js";
```

- [ ] **Step 2: Update emergencyCleanup to use dynamic PID detection**

Replace the `emergencyCleanup` function (lines 19-33):
```typescript
function emergencyCleanup(): void {
  try {
    const state = readState();
    if (state.unityPid) {
      try { process.kill(state.unityPid, "SIGKILL"); } catch { /* already dead */ }
    }
    if (state.projectPath) {
      fs.rmSync(state.projectPath, { recursive: true, force: true });
    }
    cleanupState();
  } catch {
    // No state file — nothing to clean
  }
}
```

With:
```typescript
function emergencyCleanup(): void {
  try {
    const state = readState();
    if (state.projectPath) {
      closeUnityForProject(state.projectPath);
      fs.rmSync(state.projectPath, { recursive: true, force: true });
    }
    cleanupState();
  } catch {
    // No state file — nothing to clean
  }
}
```

- [ ] **Step 3: Remove Unity launch steps from globalSetup**

Remove lines 93-99 (open editor + wait for process):
```typescript
  // 6. Open editor (non-batch)
  console.log("[E2E] Opening Unity Editor...");
  openUnityEditor(unityBinaryPath(version), PROJECT_DIR);

  // 7. Wait for Unity process to appear
  const pid = await waitForUnityProcess(PROJECT_DIR);
  console.log(`[E2E] Unity process detected: PID ${pid}`);
```

Update the state write (lines 102-107) to remove `unityPid`:
```typescript
  writeState({
    projectPath: PROJECT_DIR,
    unityVersion: version,
    jbAvailable,
  });
```

Update the teardown return (lines 112-131) to use dynamic PID:
```typescript
  return async () => {
    console.log("[E2E] Starting global teardown...");
    try {
      const state = readState();
      if (state.projectPath) {
        console.log("[E2E] Closing Unity if running...");
        closeUnityForProject(state.projectPath);
        console.log("[E2E] Unity closed");
        console.log(`[E2E] Deleting project: ${state.projectPath}`);
        fs.rmSync(state.projectPath, { recursive: true, force: true });
        console.log("[E2E] Project deleted");
      }
      cleanupState();
    } catch {
      console.log("[E2E] No state file found, nothing to tear down");
    }
    console.log("[E2E] Global teardown complete");
  };
```

- [ ] **Step 4: Commit**

```bash
git add __tests__/e2e/global-setup.ts
git commit -m "refactor(e2e): remove Unity launch from global setup"
```

---

### Task 8: Update E2E global teardown

**Files:**
- Modify: `__tests__/e2e/global-teardown.ts`

- [ ] **Step 1: Update to use dynamic PID detection**

Replace the full file content:
```typescript
import fs from "node:fs";
import { readState, cleanupState } from "./helpers/state.js";
import { closeUnityForProject } from "./helpers/unity.js";

export default async function globalTeardown(): Promise<void> {
  console.log("[E2E] Starting global teardown...");

  let state;
  try {
    state = readState();
  } catch {
    console.log("[E2E] No state file found, nothing to tear down");
    return;
  }

  // 1. Close Unity if still running
  if (state.projectPath) {
    console.log("[E2E] Closing Unity if running...");
    closeUnityForProject(state.projectPath);
    console.log("[E2E] Unity closed");

    // 2. Delete temp project
    console.log(`[E2E] Deleting project: ${state.projectPath}`);
    fs.rmSync(state.projectPath, { recursive: true, force: true });
    console.log("[E2E] Project deleted");
  }

  // 3. Cleanup state file
  cleanupState();

  console.log("[E2E] Global teardown complete");
}
```

- [ ] **Step 2: Commit**

```bash
git add __tests__/e2e/global-teardown.ts
git commit -m "refactor(e2e): use dynamic PID detection in teardown"
```

---

### Task 9: Add `closeUnityForProject` to E2E unity helper

**Files:**
- Modify: `__tests__/e2e/helpers/unity.ts`

- [ ] **Step 1: Add the helper function and remove unused exports**

Add `closeUnityForProject` to `__tests__/e2e/helpers/unity.ts` (after `closeUnity`):

```typescript
/**
 * Find and close Unity for a project path. No-op if Unity isn't running.
 * Uses ps-based detection (same as production findUnityPid).
 */
export function closeUnityForProject(projectDir: string): void {
  try {
    const output = execSync(
      `ps aux | grep '[U]nity' | grep "${projectDir}" | grep -v batchMode | awk '{print $2}' | head -1`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
    if (output) {
      const pid = parseInt(output, 10);
      console.log(`[E2E] Found Unity PID ${pid} for project, closing...`);
      closeUnity(pid);
    } else {
      console.log("[E2E] No Unity process found for project");
    }
  } catch {
    // Not found — nothing to close
  }
}
```

Remove `openUnityEditor` and `waitForUnityProcess` functions (lines 57-87) since they're no longer used by global setup. Keep `waitForEditorLogRefresh` in case it's used elsewhere.

- [ ] **Step 2: Commit**

```bash
git add __tests__/e2e/helpers/unity.ts
git commit -m "refactor(e2e): add closeUnityForProject, remove unused helpers"
```

---

### Task 10: Update E2E bridge lifecycle test

**Files:**
- Modify: `__tests__/e2e/01-bridge-lifecycle.test.ts`

- [ ] **Step 1: Replace PID state usage with dynamic detection**

Replace the imports and variables (lines 1-17):
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import { triggerOsascriptRefresh } from "./helpers/unity.js";
import {
  BRIDGE_EDITOR_DIR,
  BRIDGE_VERSION,
  BRIDGE_IPC_DIRNAME,
  BRIDGE_READY_FILENAME,
} from "../../src/lib/config.js";

let mcp: McpTestClient;
let projectPath: string;
let unityPid: number;
```

With:
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import { triggerOsascriptRefresh } from "./helpers/unity.js";
import { findUnityPid } from "../../src/lib/compile/applescript.js";
import {
  BRIDGE_EDITOR_DIR,
  BRIDGE_VERSION,
  BRIDGE_IPC_DIRNAME,
  BRIDGE_READY_FILENAME,
} from "../../src/lib/config.js";

let mcp: McpTestClient;
let projectPath: string;
```

Replace the `beforeAll` (lines 20-36):
```typescript
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;
    unityPid = state.unityPid;

    // Cross-phase isolation: reset to baseline
    execSync("git reset --hard e2e-baseline && git clean -fd -- Assets/", {
      cwd: projectPath,
      stdio: "ignore",
    });

    // Create MCP client
    mcp = await createMcpClient(projectPath);

    // Bootstrap: reinstall bridge after git clean
    await mcp.callTool("unity_recompile");
  }, 600_000);
```

With:
```typescript
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;

    // Cross-phase isolation: reset to baseline
    execSync("git reset --hard e2e-baseline && git clean -fd -- Assets/", {
      cwd: projectPath,
      stdio: "ignore",
    });

    // Create MCP client
    mcp = await createMcpClient(projectPath);

    // First tool call: auto-launches Unity + installs bridge + recompiles
    await mcp.callTool("unity_recompile");
  }, 600_000);
```

In test 3 (line 74), replace `triggerOsascriptRefresh(unityPid)` with dynamic PID lookup:
```typescript
    const pid = findUnityPid(projectPath);
    expect(pid).not.toBeNull();
    triggerOsascriptRefresh(parseInt(pid!, 10));
```

- [ ] **Step 2: Commit**

```bash
git add __tests__/e2e/01-bridge-lifecycle.test.ts
git commit -m "refactor(e2e): use dynamic PID detection in bridge lifecycle test"
```

---

### Task 11: Build and verify

**Files:**
- No new files

- [ ] **Step 1: Run all unit tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All unit tests PASS

- [ ] **Step 2: Build the dist bundle**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds, `dist/server.mjs` regenerated

- [ ] **Step 3: Increment version**

Update version in `plugins/unity-mcp/package.json` (bump patch version).

- [ ] **Step 4: Final commit**

```bash
git add plugins/unity-mcp/dist/ plugins/unity-mcp/package.json
git commit -m "chore: build dist and bump version for bridge auto-launch"
```
