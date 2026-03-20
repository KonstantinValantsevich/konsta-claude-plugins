import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectUnityProject } from "../../src/project/detect.js";

describe("detectUnityProject", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-detect-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns project root when cwd is the project root", () => {
    fs.mkdirSync(path.join(tmpDir, "Assets"));
    fs.mkdirSync(path.join(tmpDir, "ProjectSettings"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.0f1",
    );
    expect(detectUnityProject(tmpDir)).toBe(tmpDir);
  });

  it("returns project root when cwd is a nested subdirectory", () => {
    fs.mkdirSync(path.join(tmpDir, "Assets"));
    fs.mkdirSync(path.join(tmpDir, "ProjectSettings"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.0f1",
    );
    const nested = path.join(tmpDir, "Assets", "Scripts", "Player");
    fs.mkdirSync(nested, { recursive: true });
    expect(detectUnityProject(nested)).toBe(tmpDir);
  });

  it("returns null when not inside a Unity project", () => {
    expect(detectUnityProject(tmpDir)).toBeNull();
  });

  it("returns null when Assets exists but ProjectVersion.txt is missing", () => {
    fs.mkdirSync(path.join(tmpDir, "Assets"));
    expect(detectUnityProject(tmpDir)).toBeNull();
  });
});
