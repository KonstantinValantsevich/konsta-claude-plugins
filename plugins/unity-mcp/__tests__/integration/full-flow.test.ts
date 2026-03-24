import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectProject } from "../../src/core/detect.js";
import {
  ensureMarker,
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "../../src/lib/project/changes.js";
import { ensureBridgeInstalled } from "../../src/lib/bridge/install.js";
import { bridgePaths } from "../../src/lib/config.js";

describe("integration: full flow simulation", () => {
  let tmpDir: string;
  let markerDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-integ-"));
    markerDir = path.join(tmpDir, "markers");
    fs.mkdirSync(markerDir, { recursive: true });

    // Set up fake Unity project
    fs.mkdirSync(path.join(tmpDir, "project", "Assets", "Scripts"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, "project", "ProjectSettings"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, "project", "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.0f1",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects project, finds changes, installs bridge", () => {
    const projectPath = path.join(tmpDir, "project");

    // 1. Detect project from nested dir
    const detected = detectProject(
      path.join(projectPath, "Assets", "Scripts"),
    );
    expect(detected).toBe(projectPath);

    // 2. Set up marker at epoch
    const markerPath = getMarkerPath(projectPath, "recompile", markerDir);
    ensureMarker(markerPath);

    // 3. Create a .cs file
    fs.writeFileSync(
      path.join(projectPath, "Assets", "Scripts", "Player.cs"),
      "class Player {}",
    );

    // 4. Detect changes
    expect(hasChangedCsFiles(projectPath, markerPath)).toBe(true);

    // 5. Install bridge
    const { changed } = ensureBridgeInstalled(projectPath);
    expect(changed).toBe(true);

    // 6. Verify bridge file exists
    const paths = bridgePaths(projectPath);
    const installedFiles = paths.bridgeFiles.filter((f) => fs.existsSync(f));
    expect(installedFiles.length).toBeGreaterThan(0);

    // 7. Touch marker
    touchMarker(markerPath);

    // 8. No more changes after marker touched
    const pastCs = new Date(Date.now() - 5_000);
    fs.utimesSync(
      path.join(projectPath, "Assets", "Scripts", "Player.cs"),
      pastCs,
      pastCs,
    );
    expect(hasChangedCsFiles(projectPath, markerPath)).toBe(false);
  });

  it("second bridge install reports no change", () => {
    const projectPath = path.join(tmpDir, "project");
    ensureBridgeInstalled(projectPath);
    const result = ensureBridgeInstalled(projectPath);
    expect(result.changed).toBe(false);
  });
});
