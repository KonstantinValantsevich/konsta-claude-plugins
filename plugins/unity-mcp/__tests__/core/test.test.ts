import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock recompile — called before test run
vi.mock("../../src/core/recompile.js", () => ({
  recompile: vi.fn(() => Promise.resolve({ success: true, skipped: true, errors: [] })),
}));

// Mock sendBridgeRequest — replaces old low-level bridge mocks
vi.mock("../../src/lib/bridge/request.js", () => ({
  sendBridgeRequest: vi.fn(),
}));

import { runTests } from "../../src/core/test.js";
import { recompile } from "../../src/core/recompile.js";
import { sendBridgeRequest } from "../../src/lib/bridge/request.js";
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
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(markerDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns error when recompile fails", async () => {
    vi.mocked(recompile).mockResolvedValue({
      success: false,
      skipped: false,
      errors: [{ assembly: "", file: "Foo.cs", line: 1, column: 1, message: "syntax error", type: "error" }],
    });
    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.formatted).toContain("Recompilation failed before test run");
    expect(result.formatted).toContain("syntax error");
  });

  it("stores results and returns run ID on success", async () => {
    vi.mocked(recompile).mockResolvedValue({ success: true, skipped: true, errors: [] });

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
    vi.mocked(sendBridgeRequest).mockResolvedValue({ ok: true, status: mockStatus });

    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.runId).toBeTruthy();
    expect(result.formatted).toContain("1");

    // Verify stored
    const stored = loadLatestTestRun(storeDir);
    expect(stored?.results.passCount).toBe(1);
  });

  it("returns error on bridge failure", async () => {
    vi.mocked(recompile).mockResolvedValue({ success: true, skipped: true, errors: [] });
    vi.mocked(sendBridgeRequest).mockResolvedValue({
      ok: false,
      error: "request_timeout",
      message: "Timed out waiting for bridge response (run_tests).",
    });
    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.formatted).toContain("Timed out");
  });
});
