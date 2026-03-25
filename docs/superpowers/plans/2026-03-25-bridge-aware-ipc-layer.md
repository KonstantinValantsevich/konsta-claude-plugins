# Bridge-Aware IPC Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated IPC boilerplate across tools with a single `sendBridgeRequest` entry point that self-installs the bridge, handles bootstrap, and returns structured `BridgeResult`.

**Architecture:** New `lib/bridge/request.ts` absorbs orchestration logic from `orchestrate.ts`. Each tool (`list-tests`, `test`, `recompile`, `lint`) calls `sendBridgeRequest` instead of manually managing preconditions + IPC. `orchestrate.ts` is deleted once all callers migrate.

**Tech Stack:** TypeScript, Node.js fs, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/lib/bridge/types.ts` | Add `BridgeResult`, `BridgeError`, `BridgeAction` types |
| **New:** `src/lib/bridge/request.ts` | `sendBridgeRequest` — self-sufficient IPC entry point. Absorbs orchestration from `orchestrate.ts` |
| `src/core/list-tests.ts` | Replace ~40 lines of IPC boilerplate with `sendBridgeRequest("list_tests")` |
| `src/core/recompile.ts` | Replace `orchestrateRecompile` call with `sendBridgeRequest("recompile")` |
| `src/core/test.ts` | Add `recompile()` call, replace IPC boilerplate with `sendBridgeRequest("run_tests")` |
| `src/core/lint.ts` | Add `recompile()` call before jb execution |
| `src/lib/bridge/orchestrate.ts` | **Delete** — all logic absorbed into `request.ts` |
| **New:** `src/lib/bridge/__tests__/request.test.ts` | Tests for `sendBridgeRequest` |

---

### Task 1: Add `BridgeResult` / `BridgeError` / `BridgeAction` types

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/types.ts:100-105`

- [ ] **Step 1: Add the new types at the end of `types.ts`**

Append after the existing `CompileResult` interface (line 105):

```typescript
// --- Bridge-Aware IPC Layer types ---

/** Actions that tools may request via sendBridgeRequest. */
export type BridgeAction = "recompile" | "run_tests" | "list_tests";

/** Discriminated union returned by sendBridgeRequest. */
export type BridgeResult =
  | { ok: true; status: BridgeStatus }
  | { ok: false; error: BridgeError; message: string };

export type BridgeError =
  | "unity_not_running"
  | "bridge_bootstrap_failed"
  | "bridge_busy"
  | "bridge_error"
  | "compilation_failed"
  | "version_mismatch"
  | "request_timeout";
```

- [ ] **Step 2: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```
git add plugins/unity-mcp/src/lib/bridge/types.ts
git commit -m "feat: add BridgeResult, BridgeError, BridgeAction types"
```

---

### Task 2: Create `sendBridgeRequest` in `request.ts`

**Files:**
- Create: `plugins/unity-mcp/src/lib/bridge/request.ts`
- Create: `plugins/unity-mcp/src/lib/bridge/__tests__/request.test.ts`

This is the core of the refactor. `sendBridgeRequest` absorbs logic from `orchestrate.ts` (`bridgeRequestAndWait`, `runBridgeBootstrapAndRecompile`) and adds self-install + precondition checks.

- [ ] **Step 1: Write test for `sendBridgeRequest` — unity not running**

Create `plugins/unity-mcp/src/lib/bridge/__tests__/request.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BridgeResult } from "../types.js";

// Mock all external dependencies before importing the module under test
vi.mock("../../compile/applescript.js", () => ({
  unityIsRunning: vi.fn(),
  triggerEditorRefreshOnly: vi.fn(),
}));

vi.mock("../install.js", () => ({
  ensureBridgeInstalled: vi.fn(() => ({ changed: false })),
  ensureGitExclude: vi.fn(),
}));

vi.mock("../ipc.js", () => ({
  bridgeReadyMatchesProject: vi.fn(),
  generateRequestId: vi.fn(() => "test-req-001"),
  writeBridgeRequest: vi.fn(),
  waitForBridgeReady: vi.fn(),
  waitForBridgeStatus: vi.fn(),
  sleep: vi.fn(),
}));

// Mock fs — only the methods sendBridgeRequest uses
vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

describe("sendBridgeRequest", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns unity_not_running when Unity is not running", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { sendBridgeRequest } = await import("../request.js");
    const result: BridgeResult = await sendBridgeRequest("/project", "list_tests");

    expect(result).toEqual({
      ok: false,
      error: "unity_not_running",
      message: "Unity editor is not running.",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: FAIL — module `../request.js` not found

- [ ] **Step 3: Create `request.ts` with the unity-not-running check**

Create `plugins/unity-mcp/src/lib/bridge/request.ts`:

```typescript
import fs from "node:fs";
import {
  bridgePaths,
  BRIDGE_BUSY_RETRY_DELAY_MS,
  BRIDGE_MAX_BUSY_RETRIES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_READY_TIMEOUT_MS,
  BRIDGE_STATUS_TIMEOUT_MS,
  BRIDGE_VERSION,
  TEST_STATUS_TIMEOUT_MS,
} from "../config.js";
import { log } from "../logger.js";
import {
  triggerEditorRefreshOnly,
  unityIsRunning,
} from "../compile/applescript.js";
import { ensureBridgeInstalled, ensureGitExclude } from "./install.js";
import type { BridgeAction, BridgeRequest, BridgeResult } from "./types.js";
import type { TestDiscoveryFilters } from "./types.js";
import {
  bridgeReadyMatchesProject,
  generateRequestId,
  sleep,
  waitForBridgeReady,
  waitForBridgeStatus,
  writeBridgeRequest,
} from "./ipc.js";

/** Default timeout per action. */
function defaultTimeout(action: BridgeAction | "bootstrap_handshake"): number {
  if (action === "run_tests" || action === "list_tests") return TEST_STATUS_TIMEOUT_MS;
  return BRIDGE_STATUS_TIMEOUT_MS;
}

/** Reason string for request metadata. */
function reasonForAction(action: BridgeAction | "bootstrap_handshake"): string {
  if (action === "bootstrap_handshake") return "bridge bootstrap handshake";
  return `unity_${action} MCP tool`;
}

/**
 * Self-sufficient bridge IPC entry point.
 * Installs bridge, ensures readiness (bootstrapping if needed), sends request, polls for result.
 */
export async function sendBridgeRequest(
  projectPath: string,
  action: BridgeAction,
  opts?: {
    payload?: TestDiscoveryFilters;
    timeoutMs?: number;
  },
): Promise<BridgeResult> {
  // 1. Check Unity running
  if (!unityIsRunning(projectPath)) {
    return { ok: false, error: "unity_not_running", message: "Unity editor is not running." };
  }

  // 2. Install bridge + ensure git exclude + create IPC dir
  const paths = bridgePaths(projectPath);
  ensureBridgeInstalled(projectPath);
  ensureGitExclude(projectPath);
  fs.mkdirSync(paths.ipcDir, { recursive: true });

  // 3. Ensure bridge ready — bootstrap if needed
  if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) {
    log("Bridge not ready, starting bootstrap flow");
    triggerEditorRefreshOnly(projectPath);

    const ready = await waitForBridgeReady(paths.readyFile, projectPath, BRIDGE_READY_TIMEOUT_MS);
    if (!ready) {
      return { ok: false, error: "bridge_bootstrap_failed", message: "Bridge did not become ready after bootstrap refresh." };
    }

    // Send bootstrap handshake
    const handshakeResult = await sendRawRequest(projectPath, paths, "bootstrap_handshake");
    if (!handshakeResult.ok) return handshakeResult;

    log("Bridge bootstrap handshake succeeded");
  }

  // 4. Send the actual request
  return sendRawRequest(projectPath, paths, action, opts);
}

/**
 * Low-level: send a single bridge request and poll for status. Handles busy retries.
 * Used for both bootstrap_handshake (internal) and user-facing actions.
 */
async function sendRawRequest(
  projectPath: string,
  paths: ReturnType<typeof bridgePaths>,
  action: BridgeAction | "bootstrap_handshake",
  opts?: { payload?: TestDiscoveryFilters; timeoutMs?: number },
): Promise<BridgeResult> {
  const timeoutMs = opts?.timeoutMs ?? defaultTimeout(action);
  let attempt = 0;

  while (true) {
    const requestId = generateRequestId();
    const statusPath = paths.statusFile(requestId);

    try { fs.unlinkSync(statusPath); } catch { /* doesn't exist */ }

    const request: BridgeRequest = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId,
      requestedAtUnixMs: Date.now(),
      projectPath,
      action,
      reason: reasonForAction(action),
      source: "unity-mcp",
      payload: opts?.payload,
    };

    writeBridgeRequest(paths.requestFile, request);

    const status = await waitForBridgeStatus(statusPath, requestId, timeoutMs);

    if (!status) {
      return { ok: false, error: "request_timeout", message: `Timed out waiting for bridge response (${action}).` };
    }

    // Version mismatch — detect explicitly instead of masking as timeout
    if (
      status.bridgeVersion !== BRIDGE_VERSION ||
      status.protocolVersion !== BRIDGE_PROTOCOL_VERSION
    ) {
      return {
        ok: false,
        error: "version_mismatch",
        message: `Bridge version mismatch (got version=${status.bridgeVersion} protocol=${status.protocolVersion}).`,
      };
    }

    // Busy retry
    if (status.state === "busy" && attempt < BRIDGE_MAX_BUSY_RETRIES) {
      attempt++;
      log(`Bridge busy, retrying action=${action} attempt=${attempt}`);
      await sleep(BRIDGE_BUSY_RETRY_DELAY_MS);
      continue;
    }

    if (status.state === "busy") {
      return { ok: false, error: "bridge_busy", message: "Bridge is busy and retries exhausted." };
    }

    if (status.state === "bridge_error") {
      return { ok: false, error: "bridge_error", message: status.summary || "Bridge error." };
    }

    if (status.state === "failed") {
      return { ok: false, error: "compilation_failed", message: status.summary || "Compilation failed." };
    }

    return { ok: true, status };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: PASS

- [ ] **Step 5: Write test — bridge ready, successful request**

Add to `request.test.ts`:

```typescript
  it("sends request and returns ok when bridge is ready", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const { bridgeReadyMatchesProject, waitForBridgeStatus } = await import("../ipc.js");

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (waitForBridgeStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocolVersion: 1,
      bridgeVersion: "4",
      requestId: "test-req-001",
      projectPath: "/project",
      state: "list_tests_finished",
      isSuccess: true,
      didCompile: false,
      errors: [],
      summary: "",
      testList: { totalCount: 5, matchedCount: 5, tests: [] },
    });

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "list_tests");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status.state).toBe("list_tests_finished");
    }
  });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: PASS

- [ ] **Step 7: Write test — bridge not ready, triggers bootstrap**

Add to `request.test.ts`:

```typescript
  it("bootstraps when bridge is not ready", async () => {
    const { unityIsRunning, triggerEditorRefreshOnly } = await import("../../compile/applescript.js");
    const { bridgeReadyMatchesProject, waitForBridgeReady, waitForBridgeStatus } = await import("../ipc.js");

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (waitForBridgeReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    // First call = handshake, second call = actual request
    (waitForBridgeStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        protocolVersion: 1, bridgeVersion: "4", requestId: "test-req-001",
        projectPath: "/project", state: "completed", isSuccess: true,
        didCompile: false, errors: [], summary: "",
      })
      .mockResolvedValueOnce({
        protocolVersion: 1, bridgeVersion: "4", requestId: "test-req-001",
        projectPath: "/project", state: "completed", isSuccess: true,
        didCompile: true, errors: [], summary: "",
      });

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    expect(triggerEditorRefreshOnly).toHaveBeenCalledWith("/project");
    expect(waitForBridgeReady).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: PASS

- [ ] **Step 9: Write test — bootstrap fails (bridge never becomes ready)**

Add to `request.test.ts`:

```typescript
  it("returns bridge_bootstrap_failed when readiness times out", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const { bridgeReadyMatchesProject, waitForBridgeReady } = await import("../ipc.js");

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (waitForBridgeReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    expect(result).toEqual({
      ok: false,
      error: "bridge_bootstrap_failed",
      message: "Bridge did not become ready after bootstrap refresh.",
    });
  });
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: PASS

- [ ] **Step 11: Write test — request timeout**

Add to `request.test.ts`:

```typescript
  it("returns request_timeout when status poll times out", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const { bridgeReadyMatchesProject, waitForBridgeStatus } = await import("../ipc.js");

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (waitForBridgeStatus as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "run_tests");

    expect(result).toEqual({
      ok: false,
      error: "request_timeout",
      message: "Timed out waiting for bridge response (run_tests).",
    });
  });
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: PASS

- [ ] **Step 13: Write test — busy retry exhausted**

Add to `request.test.ts`:

```typescript
  it("retries on busy then returns bridge_busy if retries exhausted", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const { bridgeReadyMatchesProject, waitForBridgeStatus } = await import("../ipc.js");

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // BRIDGE_MAX_BUSY_RETRIES = 1, so 2 busy responses = exhausted
    const busyStatus = {
      protocolVersion: 1, bridgeVersion: "4", requestId: "test-req-001",
      projectPath: "/project", state: "busy" as const, isSuccess: false,
      didCompile: false, errors: [], summary: "Bridge is busy",
    };
    (waitForBridgeStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(busyStatus)
      .mockResolvedValueOnce(busyStatus);

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    expect(result).toEqual({
      ok: false,
      error: "bridge_busy",
      message: "Bridge is busy and retries exhausted.",
    });
  });
```

- [ ] **Step 14: Write test — version mismatch**

Add to `request.test.ts`:

```typescript
  it("returns version_mismatch when bridge version doesn't match", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const { bridgeReadyMatchesProject, waitForBridgeStatus } = await import("../ipc.js");

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (waitForBridgeStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocolVersion: 1, bridgeVersion: "99", requestId: "test-req-001",
      projectPath: "/project", state: "completed", isSuccess: true,
      didCompile: false, errors: [], summary: "",
    });

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    expect(result).toEqual({
      ok: false,
      error: "version_mismatch",
      message: "Bridge version mismatch (got version=99 protocol=1).",
    });
  });
```

- [ ] **Step 15: Run all tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run src/lib/bridge/__tests__/request.test.ts`
Expected: All PASS

- [ ] **Step 16: Commit**

```
git add plugins/unity-mcp/src/lib/bridge/request.ts plugins/unity-mcp/src/lib/bridge/__tests__/request.test.ts
git commit -m "feat: add sendBridgeRequest with tests"
```

---

### Task 3: Migrate `list-tests.ts`

**Files:**
- Modify: `plugins/unity-mcp/src/core/list-tests.ts`

This is the simplest migration — no recompile, just replace IPC boilerplate with `sendBridgeRequest`.

- [ ] **Step 1: Replace imports and boilerplate in `list-tests.ts`**

Replace the entire file with:

```typescript
import { sendBridgeRequest } from "../lib/bridge/request.js";
import type { TestDiscoveryFilters } from "../lib/bridge/types.js";
import type { Logger, ListTestsResult } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

export interface ListTestsOptions {
  projectPath: string;
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
  logger?: Logger;
}

export async function listTests(opts: ListTestsOptions): Promise<ListTestsResult> {
  const logger = opts.logger ?? noopLogger;
  const empty: ListTestsResult = { formatted: "", totalCount: 0, matchedCount: 0 };

  const payload: TestDiscoveryFilters = {};
  if (opts.categoryNames?.length) payload.categoryNames = opts.categoryNames;
  if (opts.groupNames?.length) payload.groupNames = opts.groupNames;
  if (opts.assemblyNames?.length) payload.assemblyNames = opts.assemblyNames;

  const result = await sendBridgeRequest(opts.projectPath, "list_tests", { payload });
  if (!result.ok) {
    return { ...empty, formatted: result.message };
  }

  const { status } = result;
  logger.log("list_tests request completed");

  if (!status.testList) {
    return { ...empty, formatted: "Bridge returned no test list." };
  }

  const { totalCount, matchedCount, tests } = status.testList;

  return {
    formatted: formatTestList(tests, totalCount, matchedCount, payload),
    totalCount,
    matchedCount,
  };
}

function formatTestList(
  tests: { fullName: string; name: string; categories: string[]; assembly: string }[],
  totalCount: number,
  matchedCount: number,
  filters: TestDiscoveryFilters,
): string {
  if (totalCount === 0) {
    return "No EditMode tests found.";
  }

  const hasFilters = !!(filters.categoryNames?.length || filters.groupNames?.length || filters.assemblyNames?.length);

  if (matchedCount === 0 && hasFilters) {
    return `No EditMode tests matched the filter (${totalCount} total).`;
  }

  const lines: string[] = [];

  if (hasFilters) {
    const filterParts: string[] = [];
    if (filters.categoryNames?.length) filterParts.push(`categoryNames=${JSON.stringify(filters.categoryNames)}`);
    if (filters.groupNames?.length) filterParts.push(`groupNames=${JSON.stringify(filters.groupNames)}`);
    if (filters.assemblyNames?.length) filterParts.push(`assemblyNames=${JSON.stringify(filters.assemblyNames)}`);
    lines.push(`Matched ${matchedCount} of ${totalCount} EditMode tests (filter: ${filterParts.join(", ")}):`);
  } else {
    lines.push(`Available EditMode tests (${totalCount} total):`);
  }

  const byAssembly = new Map<string, typeof tests>();
  for (const test of tests) {
    const group = byAssembly.get(test.assembly) ?? [];
    group.push(test);
    byAssembly.set(test.assembly, group);
  }

  for (const [assembly, assemblyTests] of byAssembly) {
    lines.push("");
    lines.push(`  ${assembly}`);
    for (const t of assemblyTests) {
      const cats = t.categories.length > 0 ? ` [${t.categories.join(", ")}]` : "";
      lines.push(`    ${t.fullName}${cats}`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All PASS

- [ ] **Step 4: Commit**

```
git add plugins/unity-mcp/src/core/list-tests.ts
git commit -m "refactor: migrate list-tests to sendBridgeRequest"
```

---

### Task 4: Migrate `recompile.ts`

**Files:**
- Modify: `plugins/unity-mcp/src/core/recompile.ts`

Key points from the spec:
- `recompile()` still calls `ensureBridgeInstalled()` directly for its return value (change detection)
- Uses `sendBridgeRequest("recompile")` when Unity is running
- Falls back to CLI when Unity is not running (unchanged)
- `bridgeChangedThisRun` flag eliminated — `sendBridgeRequest` handles readiness check internally

- [ ] **Step 1: Rewrite `recompile.ts`**

Replace the entire file with:

```typescript
import fs from "node:fs";
import { MARKER_DIR } from "../lib/config.js";
import {
  ensureMarker,
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "../lib/project/changes.js";
import { ensureBridgeInstalled, ensureGitExclude } from "../lib/bridge/install.js";
import { unityIsRunning } from "../lib/compile/applescript.js";
import { runCliFallback } from "../lib/compile/cli-fallback.js";
import { sendBridgeRequest } from "../lib/bridge/request.js";
import { parseBridgeStatusToResult } from "../lib/bridge/ipc.js";
import type { Logger, RecompileResult, CompilationError } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

/**
 * Trigger Unity recompilation for a project.
 * Internalizes the full pipeline: change detection -> bridge install -> compile -> marker touch.
 */
export async function recompile(
  projectPath: string,
  logger: Logger = noopLogger,
): Promise<RecompileResult> {
  // 1. Change detection
  fs.mkdirSync(MARKER_DIR, { recursive: true });
  const markerPath = getMarkerPath(projectPath, "recompile");
  ensureMarker(markerPath);

  // 2. Bridge install — called for return value (idempotent, sendBridgeRequest also calls internally)
  const { changed: bridgeChangedThisRun } = ensureBridgeInstalled(projectPath);
  ensureGitExclude(projectPath);

  const csChanged = hasChangedCsFiles(projectPath, markerPath);
  if (!csChanged && !bridgeChangedThisRun) {
    logger.log("No .cs files changed since last check");
    return { success: true, skipped: true, errors: [] };
  }
  logger.log(bridgeChangedThisRun ? "Bridge updated, triggering recompilation" : "C# files changed, triggering recompilation");

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

  // 4. Touch marker when recompilation was attempted
  if (success || didCompile) {
    touchMarker(markerPath);
    logger.log("Marker file updated");
  }

  // 5. Convert string errors to structured CompilationError
  const errors: CompilationError[] = compileErrors.map((errStr) => {
    const match = errStr.match(/^(.+)\((\d+),(\d+)\):\s*(.+)$/);
    if (match) {
      return {
        assembly: "",
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        message: errStr,
        type: "error",
      };
    }
    return { assembly: "", file: "", line: 0, column: 0, message: errStr, type: "error" };
  });

  return { success, skipped: false, errors };
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All PASS

- [ ] **Step 4: Commit**

```
git add plugins/unity-mcp/src/core/recompile.ts
git commit -m "refactor: migrate recompile to sendBridgeRequest"
```

---

### Task 5: Migrate `test.ts` — add recompile + sendBridgeRequest

**Files:**
- Modify: `plugins/unity-mcp/src/core/test.ts`

Behavioral change: adds `recompile()` call before running tests to ensure tests run against latest compiled code.

- [ ] **Step 1: Rewrite `test.ts`**

Replace the entire file with:

```typescript
import { sendBridgeRequest } from "../lib/bridge/request.js";
import { saveTestRun } from "../lib/test-store.js";
import { getTestResults } from "./test-results.js";
import { getMarkerPath, ensureMarker, touchMarker } from "../lib/project/changes.js";
import { recompile } from "./recompile.js";
import type { TestDiscoveryFilters } from "../lib/bridge/types.js";
import type { Logger, RunTestsResult } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

export interface RunTestsOptions {
  projectPath: string;
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
  verbose?: boolean;
  logger?: Logger;
  storeDir?: string;
  markerDir?: string;
}

export async function runTests(opts: RunTestsOptions): Promise<RunTestsResult> {
  const logger = opts.logger ?? noopLogger;
  const projectPath = opts.projectPath;

  // Recompile first to ensure tests run against latest code
  const compileResult = await recompile(projectPath, logger);
  if (!compileResult.success && !compileResult.skipped) {
    const errorMsg = compileResult.errors.map((e) => e.message).join("\n");
    return { runId: "", formatted: "Recompilation failed before test run:\n" + errorMsg };
  }

  // Build payload
  const payload: TestDiscoveryFilters = {};
  if (opts.categoryNames?.length) payload.categoryNames = opts.categoryNames;
  if (opts.groupNames?.length) payload.groupNames = opts.groupNames;
  if (opts.assemblyNames?.length) payload.assemblyNames = opts.assemblyNames;

  // Send test request
  const result = await sendBridgeRequest(projectPath, "run_tests", { payload });
  if (!result.ok) {
    return { runId: "", formatted: result.message };
  }

  const { status } = result;

  if (!status.testResults) {
    return { runId: "", formatted: "Bridge returned no test results." };
  }

  // Store results
  const runId = "test-" + Date.now();
  const storedRun = {
    runId,
    timestamp: new Date().toISOString(),
    projectPath,
    filters: payload,
    results: status.testResults,
  };
  saveTestRun(storedRun, opts.storeDir);

  // Touch marker
  const markerPath = getMarkerPath(projectPath, "test-run", opts.markerDir);
  ensureMarker(markerPath);
  touchMarker(markerPath);

  // Format and return
  const view = getTestResults({
    projectPath,
    runId,
    verbose: opts.verbose,
    storeDir: opts.storeDir,
    markerDir: opts.markerDir,
  });

  return { runId, formatted: view.formatted };
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All PASS

- [ ] **Step 4: Commit**

```
git add plugins/unity-mcp/src/core/test.ts
git commit -m "feat: migrate test.ts to sendBridgeRequest, add recompile before tests"
```

---

### Task 6: Migrate `lint.ts` — add recompile before lint

**Files:**
- Modify: `plugins/unity-mcp/src/core/lint.ts:182-185`

Behavioral change: adds `recompile()` call before linting.

- [ ] **Step 1: Add recompile import and call**

Add import at the top of `lint.ts` (after existing imports):

```typescript
import { recompile } from "./recompile.js";
```

Add recompile call at the beginning of the `lint` function body (after `const bufferLines = ...` on line 187):

```typescript
  // Recompile first to ensure consistent state
  const compileResult = await recompile(projectPath, logger);
  if (!compileResult.success && !compileResult.skipped) {
    logger.error("Recompilation failed before lint");
    return { filesLinted: 0, success: false };
  }
```

- [ ] **Step 2: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All PASS

- [ ] **Step 4: Commit**

```
git add plugins/unity-mcp/src/core/lint.ts
git commit -m "feat: add recompile before lint execution"
```

---

### Task 7: Delete `orchestrate.ts` and remove dead imports

**Files:**
- Delete: `plugins/unity-mcp/src/lib/bridge/orchestrate.ts`
- Verify: no remaining imports of `orchestrate.ts` anywhere

- [ ] **Step 1: Verify no remaining imports**

Run: `grep -r "orchestrate" plugins/unity-mcp/src/`
Expected: No matches (all callers migrated in previous tasks)

- [ ] **Step 2: Delete `orchestrate.ts`**

```bash
rm plugins/unity-mcp/src/lib/bridge/orchestrate.ts
```

- [ ] **Step 3: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add -u plugins/unity-mcp/src/lib/bridge/orchestrate.ts
git commit -m "refactor: delete orchestrate.ts, logic absorbed into request.ts"
```

---

### Task 8: Build and verify

**Files:**
- Verify: `plugins/unity-mcp/dist/server.mjs` regenerated

- [ ] **Step 1: Run full build**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds

- [ ] **Step 2: Run all tests one final time**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All PASS

- [ ] **Step 3: Commit built output**

```
git add plugins/unity-mcp/dist/
git commit -m "build: regenerate server.mjs with bridge-aware IPC layer"
```
