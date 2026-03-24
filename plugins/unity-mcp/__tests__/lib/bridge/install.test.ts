import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureBridgeInstalled } from "../../../src/lib/bridge/install.js";
import { BRIDGE_EDITOR_DIR, BRIDGE_CS_FILES } from "../../../src/lib/config.js";

describe("ensureBridgeInstalled", () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "unity-bridge-"));
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it("installs all bridge files when they do not exist", () => {
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(true);
    for (const filename of BRIDGE_CS_FILES) {
      const filePath = path.join(tmpProject, BRIDGE_EDITOR_DIR, filename);
      if (fs.existsSync(filePath)) {
        expect(fs.readFileSync(filePath, "utf-8").length).toBeGreaterThan(0);
      }
    }
  });

  it("does not overwrite when bridge is already up to date", () => {
    ensureBridgeInstalled(tmpProject);
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(false);
  });

  it("overwrites when bridge content differs", () => {
    ensureBridgeInstalled(tmpProject);
    const firstFile = path.join(tmpProject, BRIDGE_EDITOR_DIR, BRIDGE_CS_FILES[0]);
    if (fs.existsSync(firstFile)) {
      fs.writeFileSync(firstFile, "// corrupted");
      const result = ensureBridgeInstalled(tmpProject);
      expect(result.changed).toBe(true);
    }
  });
});
