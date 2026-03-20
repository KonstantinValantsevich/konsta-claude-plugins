import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getStatus } from "../../src/core/status.js";

describe("getStatus", () => {
  let tmpDir: string;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-core-status-"));
    projectPath = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(projectPath, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.0f1",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns correct projectPath", async () => {
    const result = await getStatus(projectPath);
    expect(result.projectPath).toBe(projectPath);
  });

  it("reads Unity version from ProjectVersion.txt", async () => {
    const result = await getStatus(projectPath);
    expect(result.unityVersion).toBe("2022.3.0f1");
  });

  it("reports bridge not ready when no bridge-ready.json exists", async () => {
    const result = await getStatus(projectPath);
    expect(result.bridgeReady).toBe(false);
    expect(result.bridgeVersion).toBeNull();
    expect(result.protocolVersion).toBeNull();
  });

  it("reports bridge ready when bridge-ready.json exists with valid data", async () => {
    const ipcDir = path.join(projectPath, "Library", "ClaudeHookIPC");
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, "bridge-ready.json"),
      JSON.stringify({
        protocolVersion: 1,
        bridgeVersion: "3",
        projectPath,
        readyAtUnixMs: Date.now(),
      }),
    );
    const result = await getStatus(projectPath);
    expect(result.bridgeReady).toBe(true);
    expect(result.bridgeVersion).toBe(3);
    expect(result.protocolVersion).toBe(1);
  });

  it("returns null lastRecompileMarker when no marker exists", async () => {
    const result = await getStatus(projectPath);
    expect(result.lastRecompileMarker).toBeNull();
  });
});
