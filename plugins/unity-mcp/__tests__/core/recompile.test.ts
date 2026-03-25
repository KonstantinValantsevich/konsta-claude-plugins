import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recompile } from "../../src/core/recompile.js";
import { BRIDGE_CS_FILES, BRIDGE_EDITOR_DIR, MARKER_DIR } from "../../src/lib/config.js";
import { getMarkerPath, ensureMarker, touchMarker } from "../../src/lib/project/changes.js";

// Mock orchestrateRecompile so we don't need a real Unity instance
vi.mock("../../src/lib/bridge/orchestrate.js", () => ({
  orchestrateRecompile: vi.fn().mockResolvedValue({
    success: true,
    didCompile: true,
    errors: [],
  }),
}));

describe("recompile", () => {
  let tmpDir: string;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-core-recompile-"));
    projectPath = path.join(tmpDir, "project");
    // Set up fake Unity project
    fs.mkdirSync(path.join(projectPath, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.0f1",
    );
    // Initialize git repo so ensureGitExclude doesn't fail
    const { execSync } = require("node:child_process");
    execSync("git init", { cwd: projectPath, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns skipped=true when no C# files changed and bridge already installed", async () => {
    // Pre-install bridge files so ensureBridgeInstalled returns changed=false
    const bridgeDir = path.join(projectPath, BRIDGE_EDITOR_DIR);
    fs.mkdirSync(bridgeDir, { recursive: true });
    const templatesDir = path.resolve(__dirname, "../../templates");
    for (const filename of BRIDGE_CS_FILES) {
      const templatePath = path.join(templatesDir, filename);
      fs.copyFileSync(templatePath, path.join(bridgeDir, filename));
    }

    // Run once to create marker, then touch marker so bridge .cs files aren't "newer"
    await recompile(projectPath);
    const markerPath = getMarkerPath(projectPath, "recompile");
    touchMarker(markerPath);

    const result = await recompile(projectPath);
    expect(result.skipped).toBe(true);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("does not skip when bridge files are missing even without C# changes", async () => {
    // No bridge files installed, no C# files changed
    // Bridge installation should detect missing files and trigger recompilation
    const result = await recompile(projectPath);
    expect(result.skipped).toBe(false);
    expect(result.success).toBe(true);

    // Verify bridge files were installed
    const bridgeDir = path.join(projectPath, BRIDGE_EDITOR_DIR);
    for (const filename of BRIDGE_CS_FILES) {
      expect(fs.existsSync(path.join(bridgeDir, filename))).toBe(true);
    }
  });
});
