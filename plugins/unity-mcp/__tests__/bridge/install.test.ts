import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureBridgeInstalled } from "../../src/bridge/install.js";

describe("ensureBridgeInstalled", () => {
  let tmpProject: string;
  let bridgeFile: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "unity-bridge-"));
    bridgeFile = path.join(
      tmpProject,
      "Assets",
      "Recompile Hook",
      "Editor",
      "ClaudeRecompileBridge.cs",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it("installs bridge file when it does not exist", () => {
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(true);
    expect(fs.existsSync(bridgeFile)).toBe(true);
    expect(fs.readFileSync(bridgeFile, "utf-8")).toContain(
      "ClaudeRecompileBridge",
    );
  });

  it("does not overwrite when bridge is already up to date", () => {
    ensureBridgeInstalled(tmpProject);
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(false);
  });

  it("overwrites when bridge content differs", () => {
    ensureBridgeInstalled(tmpProject);
    fs.writeFileSync(bridgeFile, "// corrupted");
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(bridgeFile, "utf-8")).toContain(
      "ClaudeRecompileBridge",
    );
  });
});
