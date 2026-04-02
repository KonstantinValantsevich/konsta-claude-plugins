# Unity Logs Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `unity_logs` (cursor-based incremental pull) and `unity_console` (snapshot) MCP tools that expose Unity Console log entries to the agent.

**Architecture:** Two new C# files (ClaudeLogCollector.cs for thread-safe ring buffer, ClaudeLogHandler.cs for bridge action dispatch) and two new TypeScript core modules (logs.ts, console.ts) following the existing search/test patterns. The bridge IPC layer carries log data as a JSON string field on StatusPayload, parsed on the TS side.

**Tech Stack:** C# (Unity Editor API), TypeScript, Zod, Vitest

---

### Task 1: Bridge Types — Add Log Types and Expand BridgeAction

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/types.ts`

- [ ] **Step 1: Add LogsPayload, LogEntry, LogsResponse types and expand BridgeAction**

Add these types to `plugins/unity-mcp/src/lib/bridge/types.ts`:

```typescript
/** Payload for get_logs bridge action */
export interface LogsPayload {
  cursor?: number;
  limit: number;
  filter?: string;
  search?: string;
}

/** Payload for get_console bridge action */
export interface ConsolePayload {
  limit: number;
  filter?: string;
  search?: string;
}

/** A single log entry returned by get_logs / get_console */
export interface LogEntry {
  id: number;
  type: "Log" | "Warning" | "Error" | "Exception" | "Assert";
  message: string;
  stackTrace: string;
  timestamp: number;
}

/** Response shape for get_logs and get_console */
export interface LogsResponse {
  entries: LogEntry[];
  nextCursor: number;
  totalBuffered: number;
  dropped: number;
}
```

Update the `BridgeAction` type:

```typescript
export type BridgeAction = "recompile" | "run_tests" | "list_tests" | "search_assets" | "get_logs" | "get_console";
```

Add `logsResponse` to the `BridgeStatus` interface (alongside `searchResults`):

```typescript
logsResponse?: LogsResponse;
```

Update the `BridgeRequest.payload` type to include the new payload types:

```typescript
payload?: TestDiscoveryFilters | SearchPayload | LogsPayload | ConsolePayload;
```

- [ ] **Step 2: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```
git add plugins/unity-mcp/src/lib/bridge/types.ts
git commit -m "feat(logs): add LogEntry, LogsResponse, LogsPayload types and expand BridgeAction"
```

---

### Task 2: IPC Layer — Parse logsResponse from Bridge Status

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/ipc.ts`

- [ ] **Step 1: Add logsResponse parsing to readBridgeStatus**

In `readBridgeStatus` in `plugins/unity-mcp/src/lib/bridge/ipc.ts`, add a block after the `searchResults` parsing (around line 63):

```typescript
// Parse logsResponse — dedicated wire field from ClaudeLogHandler
if (typeof raw.logsResponse === "string" && raw.logsResponse) {
  try {
    raw.logsResponse = JSON.parse(raw.logsResponse as string);
  } catch {
    // Leave as-is if parsing fails
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```
git add plugins/unity-mcp/src/lib/bridge/ipc.ts
git commit -m "feat(logs): parse logsResponse string field in readBridgeStatus"
```

---

### Task 3: Bridge Request — Add Reason Strings for Log Actions

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/request.ts`

- [ ] **Step 1: Update reasonForAction to handle get_logs and get_console**

In `plugins/unity-mcp/src/lib/bridge/request.ts`, update the `reasonForAction` function:

```typescript
function reasonForAction(action: BridgeAction | "bootstrap_handshake"): string {
  if (action === "bootstrap_handshake") return "bridge bootstrap handshake";
  if (action === "search_assets") return "unity_search_assets MCP resource";
  if (action === "get_logs") return "unity_logs MCP tool";
  if (action === "get_console") return "unity_console MCP tool";
  return `unity_${action} MCP tool`;
}
```

Also update the import to include the new payload types:

```typescript
import type { BridgeAction, BridgeRequest, BridgeResult, SearchPayload, LogsPayload, ConsolePayload } from "./types.js";
```

And update the `opts` parameter type in `sendBridgeRequest` and `sendRawRequest`:

```typescript
opts?: {
  payload?: TestDiscoveryFilters | SearchPayload | LogsPayload | ConsolePayload;
  timeoutMs?: number;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```
git add plugins/unity-mcp/src/lib/bridge/request.ts
git commit -m "feat(logs): add reason strings and payload types for log bridge actions"
```

---

### Task 4: Core Module — logs.ts (cursor-based pull)

**Files:**
- Create: `plugins/unity-mcp/src/core/logs.ts`
- Test: `plugins/unity-mcp/__tests__/core/logs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/unity-mcp/__tests__/core/logs.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/lib/bridge/request.js", () => ({
  sendBridgeRequest: vi.fn(),
}));

import { getLogs } from "../../src/core/logs.js";
import { sendBridgeRequest } from "../../src/lib/bridge/request.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

describe("getLogs", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-proj-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("subscribes from now when cursor is omitted", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: {
        entries: [],
        nextCursor: 42,
        totalBuffered: 42,
        dropped: 0,
      },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    const result = await getLogs({ projectPath: projectDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
      expect(result.nextCursor).toBe(42);
      expect(result.formatted).toContain("Cursor: 42");
    }

    // Verify no cursor was sent in the payload
    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    expect(call[1]).toBe("get_logs");
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.cursor).toBeUndefined();
  });

  it("passes cursor when provided", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: {
        entries: [
          { id: 43, type: "Error", message: "NullReferenceException: Object reference not set", stackTrace: "at Foo.Bar() in Assets/Foo.cs:10", timestamp: 1.23 },
        ],
        nextCursor: 43,
        totalBuffered: 50,
        dropped: 0,
      },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    const result = await getLogs({ projectPath: projectDir, cursor: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(1);
      expect(result.nextCursor).toBe(43);
      expect(result.formatted).toContain("[Error]");
      expect(result.formatted).toContain("NullReferenceException");
      expect(result.formatted).toContain("at Foo.Bar() in Assets/Foo.cs:10");
      expect(result.formatted).toContain("Cursor: 43");
    }

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.cursor).toBe(42);
  });

  it("clamps limit to 1-100 range", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    await getLogs({ projectPath: projectDir, limit: 9999 });
    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.limit).toBe(100);
  });

  it("passes filter and search params", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    await getLogs({ projectPath: projectDir, filter: "Error", search: "Null" });
    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.filter).toBe("Error");
    expect(payload.search).toBe("Null");
  });

  it("returns error on bridge failure", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: false,
      error: "request_timeout",
      message: "Timed out waiting for bridge response (get_logs).",
    });

    const result = await getLogs({ projectPath: projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Timed out");
    }
  });

  it("shows dropped count in formatted output when entries were dropped", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: {
        entries: [
          { id: 1050, type: "Log", message: "Hello", stackTrace: "", timestamp: 5.0 },
        ],
        nextCursor: 1050,
        totalBuffered: 1000,
        dropped: 50,
      },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    const result = await getLogs({ projectPath: projectDir, cursor: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.formatted).toContain("Dropped: 50");
    }
  });

  it("formats entries with type prefix and timestamp", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: {
        entries: [
          { id: 1, type: "Warning", message: "Shader 'Custom/Water' has errors", stackTrace: "", timestamp: 2.5 },
          { id: 2, type: "Log", message: "Game started", stackTrace: "", timestamp: 3.0 },
        ],
        nextCursor: 2,
        totalBuffered: 2,
        dropped: 0,
      },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    const result = await getLogs({ projectPath: projectDir, cursor: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.formatted).toContain("[Warning] Shader 'Custom/Water' has errors (id:1, +2.50s)");
      expect(result.formatted).toContain("[Log] Game started (id:2, +3.00s)");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/logs.test.ts`
Expected: FAIL — module `../../src/core/logs.js` not found

- [ ] **Step 3: Write the implementation**

Create `plugins/unity-mcp/src/core/logs.ts`:

```typescript
import { sendBridgeRequest } from "../lib/bridge/request.js";
import type { LogsPayload, LogEntry, LogsResponse } from "../lib/bridge/types.js";
import type { Logger } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export interface GetLogsOptions {
  projectPath: string;
  cursor?: number;
  limit?: number;
  filter?: string;
  search?: string;
  logger?: Logger;
}

export type GetLogsResult =
  | { ok: true; entries: LogEntry[]; nextCursor: number; totalBuffered: number; dropped: number; formatted: string }
  | { ok: false; error: string };

export function formatLogEntries(response: LogsResponse): string {
  const lines: string[] = [];

  for (const entry of response.entries) {
    const ts = `+${entry.timestamp.toFixed(2)}s`;
    lines.push(`[${entry.type}] ${entry.message} (id:${entry.id}, ${ts})`);
    if (entry.stackTrace) {
      lines.push(`  ${entry.stackTrace}`);
    }
  }

  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(`Cursor: ${response.nextCursor} | Buffered: ${response.totalBuffered} | Dropped: ${response.dropped}`);

  return lines.join("\n");
}

export async function getLogs(opts: GetLogsOptions): Promise<GetLogsResult> {
  const logger = opts.logger ?? noopLogger;
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const payload: LogsPayload = { limit };
  if (opts.cursor !== undefined) payload.cursor = opts.cursor;
  if (opts.filter) payload.filter = opts.filter;
  if (opts.search) payload.search = opts.search;

  const result = await sendBridgeRequest(opts.projectPath, "get_logs", { payload });
  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const { status } = result;
  logger.log("get_logs request completed");

  if (!status.isSuccess) {
    return { ok: false, error: status.summary || "get_logs failed" };
  }

  const response = status.logsResponse ?? { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 };
  return {
    ok: true,
    entries: response.entries,
    nextCursor: response.nextCursor,
    totalBuffered: response.totalBuffered,
    dropped: response.dropped,
    formatted: formatLogEntries(response),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/logs.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```
git add plugins/unity-mcp/src/core/logs.ts plugins/unity-mcp/__tests__/core/logs.test.ts
git commit -m "feat(logs): add getLogs core module with cursor-based pull and unit tests"
```

---

### Task 5: Core Module — console.ts (snapshot)

**Files:**
- Create: `plugins/unity-mcp/src/core/console.ts`
- Test: `plugins/unity-mcp/__tests__/core/console.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `plugins/unity-mcp/__tests__/core/console.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/lib/bridge/request.js", () => ({
  sendBridgeRequest: vi.fn(),
}));

import { getConsole } from "../../src/core/console.js";
import { sendBridgeRequest } from "../../src/lib/bridge/request.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

describe("getConsole", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-proj-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns recent entries as snapshot", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: {
        entries: [
          { id: 10, type: "Error", message: "NullRef", stackTrace: "at Foo.cs:5", timestamp: 1.0 },
          { id: 9, type: "Log", message: "Started", stackTrace: "", timestamp: 0.5 },
        ],
        nextCursor: 10,
        totalBuffered: 10,
        dropped: 0,
      },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    const result = await getConsole({ projectPath: projectDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(2);
      expect(result.formatted).toContain("[Error] NullRef");
      expect(result.formatted).toContain("[Log] Started");
    }

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    expect(call[1]).toBe("get_console");
  });

  it("clamps limit to 1-100 range", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    await getConsole({ projectPath: projectDir, limit: 500 });
    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.limit).toBe(100);
  });

  it("passes filter and search params", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    await getConsole({ projectPath: projectDir, filter: "Warning", search: "shader" });
    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.filter).toBe("Warning");
    expect(payload.search).toBe("shader");
  });

  it("returns error on bridge failure", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: false,
      error: "request_timeout",
      message: "Timed out waiting for bridge response (get_console).",
    });

    const result = await getConsole({ projectPath: projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Timed out");
    }
  });

  it("returns empty formatted output when no entries", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "",
      logsResponse: { entries: [], nextCursor: 5, totalBuffered: 5, dropped: 0 },
    };
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    const result = await getConsole({ projectPath: projectDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
      expect(result.formatted).toContain("Cursor: 5");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/console.test.ts`
Expected: FAIL — module `../../src/core/console.js` not found

- [ ] **Step 3: Write the implementation**

Create `plugins/unity-mcp/src/core/console.ts`:

```typescript
import { sendBridgeRequest } from "../lib/bridge/request.js";
import type { ConsolePayload, LogEntry, LogsResponse } from "../lib/bridge/types.js";
import { formatLogEntries } from "./logs.js";
import type { Logger } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export interface GetConsoleOptions {
  projectPath: string;
  limit?: number;
  filter?: string;
  search?: string;
  logger?: Logger;
}

export type GetConsoleResult =
  | { ok: true; entries: LogEntry[]; nextCursor: number; totalBuffered: number; dropped: number; formatted: string }
  | { ok: false; error: string };

export async function getConsole(opts: GetConsoleOptions): Promise<GetConsoleResult> {
  const logger = opts.logger ?? noopLogger;
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const payload: ConsolePayload = { limit };
  if (opts.filter) payload.filter = opts.filter;
  if (opts.search) payload.search = opts.search;

  const result = await sendBridgeRequest(opts.projectPath, "get_console", { payload });
  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const { status } = result;
  logger.log("get_console request completed");

  if (!status.isSuccess) {
    return { ok: false, error: status.summary || "get_console failed" };
  }

  const response = status.logsResponse ?? { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 };
  return {
    ok: true,
    entries: response.entries,
    nextCursor: response.nextCursor,
    totalBuffered: response.totalBuffered,
    dropped: response.dropped,
    formatted: formatLogEntries(response),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/console.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```
git add plugins/unity-mcp/src/core/console.ts plugins/unity-mcp/__tests__/core/console.test.ts
git commit -m "feat(logs): add getConsole core module with snapshot retrieval and unit tests"
```

---

### Task 6: MCP Server — Register unity_logs and unity_console Tools

**Files:**
- Modify: `plugins/unity-mcp/src/mcp/server.ts`

- [ ] **Step 1: Add imports for getLogs and getConsole**

At the top of `plugins/unity-mcp/src/mcp/server.ts`, add after the existing imports (around line 10):

```typescript
import { getLogs } from "../core/logs.js";
import { getConsole } from "../core/console.js";
```

- [ ] **Step 2: Register unity_logs tool**

Add before the `return server;` line (around line 283) in `plugins/unity-mcp/src/mcp/server.ts`:

```typescript
  server.tool(
    "unity_logs",
    "Pull Unity Console log entries incrementally using a cursor. First call without cursor subscribes from now (returns current cursor, zero entries). Subsequent calls with cursor return new entries since that cursor. Pass cursor 0 to get buffered history.",
    {
      projectPath: z.string().describe("Unity project root path"),
      cursor: z.number().optional().describe("Resume from this cursor. Omit to subscribe from now. Pass 0 for history."),
      limit: z.number().optional().describe("Max entries to return (1-100, default 100)"),
      filter: z.enum(["Log", "Warning", "Error", "Exception"]).optional().describe("Filter by log type"),
      search: z.string().optional().describe("Text search within message and stackTrace"),
    },
    async ({ projectPath, cursor, limit, filter, search }) => {
      const result = await getLogs({ projectPath, cursor, limit, filter, search, logger: stderrLogger });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Log retrieval failed: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: result.formatted }],
      };
    },
  );
```

- [ ] **Step 3: Register unity_console tool**

Add after the `unity_logs` registration:

```typescript
  server.tool(
    "unity_console",
    "Snapshot of recent Unity Console entries — returns the most recent entries, mirroring what's currently visible in the Unity Console window.",
    {
      projectPath: z.string().describe("Unity project root path"),
      limit: z.number().optional().describe("Max entries to return (1-100, default 100)"),
      filter: z.enum(["Log", "Warning", "Error", "Exception"]).optional().describe("Filter by log type"),
      search: z.string().optional().describe("Text search within message and stackTrace"),
    },
    async ({ projectPath, limit, filter, search }) => {
      const result = await getConsole({ projectPath, limit, filter, search, logger: stderrLogger });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Console retrieval failed: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: result.formatted }],
      };
    },
  );
```

- [ ] **Step 4: Verify types compile**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```
git add plugins/unity-mcp/src/mcp/server.ts
git commit -m "feat(logs): register unity_logs and unity_console MCP tools"
```

---

### Task 7: C# Template — ClaudeLogCollector.cs (Ring Buffer)

**Files:**
- Create: `plugins/unity-mcp/templates/ClaudeLogCollector.cs`

- [ ] **Step 1: Write ClaudeLogCollector.cs**

Create `plugins/unity-mcp/templates/ClaudeLogCollector.cs`:

```csharp
// ClaudeLogCollector Version: 1
using System;
using System.Collections.Generic;
using UnityEngine;

internal static class ClaudeLogCollector
{
    private const int BufferCapacity = 1000;

    [Serializable]
    internal class LogEntry
    {
        public int id;
        public string type;
        public string message;
        public string stackTrace;
        public double timestamp;
    }

    [Serializable]
    internal class LogsResponse
    {
        public List<LogEntry> entries;
        public int nextCursor;
        public int totalBuffered;
        public int dropped;
    }

    private static readonly object Sync = new object();
    private static readonly LogEntry[] Buffer = new LogEntry[BufferCapacity];
    private static int _head;       // next write index (wraps)
    private static int _count;      // entries currently in buffer (max BufferCapacity)
    private static int _nextId = 1; // monotonically increasing

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    private static void ResetStatics()
    {
        // Domain reload safety — clear state
        lock (Sync)
        {
            Array.Clear(Buffer, 0, BufferCapacity);
            _head = 0;
            _count = 0;
            _nextId = 1;
        }
    }

    internal static void Initialize()
    {
        Application.logMessageReceivedThreaded -= OnLogMessageReceived;
        Application.logMessageReceivedThreaded += OnLogMessageReceived;
    }

    private static void OnLogMessageReceived(string message, string stackTrace, LogType logType)
    {
        lock (Sync)
        {
            var entry = new LogEntry
            {
                id = _nextId++,
                type = LogTypeToString(logType),
                message = message ?? string.Empty,
                stackTrace = stackTrace ?? string.Empty,
                timestamp = EditorApplication.timeSinceStartup,
            };

            Buffer[_head] = entry;
            _head = (_head + 1) % BufferCapacity;
            if (_count < BufferCapacity) _count++;
        }
    }

    /// <summary>
    /// Get entries where id > cursor, oldest first, up to limit.
    /// </summary>
    internal static LogsResponse GetEntriesSinceCursor(int cursor, int limit, string filter, string search)
    {
        lock (Sync)
        {
            var entries = new List<LogEntry>();
            int dropped = 0;

            if (_count == 0)
                return new LogsResponse { entries = entries, nextCursor = _nextId - 1, totalBuffered = 0, dropped = 0 };

            // Oldest entry in buffer
            int oldestIndex = _count < BufferCapacity ? 0 : _head;
            int oldestId = Buffer[oldestIndex].id;

            // Calculate dropped: entries that existed after cursor but fell off the buffer
            if (cursor > 0 && cursor < oldestId - 1)
                dropped = oldestId - 1 - cursor;

            // Walk buffer from oldest to newest
            for (int i = 0; i < _count && entries.Count < limit; i++)
            {
                int idx = (oldestIndex + i) % BufferCapacity;
                var entry = Buffer[idx];
                if (entry == null) continue;
                if (entry.id <= cursor) continue;
                if (!MatchesFilter(entry, filter, search)) continue;
                entries.Add(entry);
            }

            int lastId = entries.Count > 0 ? entries[entries.Count - 1].id : (_nextId - 1);
            return new LogsResponse
            {
                entries = entries,
                nextCursor = lastId,
                totalBuffered = _count,
                dropped = dropped,
            };
        }
    }

    /// <summary>
    /// Get last N entries, most recent first, then reverse to match oldest-first output.
    /// </summary>
    internal static LogsResponse GetRecentEntries(int limit, string filter, string search)
    {
        lock (Sync)
        {
            var entries = new List<LogEntry>();

            if (_count == 0)
                return new LogsResponse { entries = entries, nextCursor = 0, totalBuffered = 0, dropped = 0 };

            // Walk backward from newest
            for (int i = _count - 1; i >= 0 && entries.Count < limit; i--)
            {
                int idx = (_count < BufferCapacity ? i : (_head - 1 - (_count - 1 - i) + BufferCapacity) % BufferCapacity);
                var entry = Buffer[idx];
                if (entry == null) continue;
                if (!MatchesFilter(entry, filter, search)) continue;
                entries.Add(entry);
            }

            // Reverse so output is oldest-first (most recent last)
            entries.Reverse();

            int lastId = entries.Count > 0 ? entries[entries.Count - 1].id : (_nextId - 1);
            return new LogsResponse
            {
                entries = entries,
                nextCursor = lastId,
                totalBuffered = _count,
                dropped = 0,
            };
        }
    }

    /// <summary>
    /// Returns the latest entry id (agent can "start fresh" without reading history).
    /// </summary>
    internal static int GetCurrentCursor()
    {
        lock (Sync)
        {
            return _nextId - 1;
        }
    }

    private static bool MatchesFilter(LogEntry entry, string filter, string search)
    {
        if (!string.IsNullOrEmpty(filter) && !string.Equals(entry.type, filter, StringComparison.OrdinalIgnoreCase))
            return false;
        if (!string.IsNullOrEmpty(search))
        {
            bool inMessage = entry.message != null && entry.message.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
            bool inStack = entry.stackTrace != null && entry.stackTrace.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
            if (!inMessage && !inStack) return false;
        }
        return true;
    }

    private static string LogTypeToString(LogType type)
    {
        switch (type)
        {
            case LogType.Error: return "Error";
            case LogType.Warning: return "Warning";
            case LogType.Log: return "Log";
            case LogType.Exception: return "Exception";
            case LogType.Assert: return "Assert";
            default: return "Log";
        }
    }
}
```

Note: `EditorApplication.timeSinceStartup` requires `using UnityEditor;` — add it to the using block:

Add `using UnityEditor;` after `using UnityEngine;`.

- [ ] **Step 2: Commit**

```
git add plugins/unity-mcp/templates/ClaudeLogCollector.cs
git commit -m "feat(logs): add ClaudeLogCollector.cs C# template with thread-safe ring buffer"
```

---

### Task 8: C# Template — ClaudeLogHandler.cs (Bridge Actions)

**Files:**
- Create: `plugins/unity-mcp/templates/ClaudeLogHandler.cs`

- [ ] **Step 1: Write ClaudeLogHandler.cs**

Create `plugins/unity-mcp/templates/ClaudeLogHandler.cs`:

```csharp
// ClaudeLogHandler Version: 1
using System;
using UnityEngine;

internal static class ClaudeLogHandler
{
    [Serializable]
    private class LogRequestPayload
    {
        public int cursor = -1;
        public int limit = 100;
        public string filter;
        public string search;
    }

    internal static void Register()
    {
        ClaudeBridgeBase.RegisterAction("get_logs", HandleGetLogs);
        ClaudeBridgeBase.RegisterAction("get_console", HandleGetConsole);
    }

    private static void HandleGetLogs(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);

        try
        {
            var payload = new LogRequestPayload();
            if (!string.IsNullOrEmpty(request.payload))
                payload = JsonUtility.FromJson<LogRequestPayload>(request.payload);

            int limit = Mathf.Clamp(payload.limit, 1, 100);

            ClaudeLogCollector.LogsResponse response;
            if (payload.cursor < 0)
            {
                // No cursor provided — subscribe from now (return current cursor, zero entries)
                int currentCursor = ClaudeLogCollector.GetCurrentCursor();
                response = new ClaudeLogCollector.LogsResponse
                {
                    entries = new System.Collections.Generic.List<ClaudeLogCollector.LogEntry>(),
                    nextCursor = currentCursor,
                    totalBuffered = 0,
                    dropped = 0,
                };
            }
            else
            {
                response = ClaudeLogCollector.GetEntriesSinceCursor(payload.cursor, limit, payload.filter, payload.search);
            }

            string json = JsonUtility.ToJson(response);
            ClaudeBridgeBase.WriteLogsStatus(request, "completed", true, response.entries.Count + " log entry(ies)", json);
        }
        catch (Exception ex)
        {
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "get_logs failed: " + ex.Message);
        }
        finally
        {
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }

    private static void HandleGetConsole(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);

        try
        {
            var payload = new LogRequestPayload();
            if (!string.IsNullOrEmpty(request.payload))
                payload = JsonUtility.FromJson<LogRequestPayload>(request.payload);

            int limit = Mathf.Clamp(payload.limit, 1, 100);

            var response = ClaudeLogCollector.GetRecentEntries(limit, payload.filter, payload.search);

            string json = JsonUtility.ToJson(response);
            ClaudeBridgeBase.WriteLogsStatus(request, "completed", true, response.entries.Count + " log entry(ies)", json);
        }
        catch (Exception ex)
        {
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "get_console failed: " + ex.Message);
        }
        finally
        {
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }
}
```

- [ ] **Step 2: Commit**

```
git add plugins/unity-mcp/templates/ClaudeLogHandler.cs
git commit -m "feat(logs): add ClaudeLogHandler.cs C# template with get_logs and get_console actions"
```

---

### Task 9: Bridge Base — Add WriteLogsStatus and Register Handler

**Files:**
- Modify: `plugins/unity-mcp/templates/ClaudeBridgeBase.cs`

- [ ] **Step 1: Add `logsResponse` field to StatusPayload**

In `plugins/unity-mcp/templates/ClaudeBridgeBase.cs`, add to the `StatusPayload` class (after `searchResults` field, around line 58):

```csharp
public string logsResponse;
```

- [ ] **Step 2: Add WriteLogsStatus method**

Add after the `WriteSearchStatus` method (around line 182):

```csharp
    internal static void WriteLogsStatus(RequestPayload request, string state, bool isSuccess, string summary, string logsResponseJson)
    {
        if (request == null || string.IsNullOrEmpty(request.requestId))
            return;

        var payload = new StatusPayload
        {
            protocolVersion = ProtocolVersion,
            requestId = request.requestId,
            bridgeVersion = BridgeVersion,
            projectPath = ProjectPath,
            state = state,
            createdAtUnixMs = NowUnixMs(),
            updatedAtUnixMs = NowUnixMs(),
            didCompile = false,
            isSuccess = isSuccess,
            errors = new List<ErrorPayload>(),
            summary = summary ?? string.Empty,
            logsResponse = logsResponseJson,
        };

        string json = JsonUtility.ToJson(payload, true);
        string path = Path.Combine(IpcDir, "status-" + request.requestId + ".json");
        TryWriteJsonAtomic(path, json);
    }
```

- [ ] **Step 3: Register ClaudeLogHandler in the static constructor**

In the `static ClaudeBridgeBase()` constructor, add after `ClaudeSearchHandler.Register();` (around line 97):

```csharp
ClaudeLogCollector.Initialize();
ClaudeLogHandler.Register();
```

- [ ] **Step 4: Bump bridge version**

Update the version constant at the top of ClaudeBridgeBase.cs:

```csharp
// ClaudeBridgeBase Version: 5
```

And:

```csharp
private const string BridgeVersion = "5";
```

- [ ] **Step 5: Commit**

```
git add plugins/unity-mcp/templates/ClaudeBridgeBase.cs
git commit -m "feat(logs): add WriteLogsStatus to BridgeBase, register log collector and handler"
```

---

### Task 10: Config — Register New C# Files and Bump Bridge Version

**Files:**
- Modify: `plugins/unity-mcp/src/lib/config.ts`

- [ ] **Step 1: Add new files to BRIDGE_CS_FILES**

In `plugins/unity-mcp/src/lib/config.ts`, update `BRIDGE_CS_FILES` (around line 24):

```typescript
export const BRIDGE_CS_FILES = [
  "ClaudeBridgeBase.cs",
  "ClaudeRecompileHandler.cs",
  "ClaudeTestHandler.cs",
  "ClaudeSearchHandler.cs",
  "ClaudeLogCollector.cs",
  "ClaudeLogHandler.cs",
];
```

- [ ] **Step 2: Bump BRIDGE_VERSION**

Update (around line 6):

```typescript
export const BRIDGE_VERSION = "5";
```

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests PASS (existing + new)

- [ ] **Step 4: Commit**

```
git add plugins/unity-mcp/src/lib/config.ts
git commit -m "feat(logs): register log C# files in bridge config and bump bridge version to 5"
```

---

### Task 11: E2E Test — Log Tools

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/07-logs.test.ts`

- [ ] **Step 1: Write e2e test suite**

Create `plugins/unity-mcp/__tests__/e2e/07-logs.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import { simpleMonoBehaviour } from "./helpers/fixtures.js";

let mcp: McpTestClient;
let projectPath: string;

describe("Phase 07 — Logs", () => {
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;

    // Cross-phase isolation
    execSync("git reset --hard e2e-baseline && git clean -fd", {
      cwd: projectPath,
      stdio: "ignore",
    });

    mcp = await createMcpClient(projectPath);

    // Bootstrap bridge (installs new log C# files)
    await mcp.callTool("unity_recompile");
  }, 600_000);

  afterAll(async () => {
    if (mcp) await mcp.close();
  });

  it("test 27: unity_logs without cursor subscribes from now", async () => {
    const text = await mcp.callTool("unity_logs");

    // Should return a cursor line with no entries
    expect(text).toMatch(/Cursor: \d+/);
  });

  it("test 28: unity_console returns recent entries", async () => {
    // Trigger a recompile to generate log entries (recompile produces Debug.Log output)
    const fixtureDir = path.join(projectPath, "Assets", "LogFixture");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "LogTestComponent.cs"),
      simpleMonoBehaviour("LogTestComponent"),
    );
    await mcp.callTool("unity_recompile");

    const text = await mcp.callTool("unity_console");
    expect(text).toMatch(/Cursor: \d+/);
    expect(text).toMatch(/Buffered: \d+/);
  });

  it("test 29: unity_logs with cursor 0 returns history", async () => {
    const text = await mcp.callTool("unity_logs", { cursor: 0 });

    // Should have at least some log entries from bridge init / recompile
    expect(text).toMatch(/Cursor: \d+/);
    expect(text).toMatch(/Buffered: \d+/);
  });

  it("test 30: unity_logs cursor-based incremental pull", async () => {
    // First call: subscribe from now
    const text1 = await mcp.callTool("unity_logs");
    const cursorMatch = text1.match(/Cursor: (\d+)/);
    expect(cursorMatch).toBeTruthy();
    const cursor = parseInt(cursorMatch![1], 10);

    // Trigger activity to generate new logs
    const filePath = path.join(projectPath, "Assets", "LogFixture", "LogTestComponent2.cs");
    fs.writeFileSync(filePath, simpleMonoBehaviour("LogTestComponent2"));
    await mcp.callTool("unity_recompile");

    // Second call with cursor: should get new entries
    const text2 = await mcp.callTool("unity_logs", { cursor });
    expect(text2).toMatch(/Cursor: \d+/);
  });

  it("test 31: unity_console with filter returns filtered entries", async () => {
    const text = await mcp.callTool("unity_console", { filter: "Error" });
    expect(text).toMatch(/Cursor: \d+/);
    // If there are entries, they should all be [Error]
    const lines = text.split("\n").filter((l: string) => l.startsWith("["));
    for (const line of lines) {
      expect(line).toMatch(/^\[Error\]/);
    }
  });

  it("test 32: unity_console with search filters by text", async () => {
    const text = await mcp.callTool("unity_console", { search: "xyzzy_nonexistent_search_term" });
    expect(text).toMatch(/Cursor: \d+/);
    // Should have no entry lines (only the metadata line)
    const entryLines = text.split("\n").filter((l: string) => l.startsWith("["));
    expect(entryLines.length).toBe(0);
  });
});
```

- [ ] **Step 2: Commit**

```
git add plugins/unity-mcp/__tests__/e2e/07-logs.test.ts
git commit -m "test(logs): add e2e test suite for unity_logs and unity_console tools"
```

---

### Task 12: Build, Version Bump, and Final Verification

**Files:**
- Modify: `plugins/unity-mcp/package.json`

- [ ] **Step 1: Run all unit tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests PASS

- [ ] **Step 2: Build the bundle**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds, `dist/server.mjs` updated

- [ ] **Step 3: Bump version in package.json**

In `plugins/unity-mcp/package.json`, update:

```json
"version": "1.6.0"
```

- [ ] **Step 4: Final commit**

```
git add plugins/unity-mcp/package.json plugins/unity-mcp/dist/
git commit -m "chore: bump version to 1.6.0, rebuild dist for logs tools"
```

---

## Summary of Files

### Created
| File | Purpose |
|------|---------|
| `plugins/unity-mcp/templates/ClaudeLogCollector.cs` | Thread-safe ring buffer for Unity log entries |
| `plugins/unity-mcp/templates/ClaudeLogHandler.cs` | Bridge action handlers for get_logs / get_console |
| `plugins/unity-mcp/src/core/logs.ts` | Core module: cursor-based log pull |
| `plugins/unity-mcp/src/core/console.ts` | Core module: console snapshot |
| `plugins/unity-mcp/__tests__/core/logs.test.ts` | Unit tests for logs core module |
| `plugins/unity-mcp/__tests__/core/console.test.ts` | Unit tests for console core module |
| `plugins/unity-mcp/__tests__/e2e/07-logs.test.ts` | E2E tests for both tools |

### Modified
| File | Changes |
|------|---------|
| `plugins/unity-mcp/src/lib/bridge/types.ts` | Add LogEntry, LogsResponse, LogsPayload, ConsolePayload; expand BridgeAction; add logsResponse to BridgeStatus |
| `plugins/unity-mcp/src/lib/bridge/ipc.ts` | Parse logsResponse string field |
| `plugins/unity-mcp/src/lib/bridge/request.ts` | Add reason strings and payload types for log actions |
| `plugins/unity-mcp/src/mcp/server.ts` | Register unity_logs and unity_console tools |
| `plugins/unity-mcp/templates/ClaudeBridgeBase.cs` | Add logsResponse to StatusPayload, WriteLogsStatus method, register collector+handler, bump version to 5 |
| `plugins/unity-mcp/src/lib/config.ts` | Add log C# files to BRIDGE_CS_FILES, bump BRIDGE_VERSION to "5" |
| `plugins/unity-mcp/package.json` | Bump version to 1.6.0 |
