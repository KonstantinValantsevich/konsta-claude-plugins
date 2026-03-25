# Bridge-Aware IPC Layer

## Problem

Tools that need the Unity bridge (`run_tests`, `list_tests`) manually check preconditions (Unity running, bridge ready) and fail with "Bridge is not ready" if anything is missing. Bridge installation only happens inside `recompile()`, so if a user calls `list_tests` without first calling `recompile`, the bridge is never installed. Each tool duplicates ~20 lines of boilerplate (generate request ID, build request object, create IPC dir, write request, poll for status).

## Design

### `sendBridgeRequest` — self-sufficient IPC entry point

New file: `lib/bridge/request.ts`. Handles all preconditions and request execution:

1. **Install bridge** — `ensureBridgeInstalled()`, `ensureGitExclude()`, create IPC dir
2. **Check Unity running** — return `{ ok: false, error: "unity_not_running" }`
3. **Check bridge ready** — if `bridge-ready.json` doesn't match, trigger bootstrap flow (AppleScript refresh, wait for ready, handshake)
4. **Clean up stale status file** — `unlinkSync` previous status for this request ID
5. **Send request** — generate ID, build `BridgeRequest` (with `reason`/`source` derived from `action`), write request JSON, poll for status with busy retries (preserving current `BRIDGE_MAX_BUSY_RETRIES = 1`)
6. **Return result** — structured `BridgeResult`

```ts
// Public API — excludes "bootstrap_handshake" which is internal to the bootstrap flow
export type BridgeAction = "recompile" | "run_tests" | "list_tests";

export async function sendBridgeRequest(
  projectPath: string,
  action: BridgeAction,
  opts?: {
    payload?: TestDiscoveryFilters;
    timeoutMs?: number;  // defaults: TEST_STATUS_TIMEOUT_MS for test actions, BRIDGE_STATUS_TIMEOUT_MS otherwise
  },
): Promise<BridgeResult>;
```

### `BridgeResult` type

Defined in `lib/bridge/types.ts`:

```ts
export type BridgeResult =
  | { ok: true; status: BridgeStatus }
  | { ok: false; error: BridgeError; message: string };

export type BridgeError =
  | "unity_not_running"
  | "bridge_bootstrap_failed"  // bridge-ready.json never appeared after AppleScript refresh
  | "bridge_busy"              // exceeded max busy retries
  | "bridge_error"             // C# bridge returned state: "bridge_error"
  | "compilation_failed"       // C# bridge returned state: "failed"
  | "version_mismatch"         // bridge/protocol version doesn't match
  | "request_timeout";         // timed out waiting for status
```

When `ok: true`, the `status` field is the raw `BridgeStatus` from the C# bridge. Callers must still check action-specific fields (`status.testResults`, `status.testList`) — `sendBridgeRequest` handles infrastructure concerns, not domain validation.

### Error mapping

| Current error condition | Source | `BridgeError` |
|---|---|---|
| `unityIsRunning()` returns false | `applescript.ts` | `"unity_not_running"` |
| `bridge-ready.json` missing/mismatched after bootstrap | `orchestrate.ts:101-112` | `"bridge_bootstrap_failed"` |
| `status.state === "busy"` after max retries | `orchestrate.ts:69-74` | `"bridge_busy"` |
| `status.state === "bridge_error"` | `BridgeStatus.state` | `"bridge_error"` |
| `status.state === "failed"` | `BridgeStatus.state` | `"compilation_failed"` |
| Version mismatch in status response | `ipc.ts:91-100` | `"version_mismatch"` |
| `waitForBridgeStatus` returns null (timeout) | `ipc.ts` | `"request_timeout"` |

**Version mismatch detection**: Currently `waitForBridgeStatus` silently skips version-mismatched responses and eventually times out. `sendBridgeRequest` changes this: after polling completes, it checks the version on the response and returns `"version_mismatch"` immediately rather than masking it as a timeout.

### Recompilation as a separate concern

`recompile()` remains a standalone function. Tools that need compilation call it before `sendBridgeRequest`.

- `recompile()` checks `unityIsRunning()` first. If not running, uses CLI fallback directly — does NOT call `sendBridgeRequest`.
- If Unity IS running, `recompile()` calls `sendBridgeRequest("recompile")` for its IPC needs. This replaces the current manual `bridgeRequestAndWait` + orchestration.
- Bridge installation happens inside `sendBridgeRequest`, so `recompile()` no longer calls `ensureBridgeInstalled` directly.
- `recompile()` keeps its own concerns: marker logic, change detection, CLI fallback, error-to-`CompilationError` conversion.

**`bridgeChangedThisRun` flag eliminated**: Currently `recompile()` passes `bridgeChangedThisRun` to `orchestrateRecompile` to decide bootstrap vs. direct path. This flag is no longer needed. `sendBridgeRequest` always checks `bridge-ready.json` — after a fresh bridge install, the ready file will be stale or missing, so bootstrap triggers naturally. The explicit flag was an optimization that `sendBridgeRequest`'s readiness check makes redundant.

**`ensureBridgeInstalled` return value for change detection**: Currently `recompile()` uses `bridgeChangedThisRun` in its skip logic: `if (!csChanged && !bridgeChangedThisRun) return skipped`. After migration, `recompile()` calls `ensureBridgeInstalled()` directly just for the return value (idempotent — `sendBridgeRequest` also calls it internally). This preserves the skip-when-nothing-changed optimization.

### Tool composition (behavioral changes flagged)

| Tool | Flow | Change? |
|------|------|---------|
| `unity_recompile` | `recompile()` (uses `sendBridgeRequest` internally when Unity running) | Refactor only |
| `unity_run_tests` | `recompile()` then `sendBridgeRequest("run_tests", payload)` | **New**: adds recompile before test run |
| `unity_list_tests` | `sendBridgeRequest("list_tests", payload)` | Refactor only (bridge auto-installs now) |
| `unity_lint` | `recompile()` then run jb CLI | **New**: adds recompile before lint |
| `unity_status` | No bridge needed (read-only) | None |
| `unity_test_results` | No bridge needed (disk cache) | None |

**Why recompile before `run_tests`**: Tests should run against the latest compiled code. Without recompile, tests may pass/fail against stale binaries, giving misleading results.

**Why recompile before `lint`**: The linter operates on source files but should report against a known-good compilation state. Recompiling first ensures the project is in a consistent state and the bridge is ready for any subsequent operations.

### Affected files

| File | Change |
|------|--------|
| **New: `src/lib/bridge/request.ts`** | `sendBridgeRequest` implementation. Absorbs orchestration logic from `orchestrate.ts`. |
| `src/lib/bridge/types.ts` | Add `BridgeResult`, `BridgeError` types |
| `src/lib/bridge/orchestrate.ts` | Delete. All exports (`orchestrateRecompile`, `bridgeRequestAndWait`, `runBridgeBootstrapAndRecompile`, `runBridgeRecompileDirect`) absorbed into `request.ts`. `parseBridgeStatusToResult` from `ipc.ts` becomes an internal helper in `request.ts`. |
| `src/core/list-tests.ts` | Replace manual precondition checks + IPC boilerplate with `sendBridgeRequest("list_tests", ...)` |
| `src/core/test.ts` | Add `recompile()` call, replace IPC boilerplate with `sendBridgeRequest("run_tests", ...)`. Post-request logic (`saveTestRun`, `touchMarker`, `getTestResults`) stays in this file. |
| `src/core/recompile.ts` | Remove direct `ensureBridgeInstalled`/`ensureGitExclude`/IPC dir creation. Use `sendBridgeRequest("recompile")` when Unity is running. Keep marker logic, change detection, CLI fallback. |
| `src/core/lint.ts` | Add `recompile()` call before jb CLI execution |
| `src/mcp/server.ts` | No changes — composition happens inside core functions |

### Internal details preserved by `sendBridgeRequest`

- **Busy retries**: `BRIDGE_MAX_BUSY_RETRIES` loop preserved from current `bridgeRequestAndWait`
- **Status file cleanup**: `unlinkSync` of stale status file before each request
- **`reason`/`source` on `BridgeRequest`**: Derived from `action` parameter (e.g., action `"run_tests"` → reason `"unity_run_tests MCP tool"`, source `"unity-mcp"`)
- **Default timeouts**: `TEST_STATUS_TIMEOUT_MS` (300s) for `run_tests`/`list_tests`, `BRIDGE_STATUS_TIMEOUT_MS` (120s) for `recompile`/`bootstrap_handshake`

### Before/after: `list_tests.ts`

**Before**:
```ts
if (!unityIsRunning(projectPath)) {
  return { ...empty, formatted: "Unity editor must be running to list tests." };
}
const paths = bridgePaths(projectPath);
if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) {
  return { ...empty, formatted: "Bridge is not ready. Run unity_recompile first." };
}
const requestId = generateRequestId();
const statusPath = paths.statusFile(requestId);
try { fs.unlinkSync(statusPath); } catch {}
const request: BridgeRequest = { protocolVersion, requestId, requestedAtUnixMs, projectPath, action: "list_tests", reason, source, payload };
fs.mkdirSync(paths.ipcDir, { recursive: true });
writeBridgeRequest(paths.requestFile, request);
const status = await waitForBridgeStatus(statusPath, requestId, TEST_STATUS_TIMEOUT_MS);
if (!status) return { ...empty, formatted: "Timed out..." };
if (status.state === "failed" || status.state === "bridge_error") return { ...empty, formatted: "List tests failed: " + status.summary };
```

**After**:
```ts
const result = await sendBridgeRequest(projectPath, "list_tests", { payload });
if (!result.ok) return { ...empty, formatted: result.message };
const { status } = result;
```

### Before/after: `recompile.ts` (Unity running path)

**Before**:
```ts
const paths = bridgePaths(projectPath);
ensureGitExclude(projectPath);
fs.mkdirSync(paths.ipcDir, { recursive: true });
const { changed: bridgeChangedThisRun } = ensureBridgeInstalled(projectPath);
// ... change detection ...
const result = await orchestrateRecompile(projectPath, bridgeChangedThisRun);
```

**After**:
```ts
// Bridge install called for return value (idempotent — sendBridgeRequest also calls it internally)
const { changed: bridgeChangedThisRun } = ensureBridgeInstalled(projectPath);
ensureGitExclude(projectPath);

const csChanged = hasChangedCsFiles(projectPath, markerPath);
if (!csChanged && !bridgeChangedThisRun) {
  return { success: true, skipped: true, errors: [] };
}

if (unityIsRunning(projectPath)) {
  const result = await sendBridgeRequest(projectPath, "recompile");
  // convert BridgeResult to RecompileResult for existing callers
} else {
  return runCliFallback(projectPath);
}
```

### Migration strategy

Incremental, one tool at a time:

1. Add `BridgeResult`/`BridgeError` types to `types.ts`
2. Create `request.ts` with `sendBridgeRequest`, absorbing logic from `orchestrate.ts` and `ipc.ts` helpers
3. Migrate `list_tests.ts` (simplest — no recompile, just bridge request)
4. Migrate `recompile.ts` (replace orchestration with `sendBridgeRequest`)
5. Migrate `test.ts` (add recompile + use `sendBridgeRequest`)
6. Migrate `lint.ts` (add recompile call)
7. Remove dead code from `orchestrate.ts`

Each step can be tested independently before proceeding.
