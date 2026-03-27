import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BridgeResult } from "../types.js";

// Mock all external dependencies before importing the module under test
vi.mock("../launch.js", () => ({
  ensureUnityRunning: vi.fn(),
}));

vi.mock("../../compile/applescript.js", () => ({
  triggerEditorRefreshOnly: vi.fn(),
}));

vi.mock("../install.js", () => ({
  ensureBridgeInstalled: vi.fn(() => ({ changed: false })),
  ensureGitExclude: vi.fn(),
}));

vi.mock("../ipc.js", () => ({
  bridgeReadyMatchesProject: vi.fn(),
  generateRequestId: vi.fn(() => "test-req-001"),
  writeBridgeRequest: vi.fn(),
  waitForBridgeReady: vi.fn(),
  waitForBridgeStatus: vi.fn(),
}));

// Mock fs — only the methods sendBridgeRequest uses
vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

describe("sendBridgeRequest", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("throws when ensureUnityRunning fails", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("unity_launch_failed: Unity process did not appear within 30s."),
    );

    const { sendBridgeRequest } = await import("../request.js");
    await expect(sendBridgeRequest("/project", "list_tests")).rejects.toThrow(
      "unity_launch_failed",
    );
  });

  it("sends request and returns ok when bridge is ready", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    const { bridgeReadyMatchesProject, waitForBridgeStatus } = await import("../ipc.js");

    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (waitForBridgeStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocolVersion: 1,
      bridgeVersion: "4",
      requestId: "test-req-001",
      projectPath: "/project",
      state: "list_tests_finished",
      isSuccess: true,
      didCompile: false,
      errors: [],
      summary: "",
      testList: { totalCount: 5, matchedCount: 5, tests: [] },
    });

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "list_tests");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status.state).toBe("list_tests_finished");
    }
  });

  it("bootstraps when bridge is not ready", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    const { triggerEditorRefreshOnly } = await import("../../compile/applescript.js");
    const { bridgeReadyMatchesProject, waitForBridgeReady, waitForBridgeStatus } = await import("../ipc.js");

    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (waitForBridgeReady as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    // First call = handshake, second call = actual request
    (waitForBridgeStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        protocolVersion: 1, bridgeVersion: "4", requestId: "test-req-001",
        projectPath: "/project", state: "completed", isSuccess: true,
        didCompile: false, errors: [], summary: "",
      })
      .mockResolvedValueOnce({
        protocolVersion: 1, bridgeVersion: "4", requestId: "test-req-001",
        projectPath: "/project", state: "completed", isSuccess: true,
        didCompile: true, errors: [], summary: "",
      });

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    expect(triggerEditorRefreshOnly).toHaveBeenCalledWith("/project");
    expect(waitForBridgeReady).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("returns bridge_bootstrap_failed when readiness times out", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    const { bridgeReadyMatchesProject, waitForBridgeReady } = await import("../ipc.js");

    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (waitForBridgeReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    expect(result).toEqual({
      ok: false,
      error: "bridge_bootstrap_failed",
      message: "Bridge did not become ready after bootstrap refresh.",
    });
  });

  it("uses extended bootstrap timeout when Unity was freshly launched", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    const { bridgeReadyMatchesProject, waitForBridgeReady, waitForBridgeStatus } = await import("../ipc.js");

    // ensureUnityRunning returns true = freshly launched
    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (waitForBridgeReady as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    // Should have used the 300s launch timeout, not the default 120s
    expect(waitForBridgeReady).toHaveBeenCalledWith(
      expect.any(String),
      "/project",
      300_000,
    );
    expect(result).toEqual({
      ok: false,
      error: "bridge_bootstrap_failed",
      message: "Bridge did not become ready after bootstrap refresh.",
    });
  });

  it("returns request_timeout when status poll times out", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    const { bridgeReadyMatchesProject, waitForBridgeStatus } = await import("../ipc.js");

    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (waitForBridgeStatus as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "run_tests");

    expect(result).toEqual({
      ok: false,
      error: "request_timeout",
      message: "Timed out waiting for bridge response (run_tests).",
    });
  });

  it("returns version_mismatch when bridge version doesn't match", async () => {
    const { ensureUnityRunning } = await import("../launch.js");
    const { bridgeReadyMatchesProject, waitForBridgeStatus } = await import("../ipc.js");

    (ensureUnityRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (bridgeReadyMatchesProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (waitForBridgeStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      protocolVersion: 1, bridgeVersion: "99", requestId: "test-req-001",
      projectPath: "/project", state: "completed", isSuccess: true,
      didCompile: false, errors: [], summary: "",
    });

    const { sendBridgeRequest } = await import("../request.js");
    const result = await sendBridgeRequest("/project", "recompile");

    expect(result).toEqual({
      ok: false,
      error: "version_mismatch",
      message: "Bridge version mismatch (got version=99 protocol=1).",
    });
  });
});
