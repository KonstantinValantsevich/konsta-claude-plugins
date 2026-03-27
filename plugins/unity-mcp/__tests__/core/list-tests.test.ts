import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/lib/bridge/ipc.js", () => ({
  generateRequestId: () => "mock-list-req-id",
  writeBridgeRequest: vi.fn(),
  waitForBridgeStatus: vi.fn(),
  sleep: vi.fn(),
  bridgeReadyMatchesProject: vi.fn(() => true),
  readBridgeStatus: vi.fn(),
}));

vi.mock("../../src/lib/bridge/launch.js", () => ({
  ensureUnityRunning: vi.fn().mockResolvedValue(false),
}));

import { listTests } from "../../src/core/list-tests.js";
import { waitForBridgeStatus } from "../../src/lib/bridge/ipc.js";
import { ensureUnityRunning } from "../../src/lib/bridge/launch.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

describe("listTests", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-tests-proj-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "Library", "ClaudeHookIPC"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("throws when Unity cannot be launched", async () => {
    vi.mocked(ensureUnityRunning).mockRejectedValue(
      new Error("unity_launch_failed: Unity process did not appear within 30s."),
    );
    await expect(
      listTests({ projectPath: projectDir }),
    ).rejects.toThrow("unity_launch_failed");
  });

  it("returns error on timeout", async () => {
    vi.mocked(waitForBridgeStatus).mockResolvedValue(null);
    const result = await listTests({ projectPath: projectDir });
    expect(result.formatted).toContain("Timed out");
  });

  it("returns error on bridge failure", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-list-req-id",
      bridgeVersion: "5",
      projectPath: projectDir,
      state: "failed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: false,
      errors: [],
      summary: "Something broke",
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);
    const result = await listTests({ projectPath: projectDir });
    expect(result.formatted).toContain("Bridge returned no test list.");
  });

  it("formats unfiltered test list grouped by assembly", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-list-req-id",
      bridgeVersion: "5",
      projectPath: projectDir,
      state: "list_tests_finished",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "3 test(s) matched out of 3 total",
      testList: {
        totalCount: 3,
        matchedCount: 3,
        tests: [
          { fullName: "NS.FixtureA.Test1", name: "Test1", categories: ["CatA"], assembly: "Assembly.Tests" },
          { fullName: "NS.FixtureA.Test2", name: "Test2", categories: ["CatA", "CatB"], assembly: "Assembly.Tests" },
          { fullName: "Other.FixtureB.Test3", name: "Test3", categories: [], assembly: "Other.Tests" },
        ],
      },
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await listTests({ projectPath: projectDir });
    expect(result.totalCount).toBe(3);
    expect(result.matchedCount).toBe(3);
    expect(result.formatted).toContain("Available EditMode tests (3 total)");
    expect(result.formatted).toContain("Assembly.Tests");
    expect(result.formatted).toContain("NS.FixtureA.Test1 [CatA]");
    expect(result.formatted).toContain("NS.FixtureA.Test2 [CatA, CatB]");
    expect(result.formatted).toContain("Other.Tests");
    expect(result.formatted).toContain("Other.FixtureB.Test3");
    expect(result.formatted).not.toContain("Test3 [");
  });

  it("formats filtered test list with filter description", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-list-req-id",
      bridgeVersion: "5",
      projectPath: projectDir,
      state: "list_tests_finished",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "2 test(s) matched out of 5 total",
      testList: {
        totalCount: 5,
        matchedCount: 2,
        tests: [
          { fullName: "NS.FixtureA.Test1", name: "Test1", categories: ["CatA"], assembly: "Assembly.Tests" },
          { fullName: "NS.FixtureA.Test2", name: "Test2", categories: ["CatA"], assembly: "Assembly.Tests" },
        ],
      },
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await listTests({ projectPath: projectDir, categoryNames: ["CatA"] });
    expect(result.totalCount).toBe(5);
    expect(result.matchedCount).toBe(2);
    expect(result.formatted).toContain("Matched 2 of 5 EditMode tests");
    expect(result.formatted).toContain("categoryNames");
  });

  it("returns empty list message when no tests found", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-list-req-id",
      bridgeVersion: "5",
      projectPath: projectDir,
      state: "list_tests_finished",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "0 test(s) matched out of 0 total",
      testList: { totalCount: 0, matchedCount: 0, tests: [] },
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await listTests({ projectPath: projectDir });
    expect(result.formatted).toContain("No EditMode tests found");
  });
});
