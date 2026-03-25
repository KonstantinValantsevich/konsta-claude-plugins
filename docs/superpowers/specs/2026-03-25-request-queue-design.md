# Request Queue & Status Cleanup

## Problem

The current IPC between TypeScript MCP servers and the C# Unity bridge uses a single `request.json` file. When multiple MCP sessions (from different Claude Code windows) send requests simultaneously, later writes overwrite earlier ones — silently losing requests. The losing session waits 120 seconds and times out.

Additionally, `status-{requestId}.json` files accumulate indefinitely in `Library/ClaudeHookIPC/` with no cleanup.

## Goals

1. Multiple MCP sessions can enqueue requests without losing any
2. Requests are processed in FIFO order, one at a time
3. Each session gets immediate "queued" acknowledgment
4. Status files are cleaned up after use, with a safety net for orphans

## Design

### Request Queue via Per-Request Files

**TS side (enqueue):**

Each session writes its request as `request-{requestId}.json` instead of the shared `request.json`. Since each session generates a unique `requestId`, there is no contention — concurrent writers never touch the same file.

The atomic write pattern (write to `.tmp`, rename) is preserved.

**C# side (dequeue):**

The bridge scans the IPC directory for `request-*.json` files. On each scan cycle:

1. Discover new request files not yet acknowledged
2. For each new request, write `status-{requestId}.json` with state `"queued"`
3. If not currently busy, pick the oldest request by `requestedAtUnixMs` and process it
4. On completion, delete the processed `request-{requestId}.json` file
5. Loop: pick the next queued request

The FileSystemWatcher watches for `request-*.json` creation/changes (instead of the single `request.json`). The existing periodic timer (500ms) also triggers scans as a fallback.

### Queue Processing Loop

```
[Scan cycle]
  ├─ List all request-*.json files
  ├─ For each unacknowledged file:
  │   ├─ Parse and validate
  │   ├─ Write status-{requestId}.json → state: "queued"
  │   └─ Add to in-memory queue (sorted by requestedAtUnixMs)
  ├─ If not busy and queue is non-empty:
  │   ├─ Dequeue oldest request
  │   ├─ MarkBusy(requestId)
  │   ├─ Invoke handler (recompile, run_tests, etc.)
  │   ├─ Handler writes status updates as before
  │   ├─ On completion: delete request-{requestId}.json
  │   ├─ MarkFree()
  │   └─ Trigger next scan cycle
  └─ Run status file cleanup sweep
```

Handlers are unchanged — they still receive a `RequestPayload` and write status updates. The queue is transparent to handler logic.

### Status File Cleanup

**TS side (happy path):** After `waitForBridgeStatus` returns a terminal state, delete the `status-{requestId}.json` file.

**C# side (safety net):** During each scan cycle, check all `status-*.json` files. Delete any where `updatedAtUnixMs` is more than 5 minutes old and the state is terminal (`completed`, `failed`, `bridge_error`, `timeout`, `tests_finished`, `list_tests_finished`). Non-terminal status files are left alone regardless of age (they may belong to an active or queued request).

### Deduplication

The existing `ProcessedRequestIds` set prevents re-processing a request the bridge has already handled. This is preserved. If C# sees a `request-{requestId}.json` whose ID is already in `ProcessedRequestIds`, it deletes the file without processing.

## Changes by File

### `config.ts`

- `requestFile` becomes a function taking `requestId`, returning `request-{requestId}.json` path (mirroring `statusFile`)
- Remove the old single `requestFile` path

### `ipc.ts`

- `writeBridgeRequest`: Write to `request-{requestId}.json` instead of `request.json`
- After `waitForBridgeStatus` returns a terminal state, `unlinkSync` the status file (cleanup)
- Remove the pre-request status file deletion (no longer needed — fresh file pair per request)

### `request.ts`

- `sendRawRequest`: Use new per-request file path from config
- Remove busy retry logic (`BRIDGE_MAX_BUSY_RETRIES`, `BRIDGE_BUSY_RETRY_DELAY_MS`) — the queue handles contention
- Remove pre-request `unlinkSync` of old status file — each request gets fresh files

### `ClaudeBridgeBase.cs`

- FileSystemWatcher: Watch for `request-*.json` pattern instead of single `request.json`
- Replace `TryReadRequest()` with `ScanRequestFiles()` that returns a list of new request payloads
- Add in-memory queue (`List<RequestPayload>` or `Queue<RequestPayload>`) sorted by `requestedAtUnixMs`
- `ProcessRequestOnMainThread`: Scan for new requests, acknowledge with "queued" status, process FIFO
- After completing a request, delete its `request-{requestId}.json` and trigger next processing cycle
- Add `CleanupStaleStatusFiles()`: Delete terminal status files older than 5 minutes
- Remove `_busyRequestId` "busy" status response — requests queue instead of being rejected
- Retain `_busyRequestId` internally to track whether processing is in progress

### `ClaudeRecompileHandler.cs` / `ClaudeTestHandler.cs`

No changes. Handlers receive `RequestPayload` and write status updates as before.

### `types.ts`

No protocol changes. `BridgeRequest` and `BridgeStatus` types are unchanged.

## What Gets Simpler

- No "busy" state or retry logic on the TS side
- No race condition on request files — each session has its own
- Status files are cleaned up automatically
- The TS side flow becomes: write request file, poll for status, read result, delete status file

## What Gets More Complex

- C# bridge maintains an in-memory queue and scan loop
- FileSystemWatcher handles a glob pattern instead of a single file
- C# needs cleanup sweep logic for old status files

## Edge Cases

**C# bridge restarts (domain reload):** The in-memory queue is lost, but request files on disk survive. On restart, the bridge re-scans the directory and picks up any unprocessed request files. Requests that were mid-processing when the restart happened will have their request file still on disk (since it's only deleted on completion), so they'll be re-enqueued. The TS side is already polling and will see the new status updates.

**TS session crashes before cleanup:** The status file is orphaned. The C# cleanup sweep deletes it after 5 minutes.

**Request file written but never processed (e.g., Unity closed):** The TS side times out after 120 seconds as before. The stale request file will be cleaned up when Unity next opens and the bridge re-initializes.

**Many requests queued simultaneously:** Processed FIFO. Each gets a "queued" acknowledgment immediately, so no session times out waiting for acknowledgment. The 120-second timeout applies from when the TS side starts polling, which should be generous enough for reasonable queue depths.
