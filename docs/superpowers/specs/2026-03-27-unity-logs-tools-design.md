# Unity Logs Tools Design

## Overview

Two new MCP tools (`unity_logs` and `unity_console`) that give the agent access to Unity Console log entries, eliminating the need for the user to copy/paste log output.

- **`unity_logs`** — cursor-based incremental pull. Agent calls repeatedly to get new entries since last check. Supports debugging runtime issues, post-recompile context, and on-demand investigation.
- **`unity_console`** — snapshot of recent console entries. Returns the most recent entries, mirroring what's currently visible in the Unity Console window.

## Architecture

### Approach: Shared Log Collector + Thin Handler Layer

Separation of concerns across three components:

```
Application.logMessageReceivedThreaded
        |
        v
ClaudeLogCollector.cs  (static, owns ring buffer, thread-safe)
        |
        v
ClaudeLogHandler.cs    (bridge action dispatch for get_logs / get_console)
        |
        v
Filesystem IPC         (existing request/status JSON pattern)
        |
        v
src/core/logs.ts       (unity_logs tool — cursor-based)
src/core/console.ts    (unity_console tool — snapshot)
        |
        v
server.ts              (MCP tool registration)
```

Future expansion (e.g. Editor.log, player logs) adds new collectors without touching the handler or IPC layer.

## C# Side

### ClaudeLogCollector.cs

Static class initialized via `[InitializeOnLoadMethod]`. Subscribes to `Application.logMessageReceivedThreaded`.

**Data structure:**

```csharp
struct LogEntry {
    int id;           // monotonically increasing, serves as cursor
    LogType type;     // Log, Warning, Error, Exception, Assert
    string message;
    string stackTrace;
    double timestamp;  // EditorApplication.timeSinceStartup
}
```

**Ring buffer:** Fixed capacity of 1000 entries. Thread-safe via `lock` (logMessageReceivedThreaded fires from any thread).

**Public API:**

- `GetEntriesSinceCursor(int cursor, int limit, LogType? filter, string search)` — returns entries where `id > cursor`, oldest first, up to `limit`
- `GetRecentEntries(int limit, LogType? filter, string search)` — returns last N entries, most recent first
- `GetCurrentCursor()` — returns the latest entry id (agent can "start fresh" without reading history)

### ClaudeLogHandler.cs

Registers two bridge actions via `ClaudeBridgeBase.RegisterAction`:

**Action: `get_logs`** (cursor-based pull)

Request payload:
```json
{ "cursor": 0, "limit": 100, "filter": "Error", "search": "NullReference" }
```
All fields optional. Without `cursor`, returns current cursor + zero entries (subscribe from now). With `cursor: 0`, returns buffered history.

**Action: `get_console`** (snapshot)

Request payload:
```json
{ "limit": 100, "filter": "Error", "search": "NullReference" }
```
All fields optional.

**Shared response shape** (written to bridge status):
```json
{
    "entries": [
        {
            "id": 42,
            "type": "Error",
            "message": "NullReferenceException: Object reference not set...",
            "stackTrace": "at PlayerController.Update() in Assets/Scripts/PlayerController.cs:47",
            "timestamp": 1.23
        }
    ],
    "nextCursor": 42,
    "totalBuffered": 156,
    "dropped": 0
}
```

- `nextCursor`: pass this back in the next `get_logs` call to continue from where you left off
- `totalBuffered`: total entries currently in the ring buffer
- `dropped`: entries lost to ring buffer wrap since the provided cursor (lets agent know if it missed something)

## TypeScript Side

### MCP Tools (server.ts)

**`unity_logs`** — cursor-based incremental pull
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| projectPath | string | yes | — | Unity project path |
| cursor | number | no | — | Resume from this cursor. Omit to subscribe from now. Pass 0 for history. |
| limit | number | no | 100 | Max entries to return (1-100) |
| filter | enum | no | — | Log, Warning, Error, Exception |
| search | string | no | — | Text search within message and stackTrace |

**`unity_console`** — snapshot of recent console
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| projectPath | string | yes | — | Unity project path |
| limit | number | no | 100 | Max entries to return (1-100) |
| filter | enum | no | — | Log, Warning, Error, Exception |
| search | string | no | — | Text search within message and stackTrace |

### Core Modules

**`src/core/logs.ts`** — validates params, calls `sendBridgeRequest(projectPath, "get_logs", { payload })`, formats response.

**`src/core/console.ts`** — validates params, calls `sendBridgeRequest(projectPath, "get_console", { payload })`, formats response.

### Bridge Types (src/lib/bridge/types.ts)

```typescript
interface LogEntry {
    id: number;
    type: "Log" | "Warning" | "Error" | "Exception" | "Assert";
    message: string;
    stackTrace: string;
    timestamp: number;
}

interface LogsResponse {
    entries: LogEntry[];
    nextCursor: number;
    totalBuffered: number;
    dropped: number;
}
```

### Output Formatting

Entries formatted as human-readable lines for the agent:
```
[Error] NullReferenceException: Object reference not set... (id:42, +1.23s)
  at PlayerController.Update() in Assets/Scripts/PlayerController.cs:47

[Warning] Shader 'Custom/Water' has errors (id:43, +1.25s)
```

Followed by metadata:
```
Cursor: 43 | Buffered: 156 | Dropped: 0
```

## Config & Integration

### Bridge Updates

- `src/lib/config.ts`: add `ClaudeLogCollector.cs` and `ClaudeLogHandler.cs` to template file list
- `src/lib/bridge/install.ts`: files auto-install with existing idempotent pattern
- Bridge version bump to reflect new C# files

### No Hook Changes

Logs tools are on-demand only. No post-turn hook integration needed.

## Testing

### Unit Tests

- `__tests__/core/logs.test.ts` — mock bridge responses, verify param validation, cursor handling, output formatting
- `__tests__/core/console.test.ts` — mock bridge responses, verify param validation, snapshot ordering, output formatting
- Cursor edge cases: first call without cursor, subsequent calls with cursor, dropped entries detection, cursor: 0 for history

### E2E Tests

- New e2e phase: send `get_logs`/`get_console` through real bridge
- Verify log capture: trigger a `Debug.Log` via recompile side effect, then read it back
- Verify filtering by level and search text

## Version

Increment plugin version in `marketplace.json`.
