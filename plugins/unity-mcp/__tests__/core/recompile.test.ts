import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recompile } from "../../src/core/recompile.js";

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
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns skipped=true when no C# files have changed", async () => {
    // No .cs files at all — should skip
    const result = await recompile(projectPath);
    expect(result.skipped).toBe(true);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
