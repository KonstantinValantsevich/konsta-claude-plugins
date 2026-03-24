import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock the bridge dependencies
vi.mock("../../src/lib/bridge/ipc.js", () => ({
  generateRequestId: () => "mock-req-id",
  writeBridgeRequest: vi.fn(),
  waitForBridgeStatus: vi.fn(),
  sleep: vi.fn(),
  bridgeReadyMatchesProject: vi.fn(() => true),
  readBridgeStatus: vi.fn(),
}));

vi.mock("../../src/lib/compile/applescript.js", () => ({
  unityIsRunning: vi.fn(() => true),
}));

import { runTests } from "../../src/core/test.js";
import { waitForBridgeStatus } from "../../src/lib/bridge/ipc.js";
import { unityIsRunning } from "../../src/lib/compile/applescript.js";
import { loadLatestTestRun } from "../../src/lib/test-store.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

describe("runTests", () => {
  let projectDir: string;
  let storeDir: string;
  let markerDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-proj-"));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-store-"));
    markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-markers-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "Library", "ClaudeHookIPC"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(markerDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns error when Unity is not running", async () => {
    vi.mocked(unityIsRunning).mockReturnValue(false);
    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.formatted).toContain("Unity editor must be running");
  });

  it("stores results and returns run ID on success", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "tests_finished",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Tests completed",
      testResults: {
        totalCount: 1,
        passCount: 1,
        failCount: 0,
        skipCount: 0,
        inconclusiveCount: 0,
        duration: 0.5,
        tests: [
          { fullName: "NS.Test1", name: "Test1", status: "Passed", duration: 0.5, message: null, stackTrace: null, output: null },
        ],
      },
    };
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.runId).toBeTruthy();
    expect(result.formatted).toContain("1");

    // Verify stored
    const stored = loadLatestTestRun(storeDir);
    expect(stored?.results.passCount).toBe(1);
  });

  it("returns error on timeout", async () => {
    vi.mocked(waitForBridgeStatus).mockResolvedValue(null);
    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.formatted).toContain("Timed out");
  });
});
