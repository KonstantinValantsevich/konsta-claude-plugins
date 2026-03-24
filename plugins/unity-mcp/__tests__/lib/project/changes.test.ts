import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "../../../src/lib/project/changes.js";

describe("change detection", () => {
  let tmpDir: string;
  let assetsDir: string;
  let markerDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-changes-"));
    assetsDir = path.join(tmpDir, "Assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    markerDir = path.join(tmpDir, "markers");
    fs.mkdirSync(markerDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getMarkerPath", () => {
    it("returns a deterministic path based on project path", () => {
      const p1 = getMarkerPath("/some/project", "recompile", markerDir);
      const p2 = getMarkerPath("/some/project", "recompile", markerDir);
      expect(p1).toBe(p2);
    });

    it("returns different paths for different projects", () => {
      const p1 = getMarkerPath("/project/a", "recompile", markerDir);
      const p2 = getMarkerPath("/project/b", "recompile", markerDir);
      expect(p1).not.toBe(p2);
    });
  });

  describe("hasChangedCsFiles", () => {
    it("returns true when .cs files are newer than marker", () => {
      const markerPath = path.join(markerDir, "test-marker");
      const past = new Date(Date.now() - 60_000);
      fs.writeFileSync(markerPath, "");
      fs.utimesSync(markerPath, past, past);
      fs.writeFileSync(path.join(assetsDir, "Test.cs"), "class Test {}");
      expect(hasChangedCsFiles(tmpDir, markerPath)).toBe(true);
    });

    it("returns false when no .cs files are newer than marker", () => {
      const markerPath = path.join(markerDir, "test-marker");
      fs.writeFileSync(path.join(assetsDir, "Test.cs"), "class Test {}");
      const future = new Date(Date.now() + 60_000);
      fs.writeFileSync(markerPath, "");
      fs.utimesSync(markerPath, future, future);
      expect(hasChangedCsFiles(tmpDir, markerPath)).toBe(false);
    });

    it("returns false when no .cs files exist", () => {
      const markerPath = path.join(markerDir, "test-marker");
      const past = new Date(Date.now() - 60_000);
      fs.writeFileSync(markerPath, "");
      fs.utimesSync(markerPath, past, past);
      expect(hasChangedCsFiles(tmpDir, markerPath)).toBe(false);
    });
  });

  describe("getMarkerPath with purpose", () => {
    it("returns different paths for different purposes", () => {
      const p1 = getMarkerPath("/some/project", "recompile", markerDir);
      const p2 = getMarkerPath("/some/project", "test-run", markerDir);
      expect(p1).not.toBe(p2);
    });

    it("includes purpose in marker filename", () => {
      const p = getMarkerPath("/some/project", "test-run", markerDir);
      expect(path.basename(p)).toMatch(/^test-run-/);
    });

    it("is backwards-compatible with recompile purpose", () => {
      const p = getMarkerPath("/some/project", "recompile", markerDir);
      expect(path.basename(p)).toMatch(/^recompile-/);
    });
  });

  describe("touchMarker", () => {
    it("creates marker file if it does not exist", () => {
      const markerPath = path.join(markerDir, "new-marker");
      touchMarker(markerPath);
      expect(fs.existsSync(markerPath)).toBe(true);
    });

    it("updates mtime of existing marker", () => {
      const markerPath = path.join(markerDir, "old-marker");
      fs.writeFileSync(markerPath, "");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(markerPath, past, past);
      const oldMtime = fs.statSync(markerPath).mtimeMs;
      touchMarker(markerPath);
      const newMtime = fs.statSync(markerPath).mtimeMs;
      expect(newMtime).toBeGreaterThan(oldMtime);
    });
  });
});
