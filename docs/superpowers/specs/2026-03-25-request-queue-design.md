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

The FileSystemWatcher watches for `request-*.json` creation/changes (instead of the single `request.json`). The existing periodic timer (500ms) also triggers scans as a fallback. Note: on macOS, `FileSystemWatcher` uses `kqueue` which can be unreliable — the 500ms timer is the primary reliability mechanism, the watcher is an optimization.

### Timeout Extension for Queued Requests

The TS side resets its deadline when it sees a `"queued"` status. `waitForBridgeStatus` continues polling past `"queued"` (it is not a terminal state), but each time a non-terminal status update is read, the timeout counter resets. This prevents queued requests from timing out while waiting in line behind other requests.

### Queue Processing Loop

```
[Scan cycle]
  ├─ List all request-*.json files
  ├─ For each unacknowledged file:
  │   ├─ Parse and validate
  │   ├─ Skip (and delete) if requestedAtUnixMs is older than 5 minutes (stale request)
  │   ├─ Skip (and delete) if requestId is in ProcessedRequestIds (already handled)
  │   ├─ Skip if status file already exists for this requestId (already acknowledged)
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
  └─ Run cleanup sweep (status files + stale request files)
```

Handlers are unchanged — they still receive a `RequestPayload` and write status updates. The queue is transparent to handler logic.

### Domain Reload Safety

Recompilation triggers Unity domain reloads, which restart the C# bridge and clear the in-memory queue and `ProcessedRequestIds`. To prevent re-processing a request that was mid-flight:

On scan, before enqueuing a request, check if a `status-{requestId}.json` already exists. If it does and has a non-terminal state (e.g., `"compilation_started"`), the request was interrupted by a domain reload. Write a `"bridge_error"` status with summary `"Domain reload interrupted processing"` and delete the request file. The TS side will see the error and can retry.

If the status file has a terminal state, the request already completed — delete the request file without re-enqueuing.

### Status File Cleanup

**TS side (happy path):** After `waitForBridgeStatus` returns a terminal state, delete the `status-{requestId}.json` file.

**C# side (safety net):** During each scan cycle, check all `status-*.json` files. Delete any where `updatedAtUnixMs` is more than 5 minutes old and the state is terminal (`completed`, `failed`, `bridge_error`, `timeout`, `tests_finished`, `list_tests_finished`). Non-terminal status files are left alone regardless of age (they may belong to an active or queued request).

### Request File Cleanup

**C# side:** During each scan cycle, skip and delete any `request-{requestId}.json` where `requestedAtUnixMs` is older than 5 minutes. This handles stale requests from crashed TS sessions or from when Unity was not running.

### Deduplication

The existing `ProcessedRequestIds` set prevents re-processing a request the bridge has already handled. This is preserved. If C# sees a `request-{requestId}.json` whose ID is already in `ProcessedRequestIds`, it deletes the file without processing.

## Changes by File

### `config.ts`

- `requestFile` becomes a function taking `requestId`, returning `request-{requestId}.json` path (mirroring `statusFile`)
- Remove the old single `requestFile` path and `BRIDGE_REQUEST_FILENAME` constant

### `ipc.ts`

- `writeBridgeRequest`: Write to `request-{requestId}.json` instead of `request.json`
- `waitForBridgeStatus`: Reset timeout deadline on each non-terminal status read (extends timeout for queued requests)
- After `waitForBridgeStatus` returns a terminal state, `unlinkSync` the status file (cleanup)
- Remove the pre-request status file deletion (no longer needed — fresh file pair per request)
- Remove `"busy"` from `TERMINAL_STATES` — the C# side no longer writes "busy" status
- Remove the `status.state === "busy"` branch from `parseBridgeStatusToResult`

### `request.ts`

- `sendRawRequest`: Use new per-request file path from config
- Remove busy retry logic (`BRIDGE_MAX_BUSY_RETRIES`, `BRIDGE_BUSY_RETRY_DELAY_MS`) — the queue handles contention
- Remove pre-request `unlinkSync` of old status file — each request gets fresh files

### `ClaudeBridgeBase.cs`

- FileSystemWatcher: Watch for `request-*.json` pattern instead of single `request.json`
- Update `RequestFileName` constant to a prefix/pattern for the new naming scheme
- Replace `TryReadRequest()` with `ScanRequestFiles()` that returns a list of new request payloads
- Add in-memory queue (`List<RequestPayload>` or `Queue<RequestPayload>`) sorted by `requestedAtUnixMs`
- `ProcessRequestOnMainThread`: Scan for new requests, acknowledge with "queued" status, process FIFO
- Add domain reload safety: check for existing status files before enqueuing (see Domain Reload Safety section)
- After completing a request, delete its `request-{requestId}.json` and trigger next processing cycle
- Update `FinalizeRequest` / `TryDeleteRequestFileIfMatches` to use per-request file paths (simplifies to just deleting `request-{requestId}.json`)
- Add `CleanupStaleStatusFiles()`: Delete terminal status files older than 5 minutes
- Add `CleanupStaleRequestFiles()`: Delete request files older than 5 minutes
- Remove `_busyRequestId` "busy" status response — requests queue instead of being rejected
- Retain `_busyRequestId` internally to track whether processing is in progress

### `ClaudeRecompileHandler.cs` / `ClaudeTestHandler.cs`

No changes. Handlers receive `RequestPayload` and write status updates as before.

### `types.ts`

- Remove `"busy"` from the `BridgeStatus.state` union type
- Remove `"bridge_busy"` from the `BridgeError` type

## What Gets Simpler

- No "busy" state or retry logic on the TS side
- No race condition on request files — each session has its own
- Status files are cleaned up automatically
- The TS side flow becomes: write request file, poll for status, read result, delete status file
- `TryDeleteRequestFileIfMatches` becomes trivial (just delete by requestId, no need to compare contents)

## What Gets More Complex

- C# bridge maintains an in-memory queue and scan loop
- FileSystemWatcher handles a glob pattern instead of a single file
- C# needs cleanup sweep logic for old status and request files
- Domain reload safety check adds a pre-enqueue gate
- TS polling resets timeout on non-terminal status changes

## Edge Cases

**C# bridge restarts (domain reload):** The in-memory queue is lost, but request files on disk survive. On restart, the bridge re-scans the directory. For requests that were mid-processing, the existing status file is detected (see Domain Reload Safety) — a `"bridge_error"` status is written and the request file is deleted. For requests that were only queued (status is `"queued"`), they are re-enqueued and processed normally.

**TS session crashes before cleanup:** The status file is orphaned. The C# cleanup sweep deletes it after 5 minutes (if terminal).

**Request file written but never processed (e.g., Unity closed):** The TS side times out after 120 seconds. When Unity eventually opens, the bridge scans the directory and deletes any request files older than 5 minutes (stale request cleanup).

**Many requests queued simultaneously:** Processed FIFO. Each gets a "queued" acknowledgment immediately. The TS side resets its timeout on each status update, so queued requests won't time out while waiting in line.
