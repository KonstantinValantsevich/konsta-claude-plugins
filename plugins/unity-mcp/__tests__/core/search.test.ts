import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/lib/bridge/ipc.js", () => ({
  generateRequestId: () => "mock-search-req-id",
  writeBridgeRequest: vi.fn(),
  waitForBridgeStatus: vi.fn(),
  sleep: vi.fn(),
  bridgeReadyMatchesProject: vi.fn(() => true),
  readBridgeStatus: vi.fn(),
}));

vi.mock("../../src/lib/bridge/launch.js", () => ({
  ensureUnityRunning: vi.fn().mockResolvedValue(false),
}));

import { searchAssets } from "../../src/core/search.js";
import { waitForBridgeStatus } from "../../src/lib/bridge/ipc.js";
import { ensureUnityRunning } from "../../src/lib/bridge/launch.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

describe("searchAssets", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-proj-"));
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
      searchAssets({ projectPath: projectDir, query: "t:prefab" }),
    ).rejects.toThrow("unity_launch_failed");
  });

  it("returns error on timeout", async () => {
    vi.mocked(waitForBridgeStatus).mockResolvedValue(null);
    const result = await searchAssets({ projectPath: projectDir, query: "t:prefab" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Timed out");
    }
  });

  it("returns search results on success", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-search-req-id",
      bridgeVersion: "5",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Search completed",
      searchResults: [
        { id: "Assets/Prefabs/Enemy.prefab", label: "Enemy", score: 0 },
        { id: "Assets/Prefabs/Ally.prefab", label: "Ally", score: 10 },
      ],
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await searchAssets({ projectPath: projectDir, query: "t:prefab" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe("Assets/Prefabs/Enemy.prefab");
      expect(result.results[0].label).toBe("Enemy");
      expect(result.results[0].score).toBe(0);
    }
  });

  it("returns empty array when no results", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-search-req-id",
      bridgeVersion: "5",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Search completed",
      searchResults: [],
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await searchAssets({ projectPath: projectDir, query: "nonexistent" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toEqual([]);
    }
  });

  it("clamps limit to 500 max", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-search-req-id",
      bridgeVersion: "5",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Search completed",
      searchResults: [],
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const { writeBridgeRequest } = await import("../../src/lib/bridge/ipc.js");
    await searchAssets({ projectPath: projectDir, query: "t:prefab", limit: 9999 });

    const call = vi.mocked(writeBridgeRequest).mock.calls[0];
    const request = call[1];
    expect((request.payload as { limit: number }).limit).toBe(500);
  });

  it("defaults limit to 100", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-search-req-id",
      bridgeVersion: "5",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Search completed",
      searchResults: [],
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const { writeBridgeRequest } = await import("../../src/lib/bridge/ipc.js");
    await searchAssets({ projectPath: projectDir, query: "t:prefab" });

    const call = vi.mocked(writeBridgeRequest).mock.calls[0];
    const request = call[1];
    expect((request.payload as { limit: number }).limit).toBe(100);
  });
});
