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

  it("returns recent entries as snapshot using get_console action", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: {
          entries: [
            { id: 1, type: "Log", message: "Game started", stackTrace: "", timestamp: 0.1 },
            { id: 2, type: "Warning", message: "Low memory", stackTrace: "at MemMgr.Check()", timestamp: 1.5 },
          ],
          nextCursor: 3,
          totalBuffered: 2,
          dropped: 0,
        },
      }),
    });

    const result = await getConsole({ projectPath: projectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(2);
      expect(result.formatted).toContain("[Log] Game started");
      expect(result.formatted).toContain("[Warning] Low memory");
      expect(result.formatted).toContain("at MemMgr.Check()");
      expect(result.formatted).toContain("Cursor:");
    }

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    expect(call[1]).toBe("get_console");
  });

  it("clamps limit to 100 max", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
      }),
    });

    await getConsole({ projectPath: projectDir, limit: 9999 });

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

    await getConsole({ projectPath: projectDir, limit: -5 });

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

    await getConsole({ projectPath: projectDir, filter: "Warning", search: "memory" });

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload.filter).toBe("Warning");
    expect(payload.search).toBe("memory");
  });

  it("returns error on bridge failure", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: false,
      error: "unity_not_running",
      message: "Unity is not running",
    });

    const result = await getConsole({ projectPath: projectDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unity is not running");
    }
  });

  it("returns empty formatted output when no entries (still has Cursor line)", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
      }),
    });

    const result = await getConsole({ projectPath: projectDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
      expect(result.formatted).toBe("Cursor: 0 | Buffered: 0 | Dropped: 0");
    }
  });

  it("does not include cursor in payload (snapshot mode)", async () => {
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: true,
      status: makeStatus({
        logsResponse: { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 },
      }),
    });

    await getConsole({ projectPath: projectDir });

    const call = vi.mocked(sendBridgeRequest).mock.calls[0];
    const payload = call[2]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("cursor");
  });
});
