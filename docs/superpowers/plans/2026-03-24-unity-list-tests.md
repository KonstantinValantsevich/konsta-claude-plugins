# Unity List Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `unity_list_tests` MCP tool that discovers available tests via the Unity bridge, with shared type-safe filtering.

**Architecture:** New bridge action `list_tests` in C#, new `src/core/list-tests.ts` module, type-level enforcement via `TestDiscoveryFilters` / `TestResultFilters` split. The C# side reuses `WriteStatus` with `testResults` string field; TS-side routes parsed JSON to `testList` based on state.

**Tech Stack:** TypeScript, Vitest, C# (Unity Editor scripts), MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-24-unity-list-tests-design.md`

**Build:** `npm --prefix plugins/unity-mcp run build`
**Test:** `npx --prefix plugins/unity-mcp vitest run`
**Never use `cd`** — use `--prefix` or absolute paths.

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `plugins/unity-mcp/src/core/list-tests.ts` | Core list-tests logic: bridge request, poll, format |
| `plugins/unity-mcp/__tests__/core/list-tests.test.ts` | Unit tests for list-tests |

### Modified files
| File | Changes |
|------|---------|
| `plugins/unity-mcp/src/lib/bridge/types.ts` | Add `TestDiscoveryFilters`, `TestResultFilters`, `TestListEntry`, `TestListResult`; rename `TestRunPayload`; extend action/state unions; add `testList` to `BridgeStatus` |
| `plugins/unity-mcp/src/lib/bridge/ipc.ts` | Add `list_tests_finished` to `TERMINAL_STATES`; update `readBridgeStatus` to route parsed JSON to `testList` when state is `list_tests_finished` |
| `plugins/unity-mcp/src/core/types.ts` | Add `ListTestsResult` type |
| `plugins/unity-mcp/src/core/test.ts` | Update imports: `TestRunPayload` → `TestDiscoveryFilters` |
| `plugins/unity-mcp/src/core/test-results.ts` | No code changes needed (already uses inline types) |
| `plugins/unity-mcp/src/mcp/server.ts` | Add `unity_list_tests` tool registration |
| `plugins/unity-mcp/templates/ClaudeTestHandler.cs` | Extract `BuildFilter`, add `HandleListTests`, `CollectLeafTests`, `FilterTestEntries`, register `list_tests` |
| `plugins/unity-mcp/__tests__/lib/bridge/ipc.test.ts` | Add test for `readBridgeStatus` routing `testList` |
| `plugins/unity-mcp/__tests__/mcp/server.test.ts` | Update tool count from 5 to 6 |

---

## Task 1: Type definitions — `TestDiscoveryFilters`, `TestResultFilters`, and list types

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/types.ts`
- Modify: `plugins/unity-mcp/src/core/types.ts`

- [ ] **Step 1: Add new types and rename `TestRunPayload` in `types.ts`**

In `plugins/unity-mcp/src/lib/bridge/types.ts`:

1. Rename `TestRunPayload` to `TestDiscoveryFilters` (same shape):
```typescript
/** Filters for test discovery/execution — only flow into bridge requests */
export interface TestDiscoveryFilters {
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
}

/** Filters for post-hoc result viewing — only used on stored results */
export interface TestResultFilters {
  statusFilter?: "passed" | "failed" | "skipped";
  nameFilter?: string;
}
```

2. Also export `TestRunPayload` as a type alias for backward compatibility during the transition:
```typescript
/** @deprecated Use TestDiscoveryFilters */
export type TestRunPayload = TestDiscoveryFilters;
```

3. Update `BridgeRequest.payload` type from `TestRunPayload` to `TestDiscoveryFilters`.

4. Add `"list_tests"` to `BridgeRequest.action` union:
```typescript
action: "recompile" | "bootstrap_handshake" | "run_tests" | "list_tests";
```

5. Add `"list_tests_finished"` to `BridgeStatus.state` union:
```typescript
| "tests_finished"
| "list_tests_finished";
```

6. Add new types and field to `BridgeStatus`:
```typescript
export interface TestListEntry {
  fullName: string;
  name: string;
  categories: string[];
  assembly: string;
}

export interface TestListResult {
  totalCount: number;
  matchedCount: number;
  tests: TestListEntry[];
}

// Add to BridgeStatus interface:
testList?: TestListResult;
```

In `plugins/unity-mcp/src/core/types.ts`, add:
```typescript
export interface ListTestsResult {
  formatted: string;
  totalCount: number;
  matchedCount: number;
}
```

- [ ] **Step 2: Update imports in `test.ts`**

In `plugins/unity-mcp/src/core/test.ts`, update:
```typescript
// Change:
import type { BridgeRequest, TestRunPayload } from "../lib/bridge/types.js";
// To:
import type { BridgeRequest, TestDiscoveryFilters } from "../lib/bridge/types.js";
```

And update the `payload` variable type:
```typescript
// Change:
const payload: TestRunPayload = {};
// To:
const payload: TestDiscoveryFilters = {};
```

- [ ] **Step 3: Run tests to verify no regressions**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All existing tests pass — this is a rename with backward-compat alias.

- [ ] **Step 4: Commit**

```
git add plugins/unity-mcp/src/lib/bridge/types.ts plugins/unity-mcp/src/core/types.ts plugins/unity-mcp/src/core/test.ts
git commit -m "refactor: introduce TestDiscoveryFilters/TestResultFilters type split" -m "Rename TestRunPayload to TestDiscoveryFilters, add TestResultFilters," -m "TestListEntry, TestListResult types. Add list_tests action and" -m "list_tests_finished state to bridge protocol types." -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Update `readBridgeStatus` and `TERMINAL_STATES` in `ipc.ts`

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/ipc.ts`
- Modify: `plugins/unity-mcp/__tests__/lib/bridge/ipc.test.ts`

- [ ] **Step 1: Write the failing test for `readBridgeStatus` testList routing**

Add to `plugins/unity-mcp/__tests__/lib/bridge/ipc.test.ts`, inside the `readBridgeStatus` describe block:

```typescript
it("routes testResults to testList when state is list_tests_finished", () => {
  const statusPath = path.join(tmpDir, "status-list.json");
  const testListPayload = {
    totalCount: 3,
    matchedCount: 2,
    tests: [
      { fullName: "NS.Test1", name: "Test1", categories: ["Cat1"], assembly: "Asm" },
      { fullName: "NS.Test2", name: "Test2", categories: [], assembly: "Asm" },
    ],
  };
  const raw = {
    protocolVersion: 1,
    requestId: "test-list-123",
    bridgeVersion: "4",
    projectPath: "/test",
    state: "list_tests_finished",
    createdAtUnixMs: Date.now(),
    updatedAtUnixMs: Date.now(),
    didCompile: false,
    isSuccess: true,
    errors: [],
    summary: "2 test(s) matched",
    testResults: JSON.stringify(testListPayload),
  };
  fs.writeFileSync(statusPath, JSON.stringify(raw));
  const status = readBridgeStatus(statusPath);
  expect(status!.testList).toEqual(testListPayload);
  expect(status!.testResults).toBeUndefined();
});

it("routes testResults normally for tests_finished state", () => {
  const statusPath = path.join(tmpDir, "status-run.json");
  const testResultsPayload = {
    totalCount: 1, passCount: 1, failCount: 0, skipCount: 0,
    inconclusiveCount: 0, duration: 0.5,
    tests: [{ fullName: "NS.T1", name: "T1", status: "Passed", duration: 0.5, message: null, stackTrace: null, output: null }],
  };
  const raw = {
    protocolVersion: 1,
    requestId: "test-run-456",
    bridgeVersion: "4",
    projectPath: "/test",
    state: "tests_finished",
    createdAtUnixMs: Date.now(),
    updatedAtUnixMs: Date.now(),
    didCompile: false,
    isSuccess: true,
    errors: [],
    summary: "All passed",
    testResults: JSON.stringify(testResultsPayload),
  };
  fs.writeFileSync(statusPath, JSON.stringify(raw));
  const status = readBridgeStatus(statusPath);
  expect(status!.testResults).toEqual(testResultsPayload);
  expect(status!.testList).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/lib/bridge/ipc.test.ts`
Expected: The first new test fails (testList is undefined, testResults has the parsed object).

- [ ] **Step 3: Implement the ipc.ts changes**

In `plugins/unity-mcp/src/lib/bridge/ipc.ts`:

1. Add `"list_tests_finished"` to `TERMINAL_STATES`:
```typescript
const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "bridge_error",
  "busy",
  "timeout",
  "tests_finished",
  "list_tests_finished",
]);
```

2. Update the `readBridgeStatus` function's testResults parsing block:
```typescript
if (typeof raw.testResults === "string" && raw.testResults) {
  try {
    const parsed = JSON.parse(raw.testResults as string);
    if (raw.state === "list_tests_finished") {
      raw.testList = parsed;
      delete raw.testResults;
    } else {
      raw.testResults = parsed;
    }
  } catch {
    // Leave as-is if parsing fails
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/lib/bridge/ipc.test.ts`
Expected: All tests pass including the two new ones.

- [ ] **Step 5: Run full test suite**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add plugins/unity-mcp/src/lib/bridge/ipc.ts plugins/unity-mcp/__tests__/lib/bridge/ipc.test.ts
git commit -m "feat: add list_tests_finished to TERMINAL_STATES and route testList in readBridgeStatus" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Core `listTests` module

**Files:**
- Create: `plugins/unity-mcp/src/core/list-tests.ts`
- Create: `plugins/unity-mcp/__tests__/core/list-tests.test.ts`

- [ ] **Step 1: Write the test file**

Create `plugins/unity-mcp/__tests__/core/list-tests.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/lib/bridge/ipc.js", () => ({
  generateRequestId: () => "mock-list-req-id",
  writeBridgeRequest: vi.fn(),
  waitForBridgeStatus: vi.fn(),
  sleep: vi.fn(),
  bridgeReadyMatchesProject: vi.fn(() => true),
  readBridgeStatus: vi.fn(),
}));

vi.mock("../../src/lib/compile/applescript.js", () => ({
  unityIsRunning: vi.fn(() => true),
}));

import { listTests } from "../../src/core/list-tests.js";
import { waitForBridgeStatus } from "../../src/lib/bridge/ipc.js";
import { unityIsRunning } from "../../src/lib/compile/applescript.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

describe("listTests", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-tests-proj-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "Library", "ClaudeHookIPC"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns error when Unity is not running", async () => {
    vi.mocked(unityIsRunning).mockReturnValue(false);
    const result = await listTests({ projectPath: projectDir });
    expect(result.formatted).toContain("Unity editor must be running");
    expect(result.totalCount).toBe(0);
    expect(result.matchedCount).toBe(0);
  });

  it("returns error on timeout", async () => {
    vi.mocked(waitForBridgeStatus).mockResolvedValue(null);
    const result = await listTests({ projectPath: projectDir });
    expect(result.formatted).toContain("Timed out");
  });

  it("returns error on bridge failure", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-list-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "failed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: false,
      errors: [],
      summary: "Something broke",
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);
    const result = await listTests({ projectPath: projectDir });
    expect(result.formatted).toContain("Something broke");
  });

  it("formats unfiltered test list grouped by assembly", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-list-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "list_tests_finished",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "3 test(s) matched out of 3 total",
      testList: {
        totalCount: 3,
        matchedCount: 3,
        tests: [
          { fullName: "NS.FixtureA.Test1", name: "Test1", categories: ["CatA"], assembly: "Assembly.Tests" },
          { fullName: "NS.FixtureA.Test2", name: "Test2", categories: ["CatA", "CatB"], assembly: "Assembly.Tests" },
          { fullName: "Other.FixtureB.Test3", name: "Test3", categories: [], assembly: "Other.Tests" },
        ],
      },
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await listTests({ projectPath: projectDir });
    expect(result.totalCount).toBe(3);
    expect(result.matchedCount).toBe(3);
    expect(result.formatted).toContain("Available EditMode tests (3 total)");
    expect(result.formatted).toContain("Assembly.Tests");
    expect(result.formatted).toContain("NS.FixtureA.Test1 [CatA]");
    expect(result.formatted).toContain("NS.FixtureA.Test2 [CatA, CatB]");
    expect(result.formatted).toContain("Other.Tests");
    expect(result.formatted).toContain("Other.FixtureB.Test3");
    // Test3 has no categories — no brackets
    expect(result.formatted).not.toContain("Test3 [");
  });

  it("formats filtered test list with filter description", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-list-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "list_tests_finished",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "2 test(s) matched out of 5 total",
      testList: {
        totalCount: 5,
        matchedCount: 2,
        tests: [
          { fullName: "NS.FixtureA.Test1", name: "Test1", categories: ["CatA"], assembly: "Assembly.Tests" },
          { fullName: "NS.FixtureA.Test2", name: "Test2", categories: ["CatA"], assembly: "Assembly.Tests" },
        ],
      },
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await listTests({ projectPath: projectDir, categoryNames: ["CatA"] });
    expect(result.totalCount).toBe(5);
    expect(result.matchedCount).toBe(2);
    expect(result.formatted).toContain("Matched 2 of 5 EditMode tests");
    expect(result.formatted).toContain("categoryNames");
  });

  it("returns empty list message when no tests found", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-list-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "list_tests_finished",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "0 test(s) matched out of 0 total",
      testList: { totalCount: 0, matchedCount: 0, tests: [] },
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await listTests({ projectPath: projectDir });
    expect(result.formatted).toContain("No EditMode tests found");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/list-tests.test.ts`
Expected: FAIL — `list-tests.js` module does not exist.

- [ ] **Step 3: Implement `list-tests.ts`**

Create `plugins/unity-mcp/src/core/list-tests.ts`:

```typescript
import fs from "node:fs";
import {
  bridgePaths,
  BRIDGE_PROTOCOL_VERSION,
  TEST_STATUS_TIMEOUT_MS,
} from "../lib/config.js";
import {
  generateRequestId,
  writeBridgeRequest,
  waitForBridgeStatus,
  bridgeReadyMatchesProject,
} from "../lib/bridge/ipc.js";
import { unityIsRunning } from "../lib/compile/applescript.js";
import type { BridgeRequest, TestDiscoveryFilters } from "../lib/bridge/types.js";
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
  const projectPath = opts.projectPath;
  const empty: ListTestsResult = { formatted: "", totalCount: 0, matchedCount: 0 };

  // Check Unity is running
  if (!unityIsRunning(projectPath)) {
    return { ...empty, formatted: "Unity editor must be running to list tests." };
  }

  // Check bridge ready
  const paths = bridgePaths(projectPath);
  if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) {
    return { ...empty, formatted: "Bridge is not ready. Run unity_recompile first to initialize the bridge." };
  }

  // Build request
  const requestId = generateRequestId();
  const statusPath = paths.statusFile(requestId);

  try { fs.unlinkSync(statusPath); } catch { /* doesn't exist */ }

  const payload: TestDiscoveryFilters = {};
  if (opts.categoryNames?.length) payload.categoryNames = opts.categoryNames;
  if (opts.groupNames?.length) payload.groupNames = opts.groupNames;
  if (opts.assemblyNames?.length) payload.assemblyNames = opts.assemblyNames;

  const request: BridgeRequest = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    requestedAtUnixMs: Date.now(),
    projectPath,
    action: "list_tests",
    reason: "unity_list_tests MCP tool",
    source: "unity-mcp",
    payload,
  };

  fs.mkdirSync(paths.ipcDir, { recursive: true });
  writeBridgeRequest(paths.requestFile, request);
  logger.log("Sent list_tests request: " + requestId);

  // Poll for status
  const status = await waitForBridgeStatus(statusPath, requestId, TEST_STATUS_TIMEOUT_MS);
  if (!status) {
    return { ...empty, formatted: "Timed out waiting for test list (300s)." };
  }

  if (status.state === "failed" || status.state === "bridge_error") {
    return { ...empty, formatted: "List tests failed: " + (status.summary || "unknown error") };
  }

  if (!status.testList) {
    return { ...empty, formatted: "Bridge returned no test list." };
  }

  const { totalCount, matchedCount, tests } = status.testList;

  // Format output
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

  // Group by assembly
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/list-tests.test.ts`
Expected: All 6 tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add plugins/unity-mcp/src/core/list-tests.ts plugins/unity-mcp/__tests__/core/list-tests.test.ts
git commit -m "feat: add listTests core module with bridge request and formatting" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: MCP tool registration

**Files:**
- Modify: `plugins/unity-mcp/src/mcp/server.ts`
- Modify: `plugins/unity-mcp/__tests__/mcp/server.test.ts`

- [ ] **Step 1: Update the server test to expect 6 tools**

In `plugins/unity-mcp/__tests__/mcp/server.test.ts`:

Change the test description and assertion:
```typescript
it("registers all 6 tools", async () => {
```

Update the expected names array:
```typescript
expect(names).toEqual([
  "unity_lint",
  "unity_list_tests",
  "unity_recompile",
  "unity_run_tests",
  "unity_status",
  "unity_test_results",
]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/mcp/server.test.ts`
Expected: FAIL — only 5 tools registered, `unity_list_tests` missing.

- [ ] **Step 3: Add tool registration in `server.ts`**

In `plugins/unity-mcp/src/mcp/server.ts`:

1. Add import at top:
```typescript
import { listTests } from "../core/list-tests.js";
```

2. Add tool registration after the `unity_run_tests` tool block (before `unity_test_results`):
```typescript
server.tool(
  "unity_list_tests",
  "List available Unity EditMode tests. Returns test names, categories, and assemblies. Supports filtering by category, class/namespace (regex), and assembly — use to preview which tests a filter matches before running.",
  {
    projectPath: z.string().describe("Unity project root path"),
    categoryNames: z.array(z.string()).optional().describe("NUnit [Category] tags to filter by"),
    groupNames: z.array(z.string()).optional().describe("Regex patterns for namespace/class/test name filtering"),
    assemblyNames: z.array(z.string()).optional().describe("Assembly names to filter (without .dll)"),
  },
  async ({ projectPath, categoryNames, groupNames, assemblyNames }) => {
    const result = await listTests({ projectPath, categoryNames, groupNames, assemblyNames, logger: stderrLogger });
    return {
      content: [{ type: "text" as const, text: result.formatted }],
    };
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/mcp/server.test.ts`
Expected: PASS — 6 tools registered.

- [ ] **Step 5: Run full test suite**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add plugins/unity-mcp/src/mcp/server.ts plugins/unity-mcp/__tests__/mcp/server.test.ts
git commit -m "feat: register unity_list_tests MCP tool" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: C# bridge — `BuildFilter` extraction and `list_tests` handler

**Files:**
- Modify: `plugins/unity-mcp/templates/ClaudeTestHandler.cs`

- [ ] **Step 1: Extract `BuildFilter` as a shared static method**

In `plugins/unity-mcp/templates/ClaudeTestHandler.cs`:

1. Update the version comment on line 1 to `// ClaudeTestHandler Version: 5`

2. Add shared `BuildFilter` method:
```csharp
private static Filter BuildFilter(TestRunPayload filters)
{
    var filter = new Filter { testMode = TestMode.EditMode };
    if (filters != null)
    {
        if (filters.categoryNames != null && filters.categoryNames.Length > 0)
            filter.categoryNames = filters.categoryNames;
        if (filters.groupNames != null && filters.groupNames.Length > 0)
            filter.groupNames = filters.groupNames;
        if (filters.assemblyNames != null && filters.assemblyNames.Length > 0)
            filter.assemblyNames = filters.assemblyNames;
    }
    return filter;
}
```

3. Refactor `HandleRunTests` to use `BuildFilter`:
Replace the existing filter construction block (lines 102-115) with:
```csharp
var filter = BuildFilter(filters);
```

- [ ] **Step 2: Add `list_tests` registration in `Register()`**

Update the existing `Register()` method:
```csharp
internal static void Register()
{
    ClaudeBridgeBase.RegisterAction("run_tests", HandleRunTests);
    ClaudeBridgeBase.RegisterAction("list_tests", HandleListTests);
}
```

- [ ] **Step 3: Add serialization classes for list response**

Add inside `ClaudeTestHandler`:
```csharp
[Serializable]
private class TestListEntry
{
    public string fullName;
    public string name;
    public string[] categories;
    public string assembly;
}

[Serializable]
private class TestListPayload
{
    public int totalCount;
    public int matchedCount;
    public List<TestListEntry> tests;
}
```

- [ ] **Step 4: Add `CollectLeafTests` helper**

```csharp
private static void CollectLeafTests(ITestAdaptor node, List<TestListEntry> results, string currentAssembly = null)
{
    // Top-level suite name is the assembly name
    if (node.IsSuite && node.Parent == null && node.Children != null)
    {
        foreach (var child in node.Children)
        {
            CollectLeafTests(child, results, child.IsSuite ? child.Name : currentAssembly);
        }
        return;
    }

    if (node.IsSuite && node.Children != null)
    {
        string assembly = currentAssembly ?? node.Name;
        foreach (var child in node.Children)
        {
            CollectLeafTests(child, results, assembly);
        }
        return;
    }

    if (!node.IsSuite)
    {
        var categories = new List<string>();
        if (node.Categories != null)
        {
            foreach (var cat in node.Categories)
                categories.Add(cat);
        }

        results.Add(new TestListEntry
        {
            fullName = node.FullName ?? string.Empty,
            name = node.Name ?? string.Empty,
            categories = categories.ToArray(),
            assembly = currentAssembly ?? string.Empty,
        });
    }
}
```

- [ ] **Step 5: Add `FilterTestEntries` helper**

```csharp
private static List<TestListEntry> FilterTestEntries(List<TestListEntry> tests, TestRunPayload filters)
{
    if (filters == null)
        return new List<TestListEntry>(tests);

    var result = new List<TestListEntry>();
    foreach (var test in tests)
    {
        bool match = true;

        // categoryNames: OR — test has at least one matching category
        if (filters.categoryNames != null && filters.categoryNames.Length > 0)
        {
            bool catMatch = false;
            if (test.categories != null)
            {
                foreach (var cat in test.categories)
                {
                    foreach (var filterCat in filters.categoryNames)
                    {
                        if (string.Equals(cat, filterCat, StringComparison.Ordinal))
                        {
                            catMatch = true;
                            break;
                        }
                    }
                    if (catMatch) break;
                }
            }
            if (!catMatch) match = false;
        }

        // groupNames: OR — fullName matches at least one regex
        if (match && filters.groupNames != null && filters.groupNames.Length > 0)
        {
            bool groupMatch = false;
            foreach (var pattern in filters.groupNames)
            {
                try
                {
                    if (System.Text.RegularExpressions.Regex.IsMatch(test.fullName, pattern))
                    {
                        groupMatch = true;
                        break;
                    }
                }
                catch (Exception) { /* invalid regex — skip */ }
            }
            if (!groupMatch) match = false;
        }

        // assemblyNames: OR — test assembly is in list
        if (match && filters.assemblyNames != null && filters.assemblyNames.Length > 0)
        {
            bool asmMatch = false;
            foreach (var asm in filters.assemblyNames)
            {
                if (string.Equals(test.assembly, asm, StringComparison.Ordinal))
                {
                    asmMatch = true;
                    break;
                }
            }
            if (!asmMatch) match = false;
        }

        if (match) result.Add(test);
    }

    return result;
}
```

- [ ] **Step 6: Add `HandleListTests` handler**

```csharp
private static void HandleListTests(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
{
    ClaudeBridgeBase.MarkBusy(request.requestId);
    try
    {
        TestRunPayload filters = null;
        if (!string.IsNullOrEmpty(request.payload))
            filters = JsonUtility.FromJson<TestRunPayload>(request.payload);

        var api = ScriptableObject.CreateInstance<TestRunnerApi>();
        api.RetrieveTestList(TestMode.EditMode, (testRoot) =>
        {
            var allTests = new List<TestListEntry>();
            CollectLeafTests(testRoot, allTests);

            var matched = FilterTestEntries(allTests, filters);

            var payload = new TestListPayload
            {
                totalCount = allTests.Count,
                matchedCount = matched.Count,
                tests = matched,
            };

            ClaudeBridgeBase.WriteStatus(
                request, "list_tests_finished", false, true,
                matched.Count + " test(s) matched out of " + allTests.Count + " total",
                null,
                JsonUtility.ToJson(payload, true)
            );
            ClaudeBridgeBase.FinalizeRequest(request);
        });
    }
    catch (Exception ex)
    {
        ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "List tests failed: " + ex.Message);
        ClaudeBridgeBase.FinalizeRequest(request);
    }
}
```

- [ ] **Step 7: Add `using System.Text.RegularExpressions;` if not present**

Check if `using System.Text.RegularExpressions;` is at the top of the file. If not, add it (needed by `FilterTestEntries`). Actually, the `Regex.IsMatch` call uses the fully qualified name `System.Text.RegularExpressions.Regex.IsMatch`, so no extra using is needed. Verify the code compiles correctly via the existing approach (the C# templates are installed by the bridge installer — can't unit-test directly, but verify syntax is correct).

- [ ] **Step 8: Commit**

```
git add plugins/unity-mcp/templates/ClaudeTestHandler.cs
git commit -m "feat: add list_tests C# handler with BuildFilter, CollectLeafTests, FilterTestEntries" -m "Extract shared BuildFilter from HandleRunTests. Add HandleListTests that" -m "enumerates tests via RetrieveTestList and applies manual filtering." -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Build and final verification

**Files:**
- None new — build output only

- [ ] **Step 1: Run full test suite**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests pass.

- [ ] **Step 2: Build the MCP server bundle**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: `dist/server.mjs` regenerated successfully.

- [ ] **Step 3: Commit the build output**

```
git add plugins/unity-mcp/dist/server.mjs
git commit -m "build: regenerate dist/server.mjs with unity_list_tests tool" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Remove deprecated TestRunPayload alias**

After verifying everything works, check if `TestRunPayload` is still referenced anywhere outside of the C# template:

Run: `grep -r "TestRunPayload" plugins/unity-mcp/src/`

If nothing references it, remove the deprecated alias from `plugins/unity-mcp/src/lib/bridge/types.ts`:
```typescript
// Remove this line:
export type TestRunPayload = TestDiscoveryFilters;
```

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests pass.

If tests fail because something still imports `TestRunPayload`, update those imports instead.

- [ ] **Step 5: Rebuild and commit cleanup**

Run: `npm --prefix plugins/unity-mcp run build`

```
git add plugins/unity-mcp/src/lib/bridge/types.ts plugins/unity-mcp/dist/server.mjs
git commit -m "refactor: remove deprecated TestRunPayload alias" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
