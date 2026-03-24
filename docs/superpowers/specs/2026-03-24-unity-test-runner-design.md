# Unity Test Runner MCP Tool — Design Spec

**Date:** 2026-03-24
**Status:** Draft

## Overview

Add two new MCP tools (`unity_run_tests`, `unity_test_results`) to run Unity tests with filtering and retrieve stored results with staleness detection. Refactor the C# bridge into a shared base class to support future tool extensibility.

## Goals

- Run Unity EditMode tests synchronously from MCP with category, class, namespace, and assembly filters
- Store full test results on the server side (disk-backed) with run IDs
- Retrieve results with filtering (by status, name pattern) and adaptive verbosity (summary vs full)
- Detect staleness via marker files — flag when code changed since last run
- Refactor C# bridge into base class + handlers pattern for future extensibility
- Rename Unity asset folder from `Assets/Recompile Hook/` to `Assets/Claude Bridge/`

## Non-Goals

- PlayMode test execution (future work — requires handling background editor throttling and `Application.runInBackground`)
- Async test execution with ICallbacks (not needed — synchronous EditMode execution is sufficient)
- Real-time streaming of individual test results during a run
- Test discovery/listing tool (can be added later)
- CLI fallback for test runs (batch mode) — tests require the Unity editor running

## Constraints

### Unity Editor Required

Unlike recompile (which has a CLI fallback via `Unity -batchmode`), test execution **requires the Unity editor to be running**. The `TestRunnerApi` lives in the editor domain — it depends on `[InitializeOnLoad]`, the editor update loop, and domain reload. There is no way to run tests through the IPC bridge without an active editor session.

If the editor is not running when `unity_run_tests` is called, the tool should return a clear error: "Unity editor must be running to execute tests." It should NOT attempt to launch Unity in batch mode — Unity's `-runTests` CLI flag exists but uses a completely different execution path (stdout-based NUnit XML output) that bypasses our bridge. Supporting that as a fallback would be a separate feature.

---

## Architecture

### C# Bridge Refactoring

**Base class: `ClaudeBridgeBase.cs`**

Extracts shared infrastructure from the current `ClaudeRecompileBridge.cs`:

- `[InitializeOnLoad]` lifecycle management
- File watcher on `Library/ClaudeHookIPC/request.json`
- Request JSON parsing and validation
- Status JSON writing (`status-{requestId}.json`)
- Ready signal writing (`bridge-ready.json`)
- Action dispatch: routes `action` field to registered handler methods
- Common state machine (queued → processing → completed/failed)
- Timeout handling

**Handlers:**

- `ClaudeRecompileHandler.cs` — existing recompile + compilation pipeline logic, extracted from current monolith
- `ClaudeTestHandler.cs` — new, test execution via `TestRunnerApi`

All files installed to `Assets/Claude Bridge/Editor/` (renamed from `Assets/Recompile Hook/Editor/`).

The `BRIDGE_CS_FILENAME` constant in `config.ts` is replaced by a `BRIDGE_CS_FILES` array listing all C# files to install: `["ClaudeBridgeBase.cs", "ClaudeRecompileHandler.cs", "ClaudeTestHandler.cs"]`. The install logic iterates over this array.

### ClaudeTestHandler — C# Implementation

Runs EditMode tests **synchronously** using `runSynchronously = true`. This means `Execute()` blocks until all tests complete — no ICallbacks needed, no intermediate status, no background/focus concerns.

Note: `[UnityTest]` coroutine-based tests are automatically excluded by Unity in synchronous mode (they require multiple frames). Only standard `[Test]` methods run.

```
Receives action: "run_tests"
  ↓
Parses filter payload (categoryNames, groupNames, assemblyNames)
  ↓
Creates TestRunnerApi instance
  ↓
Registers ICallbacks to collect results (RunFinished provides the full result tree)
  ↓
Builds Filter (testMode = EditMode) + ExecutionSettings (runSynchronously = true)
  ↓
Calls Execute(settings) — blocks until all tests complete
  ↓
Walks result tree from RunFinished callback, extracts per-test data
  ↓
Writes final status: state = "tests_finished" + full results
```

**IPC Request Payload (new fields for `run_tests` action):**

```typescript
interface TestRunPayload {
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
}
```

**IPC Response (test-specific fields in BridgeStatus):**

```typescript
interface TestBridgeStatus extends BridgeStatusBase {
  state: "tests_finished" | "failed";
  testResults: {
    totalCount: number;
    passCount: number;
    failCount: number;
    skipCount: number;
    inconclusiveCount: number;
    duration: number;
    tests: TestResult[];
  };
}

interface TestResult {
  fullName: string;
  name: string;
  status: "Passed" | "Failed" | "Skipped" | "Inconclusive";
  duration: number;
  message: string | null;
  stackTrace: string | null;
  output: string | null;
}
```

---

### MCP Server — TypeScript Side

#### New Tool: `unity_run_tests`

**Input parameters (Zod schema):**

| Param | Type | Default | Description |
|---|---|---|---|
| `projectPath` | `string?` | cached | Unity project path |
| `categoryNames` | `string[]?` | — | NUnit `[Category]` tags |
| `groupNames` | `string[]?` | — | Regex patterns for namespace/class/test |
| `assemblyNames` | `string[]?` | — | Assembly names (without `.dll`) |
| `verbose` | `boolean?` | `false` | Full per-test output vs summary |

**Flow:**

1. Resolve project path (cached or provided)
2. Check Unity editor is running and bridge is ready — return error if not
3. Send `run_tests` IPC request with filter payload
4. Poll for bridge status (500ms interval, `TEST_STATUS_TIMEOUT_MS` timeout)
5. On `tests_finished`: generate run ID, add timestamp, touch staleness marker, store full results to disk
6. Return run ID + formatted results (summary or verbose)

#### New Tool: `unity_test_results`

**Input parameters (Zod schema):**

| Param | Type | Default | Description |
|---|---|---|---|
| `runId` | `string?` | latest | ID from a previous `unity_run_tests` call |
| `verbose` | `boolean?` | `false` | Full per-test output vs summary |
| `statusFilter` | `enum?` | — | `"passed"`, `"failed"`, `"skipped"` |
| `nameFilter` | `string?` | — | Regex pattern to match test `fullName` |

**Flow:**

1. Load stored results by run ID (or latest)
2. Check staleness: `find Assets/ -name "*.cs" -newer {marker} -print -quit`
3. Apply filters (status, name pattern)
4. Format output (summary or verbose)
5. Prepend staleness warning if code changed since run

#### Output Formatting

**Summary mode (default):**
```
Run test-1711234567890 (2026-03-24 14:22:47)
✓ 42 passed  ✗ 3 failed  ○ 1 skipped  (12.4s)

Failures:
  ✗ MyNamespace.PlayerTests.TestJump — Expected 5.0 but was 4.8
  ✗ MyNamespace.PlayerTests.TestDash — NullReferenceException
  ✗ MyNamespace.EnemyTests.TestSpawn — Timeout after 10s
```

**Verbose mode:**
```
Run test-1711234567890 (2026-03-24 14:22:47)
✓ 42 passed  ✗ 3 failed  ○ 1 skipped  (12.4s)

  ✓ MyNamespace.PlayerTests.TestMove (0.02s)
  ✓ MyNamespace.PlayerTests.TestRun (0.03s)
  ✗ MyNamespace.PlayerTests.TestJump (0.15s)
    Expected 5.0 but was 4.8
    at PlayerTests.TestJump() in Assets/Tests/PlayerTests.cs:42
  ...
```

---

### Test Result Storage

**Location:** `~/.claude/cache/unity-recompile/test-runs/`

**File format:** `{runId}.json`

```typescript
interface StoredTestRun {
  runId: string;
  timestamp: string;          // ISO 8601
  projectPath: string;
  filters: {                  // filters used for this run
    categoryNames?: string[];
    groupNames?: string[];
    assemblyNames?: string[];
  };
  results: {
    totalCount: number;
    passCount: number;
    failCount: number;
    skipCount: number;
    inconclusiveCount: number;
    duration: number;
    tests: TestResult[];
  };
}
```

**Run ID format:** `test-{unixMs}` (e.g. `test-1711234567890`)

**New file:** `src/lib/test-store.ts`
- `saveTestRun(run: StoredTestRun): void`
- `loadTestRun(runId: string): StoredTestRun | null`
- `loadLatestTestRun(): StoredTestRun | null`

---

### Generalized Marker System

**Refactored in:** `src/lib/project/changes.ts`

```typescript
/** Get marker path for a given project and purpose */
getMarkerPath(projectPath: string, purpose: string, markerDir?: string): string

/** Ensure marker exists (epoch mtime on first creation) */
ensureMarker(markerPath: string): void

/** Touch a marker for the given purpose */
touchMarker(markerPath: string): void

/** Check if any .cs files changed since the marker was last touched (synchronous, uses execSync) */
hasChangedSince(projectPath: string, markerPath: string): boolean
```

All functions remain synchronous (using `execSync` for `find`), consistent with the existing implementation.

**Marker file path:** `~/.claude/cache/unity-recompile/markers/{purpose}-{md5(projectPath)}`

**Purposes:**
- `"recompile"` — existing, migrated from current implementation
- `"test-run"` — new, touched after each test run completes

Recompile's current `hasChanges()` / `touchMarker()` in `changes.ts` are refactored to use this generalized API.

---

### Configuration

**New/changed constants in `src/lib/config.ts`:**

```typescript
// Test runner
export const TEST_STATUS_TIMEOUT_MS = 300_000;  // 5 minutes
export const TEST_STORE_DIR = path.join(CACHE_DIR, "test-runs");

// Bridge file list (replaces BRIDGE_CS_FILENAME)
export const BRIDGE_CS_FILES = [
  "ClaudeBridgeBase.cs",
  "ClaudeRecompileHandler.cs",
  "ClaudeTestHandler.cs",
];

// Bridge paths (renamed)
export const BRIDGE_ASSET_DIR = "Assets/Claude Bridge";
export const BRIDGE_EDITOR_DIR = "Assets/Claude Bridge/Editor";

// Git exclude patterns (updated)
export const GIT_EXCLUDE_PATTERNS = [
  "/Assets/Claude Bridge/",
  "/Assets/Claude Bridge.meta",
];
```

**Timeout usage:** `unity_run_tests` polling uses `TEST_STATUS_TIMEOUT_MS` (300s). Recompile continues to use `BRIDGE_STATUS_TIMEOUT_MS` (120s). These are independent — test runs are expected to take longer than recompilation.

---

### IPC Protocol Changes

**`BridgeRequest.action` extended:**

```typescript
action: "recompile" | "bootstrap_handshake" | "run_tests"
```

**New optional field on request:**

```typescript
payload?: TestRunPayload;  // present when action = "run_tests"
```

Protocol version remains `1` — the new action is additive, not breaking.

---

## File Changes Summary

### New Files

| File | Purpose |
|---|---|
| `templates/ClaudeBridgeBase.cs` | Shared C# bridge base class |
| `templates/ClaudeTestHandler.cs` | C# test runner handler |
| `src/core/test.ts` | MCP tool: run tests orchestration |
| `src/core/test-results.ts` | MCP tool: fetch/filter/format results |
| `src/lib/test-store.ts` | Disk-backed test run storage |

### Modified Files

| File | Change |
|---|---|
| `templates/ClaudeRecompileBridge.cs` | Extract base class, rename to handler, extend `ClaudeBridgeBase` |
| `src/mcp/server.ts` | Register `unity_run_tests` and `unity_test_results` tools |
| `src/lib/config.ts` | Add test timeout, test store dir, rename bridge paths |
| `src/lib/project/changes.ts` | Generalize marker system with `purpose` parameter |
| `src/lib/bridge/types.ts` | Extend `BridgeRequest.action`, add test-specific status types |
| `src/lib/bridge/install.ts` | Install all three C# files, update folder name |
| `src/core/recompile.ts` | Use generalized marker API |

### New Tests

| File | Coverage |
|---|---|
| `__tests__/lib/test-store.test.ts` | Save, load, load-latest |
| `__tests__/lib/project/changes.test.ts` | Generalized markers (multi-purpose) |
| `__tests__/core/test.test.ts` | Run tests orchestration (mocked bridge) |
| `__tests__/core/test-results.test.ts` | Filtering, formatting, staleness |
| `__tests__/mcp/server.test.ts` | Updated: verify 5 tools registered |

---

## Migration

When the bridge installs, it needs to handle the folder rename:

1. Check if old `Assets/Recompile Hook/` exists
2. If so, delete it (and its `.meta`)
3. Install new files to `Assets/Claude Bridge/Editor/`
4. Update `.git/info/exclude` with new patterns

This happens automatically on next recompile trigger.
