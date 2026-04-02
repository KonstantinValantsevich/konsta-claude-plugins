import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recompile } from "../../src/core/recompile.js";
import { BRIDGE_CS_FILES, BRIDGE_EDITOR_DIR, MARKER_DIR } from "../../src/lib/config.js";
import { getMarkerPath, ensureMarker, touchMarker } from "../../src/lib/project/changes.js";

const { mockSendBridgeRequest } = vi.hoisted(() => {
  const mockSendBridgeRequest = vi.fn().mockResolvedValue({
    ok: true,
    status: {
      protocolVersion: 1,
      bridgeVersion: "5",
      requestId: "test-001",
      projectPath: "/project",
      state: "completed",
      isSuccess: true,
      didCompile: true,
      errors: [],
      summary: "",
    },
  });
  return { mockSendBridgeRequest };
});

vi.mock("../../src/lib/bridge/request.js", () => ({
  sendBridgeRequest: mockSendBridgeRequest,
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

  it("returns errors when no C# files changed but project still has compilation errors", async () => {
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

    // Now mock the bridge to return compilation errors (project has existing errors)
    mockSendBridgeRequest.mockResolvedValueOnce({
      ok: true,
      status: {
        protocolVersion: 1,
        bridgeVersion: "5",
        requestId: "test-002",
        projectPath,
        state: "failed",
        isSuccess: false,
        didCompile: false,
        errors: [{ file: "Assets/Foo.cs", line: 10, column: 5, message: "Assets/Foo.cs(10,5): error CS1002: ; expected" }],
        summary: "Compilation failed",
      },
    });

    const result = await recompile(projectPath);
    expect(result.skipped).toBe(false);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe("Assets/Foo.cs");
    expect(result.errors[0].line).toBe(10);
    expect(result.errors[0].column).toBe(5);
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
