# Request Queue & Status Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single `request.json` IPC with per-request files and FIFO queue processing, plus automatic cleanup of status files.

**Architecture:** TS side writes `request-{requestId}.json` per session (no contention). C# bridge scans directory, acknowledges with "queued" status, processes FIFO, cleans up stale files. TS side resets timeout on status updates and deletes status file after reading.

**Tech Stack:** TypeScript (Node.js MCP server), C# (Unity Editor bridge), vitest

**Spec:** `docs/superpowers/specs/2026-03-25-request-queue-design.md`

---

### Task 1: Remove "busy" state from TypeScript types and IPC

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/types.ts:52-63` (remove `"busy"` from state union)
- Modify: `plugins/unity-mcp/src/lib/bridge/types.ts:117-124` (remove `"bridge_busy"` from BridgeError)
- Modify: `plugins/unity-mcp/src/lib/bridge/ipc.ts:102-108` (remove busy branch from parseBridgeStatusToResult)
- Modify: `plugins/unity-mcp/src/lib/bridge/ipc.ts:134-142` (remove `"busy"` from TERMINAL_STATES)

- [ ] **Step 1: Remove `"busy"` from BridgeStatus state union in types.ts**

In `plugins/unity-mcp/src/lib/bridge/types.ts`, remove the `| "busy"` line from the `state` field (line 60):

```typescript
  state:
    | "queued"
    | "refresh_requested"
    | "compilation_started"
    | "compilation_finished"
    | "completed"
    | "failed"
    | "bridge_error"
    | "timeout"
    | "tests_finished"
    | "list_tests_finished";
```

- [ ] **Step 2: Remove `"bridge_busy"` from BridgeError type**

In `plugins/unity-mcp/src/lib/bridge/types.ts`, remove `"bridge_busy"` from the union (line 120):

```typescript
export type BridgeError =
  | "unity_not_running"
  | "bridge_bootstrap_failed"
  | "bridge_error"
  | "compilation_failed"
  | "version_mismatch"
  | "request_timeout";
```

- [ ] **Step 3: Remove busy branch from parseBridgeStatusToResult**

In `plugins/unity-mcp/src/lib/bridge/ipc.ts`, delete lines 102-108:

```typescript
  // DELETE this block:
  if (status.state === "busy") {
    return {
      success: false,
      didCompile: false,
      errors: [status.summary || "Bridge is busy"],
    };
  }
```

- [ ] **Step 4: Remove `"busy"` from TERMINAL_STATES**

In `plugins/unity-mcp/src/lib/bridge/ipc.ts`, update the set (lines 134-142):

```typescript
const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "bridge_error",
  "timeout",
  "tests_finished",
  "list_tests_finished",
]);
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds with no errors.

- [ ] **Step 6: Commit**

```
git add plugins/unity-mcp/src/lib/bridge/types.ts plugins/unity-mcp/src/lib/bridge/ipc.ts
git commit -m "refactor: remove busy state from bridge types and IPC"
```

---

### Task 2: Update all TS-side IPC — per-request files, timeout reset, status cleanup

All TS-side changes that affect the request/status file contract are applied together so every commit leaves a compilable codebase.

**Files:**
- Modify: `plugins/unity-mcp/src/lib/config.ts:13-14` (remove busy retry constants)
- Modify: `plugins/unity-mcp/src/lib/config.ts:30` (remove BRIDGE_REQUEST_FILENAME)
- Modify: `plugins/unity-mcp/src/lib/config.ts:43-57` (change requestFile to function)
- Modify: `plugins/unity-mcp/src/lib/bridge/ipc.ts:167-194` (waitForBridgeStatus — reset deadline on non-terminal status)
- Modify: `plugins/unity-mcp/src/lib/bridge/request.ts:1-11` (update imports — remove busy constants)
- Modify: `plugins/unity-mcp/src/lib/bridge/request.ts:89-155` (sendRawRequest — per-request path, remove busy loop, add status cleanup)

- [ ] **Step 1: Remove busy retry constants from config.ts**

In `plugins/unity-mcp/src/lib/config.ts`, delete lines 13-14:

```typescript
// DELETE these two lines:
export const BRIDGE_BUSY_RETRY_DELAY_MS = 1_000;
export const BRIDGE_MAX_BUSY_RETRIES = 1;
```

- [ ] **Step 2: Remove BRIDGE_REQUEST_FILENAME constant from config.ts**

Delete line 30:

```typescript
// DELETE:
export const BRIDGE_REQUEST_FILENAME = "request.json";
```

- [ ] **Step 3: Change requestFile to a function taking requestId in config.ts**

In the `bridgePaths` function, change the `requestFile` property from a static path to a function matching the `statusFile` pattern:

```typescript
export function bridgePaths(projectPath: string) {
  const ipcDir = path.join(projectPath, BRIDGE_IPC_DIRNAME);
  return {
    bridgeRootDir: path.join(projectPath, BRIDGE_ASSET_DIR),
    bridgeEditorDir: path.join(projectPath, BRIDGE_EDITOR_DIR),
    bridgeFiles: BRIDGE_CS_FILES.map((f) =>
      path.join(projectPath, BRIDGE_EDITOR_DIR, f),
    ),
    ipcDir,
    requestFile: (requestId: string) =>
      path.join(ipcDir, `request-${requestId}.json`),
    readyFile: path.join(ipcDir, BRIDGE_READY_FILENAME),
    statusFile: (requestId: string) =>
      path.join(ipcDir, `status-${requestId}.json`),
  };
}
```

- [ ] **Step 4: Update waitForBridgeStatus to reset deadline on non-terminal status**

In `plugins/unity-mcp/src/lib/bridge/ipc.ts`, replace the `waitForBridgeStatus` function (lines 167-194). The key change: `deadline` is now `let` instead of `const`, and is reset when a non-terminal status with matching requestId and valid version is read.

```typescript
/**
 * Poll for a bridge status file with the matching request ID and terminal state.
 * Resets the deadline each time a non-terminal status update is read,
 * preventing queued requests from timing out while waiting in line.
 */
export async function waitForBridgeStatus(
  statusPath: string,
  requestId: string,
  timeoutMs: number,
): Promise<BridgeStatus | null> {
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readBridgeStatus(statusPath);
    if (status && status.requestId === requestId) {
      if (
        status.bridgeVersion !== BRIDGE_VERSION ||
        status.protocolVersion !== BRIDGE_PROTOCOL_VERSION
      ) {
        // Version mismatch — don't reset deadline (bridge may be upgrading)
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (TERMINAL_STATES.has(status.state)) {
        log(
          `Bridge status final: requestId=${requestId} state=${status.state}`,
        );
        return status;
      }
      // Non-terminal status seen — reset deadline (request is alive/queued)
      deadline = Date.now() + timeoutMs;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log(`Timed out waiting for bridge status: requestId=${requestId}`);
  return null;
}
```

- [ ] **Step 5: Update imports in request.ts**

In `plugins/unity-mcp/src/lib/bridge/request.ts`, update the imports from config (lines 2-11). Remove `BRIDGE_BUSY_RETRY_DELAY_MS` and `BRIDGE_MAX_BUSY_RETRIES`:

```typescript
import fs from "node:fs";
import {
  bridgePaths,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_READY_TIMEOUT_MS,
  BRIDGE_STATUS_TIMEOUT_MS,
  BRIDGE_VERSION,
  TEST_STATUS_TIMEOUT_MS,
} from "../config.js";
```

Remove `sleep` from the ipc.js import (line 23) — no longer used in request.ts after removing busy retries:

```typescript
import {
  bridgeReadyMatchesProject,
  generateRequestId,
  waitForBridgeReady,
  waitForBridgeStatus,
  writeBridgeRequest,
} from "./ipc.js";
```

- [ ] **Step 6: Rewrite sendRawRequest — per-request paths, no busy loop, status cleanup**

Replace the entire `sendRawRequest` function (lines 89-155). Key changes: `requestPath` uses `paths.requestFile(requestId)` (per-request file), no `while (true)` busy-retry loop, no pre-request `unlinkSync`, status file cleanup after reading.

```typescript
/**
 * Low-level: send a single bridge request and poll for status.
 * Each request gets its own request-{requestId}.json and status-{requestId}.json files.
 */
async function sendRawRequest(
  projectPath: string,
  paths: ReturnType<typeof bridgePaths>,
  action: BridgeAction | "bootstrap_handshake",
  opts?: { payload?: TestDiscoveryFilters; timeoutMs?: number },
): Promise<BridgeResult> {
  const timeoutMs = opts?.timeoutMs ?? defaultTimeout(action);
  const requestId = generateRequestId();
  const statusPath = paths.statusFile(requestId);
  const requestPath = paths.requestFile(requestId);

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

  writeBridgeRequest(requestPath, request);

  const status = await waitForBridgeStatus(statusPath, requestId, timeoutMs);

  // Clean up status file after reading (happy-path cleanup)
  try { fs.unlinkSync(statusPath); } catch { /* already gone or never created */ }

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

  if (status.state === "bridge_error") {
    return { ok: false, error: "bridge_error", message: status.summary || "Bridge error." };
  }

  // "failed" is a valid terminal state — return the full status so callers
  // can extract structured errors via parseBridgeStatusToResult.
  return { ok: true, status };
}
```

- [ ] **Step 7: Verify TypeScript compiles and build succeeds**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds with no errors. All TS-side changes are now consistent.

- [ ] **Step 8: Commit**

```
git add plugins/unity-mcp/src/lib/config.ts plugins/unity-mcp/src/lib/bridge/ipc.ts plugins/unity-mcp/src/lib/bridge/request.ts
git commit -m "feat: per-request IPC files, timeout reset, status cleanup"
```

---

### Task 3: Update ClaudeBridgeBase.cs — request queue, scan loop, cleanup

This is the largest task. The C# bridge needs to: scan for `request-*.json` files, maintain a FIFO queue, acknowledge with "queued" status, handle domain reload safety, and clean up stale files.

**Files:**
- Modify: `plugins/unity-mcp/templates/ClaudeBridgeBase.cs` (major rewrite of request handling)

- [ ] **Step 1: Update constants and add queue fields**

Replace the `RequestFileName` constant (line 14) and add new constants/fields:

```csharp
    private const string RequestFilePrefix = "request-";
    private const string StatusFilePrefix = "status-";
    private const string ReadyFileName = "bridge-ready.json";
    private const long StaleThresholdMs = 5 * 60 * 1000; // 5 minutes
```

Add queue fields after the existing `ActionHandlers` declaration (line 74):

```csharp
    private static readonly List<RequestPayload> RequestQueue = new List<RequestPayload>();
    private static readonly HashSet<string> AcknowledgedRequestIds = new HashSet<string>();
```

Keep `_busyRequestId` — it's still used internally to track in-progress work.

- [ ] **Step 2: Remove RequestPath property**

Delete line 78 — it references the old single-file path:

```csharp
// DELETE:
private static string RequestPath => Path.Combine(IpcDir, RequestFileName);
```

- [ ] **Step 3: Update FileSystemWatcher to watch request-*.json pattern**

In `StartWatcher()` (line 180), change the filter from `RequestFileName` to `"request-*.json"`:

```csharp
    _watcher = new FileSystemWatcher(IpcDir, "request-*.json")
    {
        NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.CreationTime | NotifyFilters.Size,
        IncludeSubdirectories = false,
        EnableRaisingEvents = true,
    };
```

- [ ] **Step 4: Replace TryReadRequest with ScanRequestFiles**

Replace `TryReadRequest()` (lines 295-305) with a method that scans the directory for all request files:

```csharp
    private static List<RequestPayload> ScanRequestFiles()
    {
        var results = new List<RequestPayload>();
        try
        {
            string[] files = Directory.GetFiles(IpcDir, "request-*.json");
            foreach (string filePath in files)
            {
                if (filePath.EndsWith(".tmp")) continue;
                try
                {
                    string json = File.ReadAllText(filePath);
                    if (string.IsNullOrWhiteSpace(json)) continue;
                    var request = JsonUtility.FromJson<RequestPayload>(json);
                    if (request != null && !string.IsNullOrEmpty(request.requestId))
                        results.Add(request);
                }
                catch (Exception) { /* skip unreadable files */ }
            }
        }
        catch (Exception) { /* directory access failed */ }
        return results;
    }
```

- [ ] **Step 5: Replace ProcessRequestOnMainThread with queue-based processing**

Replace `ProcessRequestOnMainThread()` (lines 215-257) with the new queue-based logic. Note: `AcknowledgedRequestIds` is empty after domain reload (static state is re-initialized), so the `AcknowledgedRequestIds.Contains` check correctly passes through to the domain-reload-safety status file check below it.

```csharp
    private static void ProcessRequestOnMainThread()
    {
        lock (Sync) { _requestCheckQueued = false; }

        long now = NowUnixMs();
        List<RequestPayload> scanned = ScanRequestFiles();

        foreach (var request in scanned)
        {
            // Skip wrong project
            if (!string.Equals(request.projectPath ?? string.Empty, ProjectPath, StringComparison.Ordinal))
                continue;

            // Skip invalid
            if (string.IsNullOrEmpty(request.requestId)) continue;

            // Skip already processed — delete stale request file
            if (ProcessedRequestIds.Contains(request.requestId))
            {
                TryDeleteRequestFile(request.requestId);
                continue;
            }

            // Skip already acknowledged (within this session)
            if (AcknowledgedRequestIds.Contains(request.requestId)) continue;

            // Skip stale requests (older than 5 minutes)
            if (request.requestedAtUnixMs > 0 && (now - request.requestedAtUnixMs) > StaleThresholdMs)
            {
                TryDeleteRequestFile(request.requestId);
                continue;
            }

            // Domain reload safety: check for existing status file
            string statusPath = Path.Combine(IpcDir, StatusFilePrefix + request.requestId + ".json");
            if (File.Exists(statusPath))
            {
                try
                {
                    string statusJson = File.ReadAllText(statusPath);
                    var statusObj = JsonUtility.FromJson<StatusPayload>(statusJson);
                    if (statusObj != null)
                    {
                        if (IsTerminalState(statusObj.state))
                        {
                            // Already completed — just clean up request file
                            TryDeleteRequestFile(request.requestId);
                            continue;
                        }
                        if (statusObj.state == "queued")
                        {
                            // Was queued before domain reload — re-enqueue
                            AcknowledgedRequestIds.Add(request.requestId);
                            RequestQueue.Add(request);
                            continue;
                        }
                        // Non-terminal, non-queued = was mid-processing when domain reload hit
                        WriteStatus(request, "bridge_error", false, false, "Domain reload interrupted processing");
                        TryDeleteRequestFile(request.requestId);
                        continue;
                    }
                }
                catch (Exception) { /* couldn't read status — treat as new */ }
            }

            // Protocol version check
            if (request.protocolVersion != ProtocolVersion)
            {
                WriteStatus(request, "bridge_error", false, false, "Unsupported protocol version");
                TryDeleteRequestFile(request.requestId);
                continue;
            }

            // Acknowledge with "queued" status
            WriteStatus(request, "queued", false, false, "Request queued for processing");
            AcknowledgedRequestIds.Add(request.requestId);
            RequestQueue.Add(request);
        }

        // Sort queue by requestedAtUnixMs (FIFO)
        RequestQueue.Sort((a, b) => a.requestedAtUnixMs.CompareTo(b.requestedAtUnixMs));

        // Process next if not busy
        if (_busyRequestId == null && RequestQueue.Count > 0)
        {
            RequestPayload next = RequestQueue[0];
            RequestQueue.RemoveAt(0);
            DispatchRequest(next);
        }

        // Run cleanup sweep
        CleanupStaleFiles(now);
    }

    private static bool IsTerminalState(string state)
    {
        return state == "completed" || state == "failed" || state == "bridge_error"
            || state == "timeout" || state == "tests_finished" || state == "list_tests_finished";
    }

    private static void DispatchRequest(RequestPayload request)
    {
        if (request.action == "bootstrap_handshake")
        {
            WriteStatus(request, "completed", false, true, "Bridge loaded and handshake acknowledged");
            ProcessedRequestIds.Add(request.requestId);
            AcknowledgedRequestIds.Remove(request.requestId);
            TryDeleteRequestFile(request.requestId);
            // Trigger next scan to process queued requests
            QueueRequestCheck();
            return;
        }

        if (ActionHandlers.TryGetValue(request.action, out var handler))
        {
            // Handlers call MarkBusy internally via their registration pattern
            handler(request, NowUnixMs());
        }
        else
        {
            WriteStatus(request, "bridge_error", false, false, "Unsupported action: " + request.action);
            ProcessedRequestIds.Add(request.requestId);
            AcknowledgedRequestIds.Remove(request.requestId);
            TryDeleteRequestFile(request.requestId);
            QueueRequestCheck();
        }
    }
```

- [ ] **Step 6: Update FinalizeRequest to use per-request paths and trigger next**

Replace `FinalizeRequest` (lines 153-159):

```csharp
    internal static void FinalizeRequest(RequestPayload request)
    {
        if (request == null) return;
        ProcessedRequestIds.Add(request.requestId);
        AcknowledgedRequestIds.Remove(request.requestId);
        TryDeleteRequestFile(request.requestId);
        MarkFree();
        // Trigger scan to process next queued request
        QueueRequestCheck();
    }
```

- [ ] **Step 7: Replace TryDeleteRequestFileIfMatches with TryDeleteRequestFile**

Replace lines 343-352:

```csharp
    private static void TryDeleteRequestFile(string requestId)
    {
        try
        {
            string path = Path.Combine(IpcDir, RequestFilePrefix + requestId + ".json");
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception) { }
    }
```

- [ ] **Step 8: Add CleanupStaleFiles method**

Add after `TryDeleteRequestFile`:

```csharp
    private static void CleanupStaleFiles(long nowMs)
    {
        try
        {
            // Clean up terminal status files older than 5 minutes
            string[] statusFiles = Directory.GetFiles(IpcDir, "status-*.json");
            foreach (string filePath in statusFiles)
            {
                if (filePath.EndsWith(".tmp")) continue;
                try
                {
                    string json = File.ReadAllText(filePath);
                    var status = JsonUtility.FromJson<StatusPayload>(json);
                    if (status == null) continue;
                    if (!IsTerminalState(status.state)) continue;
                    if (status.updatedAtUnixMs > 0 && (nowMs - status.updatedAtUnixMs) > StaleThresholdMs)
                        File.Delete(filePath);
                }
                catch (Exception) { /* skip unreadable */ }
            }

            // Clean up stale request files older than 5 minutes
            string[] requestFiles = Directory.GetFiles(IpcDir, "request-*.json");
            foreach (string filePath in requestFiles)
            {
                if (filePath.EndsWith(".tmp")) continue;
                try
                {
                    string json = File.ReadAllText(filePath);
                    var request = JsonUtility.FromJson<RequestPayload>(json);
                    if (request == null) continue;
                    if (request.requestedAtUnixMs > 0 && (nowMs - request.requestedAtUnixMs) > StaleThresholdMs)
                        File.Delete(filePath);
                }
                catch (Exception) { /* skip unreadable */ }
            }
        }
        catch (Exception) { /* directory access failed */ }
    }
```

- [ ] **Step 9: Remove OnEditorUpdate queue fallback — rely on QueueRequestCheck scheduling**

The `FinalizeRequest` and `DispatchRequest` methods already call `QueueRequestCheck()` to schedule the next processing cycle. Keep `OnEditorUpdate` simple to avoid excessive directory scanning (it runs every editor frame):

```csharp
    private static void OnEditorUpdate()
    {
        if (_requestCheckQueued) ProcessRequestOnMainThread();
    }
```

This is unchanged from the original. `QueueRequestCheck()` in `FinalizeRequest` and `DispatchRequest` ensures the queue drains after each completion.

- [ ] **Step 10: Update UpdateLoopKickTimerState to account for queue**

In `UpdateLoopKickTimerState()` (lines 273-288), the timer should also stay active when the queue has items:

```csharp
    private static void UpdateLoopKickTimerState()
    {
        lock (Sync)
        {
            bool needsKicks = _requestCheckQueued || _busyRequestId != null || RequestQueue.Count > 0;
            if (!needsKicks && _loopKickTimer != null)
            {
                try { _loopKickTimer.Dispose(); } catch (Exception) { }
                _loopKickTimer = null;
            }
            else if (needsKicks && _loopKickTimer == null)
            {
                _loopKickTimer = new Timer(_ => { TryKickEditorLoop(); }, null, 0, 500);
            }
        }
    }
```

- [ ] **Step 11: Verify build**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds (TS side). C# is validated at Unity compile time — verify no syntax errors by reviewing the file.

- [ ] **Step 12: Commit**

```
git add plugins/unity-mcp/templates/ClaudeBridgeBase.cs
git commit -m "feat: FIFO request queue, domain reload safety, stale file cleanup"
```

---

### Task 4: Build, version bump, and final commit

**Files:**
- Modify: `plugins/unity-mcp/package.json:3` (version bump)
- Regenerate: `plugins/unity-mcp/dist/server.mjs`

- [ ] **Step 1: Run full build**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds, `dist/server.mjs` is regenerated.

- [ ] **Step 2: Bump version**

In `plugins/unity-mcp/package.json`, bump version from `"1.0.0"` to `"1.1.0"` (new feature).

- [ ] **Step 3: Commit**

```
git add plugins/unity-mcp/package.json plugins/unity-mcp/dist/server.mjs
git commit -m "chore: bump unity-mcp to 1.1.0 — request queue & cleanup"
```
