import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/lib/bridge/request.js", () => ({
  sendBridgeRequest: vi.fn(),
}));

import { getLogs, formatLogEntries } from "../../src/core/logs.js";
import { sendBridgeRequest } from "../../src/lib/bridge/request.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

function makeStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    protocolVersion: 1,
    requestId: "mock-req-id",
    bridgeVersion: "5",
    projectPath: "/tmp/proj",
    state: "completed",
    createdAtUnixMs: Date.now(),
    updatedAtUnixMs: Date.now(),
    didCompile: false,
    isSuccess: true,
    errors: [],
    summary: "completed",
    ...overrides,
  };
}

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

  it("subscribes from now when cursor is omitted (no cursor in payload)", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: { entries: [], nextCursor: 42, totalBuffered: 0, dropped: 0 },
      }),
    });

    const result = await getLogs({ projectPath: projectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
      expect(result.nextCursor).toBe(42);
    }

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    expect(call[1]).toBe("get_logs");
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("cursor");
  });

  it("passes cursor when provided and returns entries with formatted output", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: {
          entries: [
            {
              id: 7,
              type: "Error",
              message: "NullReferenceException",
              stackTrace: "at Foo.Bar () [0x00000]",
              timestamp: 5.5,
            },
          ],
          nextCursor: 8,
          totalBuffered: 10,
          dropped: 0,
        },
      }),
    });

    const result = await getLogs({ projectPath: projectDir, cursor: 5 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].type).toBe("Error");
      expect(result.formatted).toContain("[Error]");
      expect(result.formatted).toContain("NullReferenceException");
      expect(result.formatted).toContain("at Foo.Bar () [0x00000]");
      expect(result.formatted).toContain("Cursor:");
    }

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.cursor).toBe(5);
  });

  it("clamps limit to 100 max", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
      }),
    });

    await getLogs({ projectPath: projectDir, limit: 9999 });

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.limit).toBe(100);
  });

  it("clamps limit to minimum of 1", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
      }),
    });

    await getLogs({ projectPath: projectDir, limit: 0 });

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.limit).toBe(1);
  });

  it("passes filter and search params", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
      }),
    });

    await getLogs({ projectPath: projectDir, filter: "Error", search: "NullRef" });

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.filter).toBe("Error");
    expect(payload.search).toBe("NullRef");
  });

  it("returns error on bridge failure", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: false,
      error: "unity_not_running",
      message: "Unity is not running",
    });

    const result = await getLogs({ projectPath: projectDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unity is not running");
    }
  });

  it("returns error when isSuccess is false", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        isSuccess: false,
        summary: "get_logs failed: buffer overflow",
      }),
    });

    const result = await getLogs({ projectPath: projectDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("get_logs failed: buffer overflow");
    }
  });

  it("shows dropped count in formatted output when dropped > 0", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: {
          entries: [],
          nextCursor: 50,
          totalBuffered: 1000,
          dropped: 250,
        },
      }),
    });

    const result = await getLogs({ projectPath: projectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dropped).toBe(250);
      expect(result.formatted).toContain("Dropped: 250");
    }
  });

  it("formats entries with type prefix, message, id, timestamp, and stackTrace on next line", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: {
          entries: [
            {
              id: 3,
              type: "Warning",
              message: "Deprecated API usage",
              stackTrace: "at MyClass.MyMethod () [0x00001]",
              timestamp: 12.345,
            },
          ],
          nextCursor: 4,
          totalBuffered: 10,
          dropped: 0,
        },
      }),
    });

    const result = await getLogs({ projectPath: projectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.formatted).toContain("[Warning] Deprecated API usage (id:3, +12.35s)");
      expect(result.formatted).toContain("  at MyClass.MyMethod () [0x00001]");
      expect(result.formatted).toContain("Cursor: 4 | Buffered: 10 | Dropped: 0");
    }
  });
});

describe("formatLogEntries", () => {
  it("omits stack trace line when stackTrace is empty", () => {
    const formatted = formatLogEntries({
      entries: [
        { id: 1, type: "Log", message: "Hello", stackTrace: "", timestamp: 1.0 },
      ],
      nextCursor: 2,
      totalBuffered: 5,
      dropped: 0,
    });
    const lines = formatted.split("\n");
    expect(lines[0]).toBe("[Log] Hello (id:1, +1.00s)");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Cursor: 2 | Buffered: 5 | Dropped: 0");
  });

  it("returns only Cursor line when entries is empty", () => {
    const formatted = formatLogEntries({
      entries: [],
      nextCursor: 0,
      totalBuffered: 0,
      dropped: 0,
    });
    expect(formatted).toBe("Cursor: 0 | Buffered: 0 | Dropped: 0");
  });
});
