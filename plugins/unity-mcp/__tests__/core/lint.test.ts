import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { lint, expandAndMerge } from "../../src/core/lint.js";

describe("expandAndMerge", () => {
  it("expands a single range by buffer", () => {
    expect(expandAndMerge([[10, 12]], 3, 100)).toEqual([[7, 15]]);
  });

  it("clamps to line 1 at the start", () => {
    expect(expandAndMerge([[2, 4]], 3, 100)).toEqual([[1, 7]]);
  });

  it("clamps to lineCount at the end", () => {
    expect(expandAndMerge([[98, 100]], 3, 100)).toEqual([[95, 100]]);
  });

  it("merges overlapping ranges after expansion", () => {
    expect(expandAndMerge([[10, 12], [14, 16]], 3, 100)).toEqual([[7, 19]]);
  });

  it("merges adjacent ranges after expansion", () => {
    expect(expandAndMerge([[10, 10], [17, 17]], 3, 100)).toEqual([[7, 20]]);
  });

  it("keeps non-overlapping ranges separate", () => {
    expect(expandAndMerge([[5, 5], [20, 20]], 3, 100)).toEqual([[2, 8], [17, 23]]);
  });

  it("handles single-line range", () => {
    expect(expandAndMerge([[50, 50]], 3, 100)).toEqual([[47, 53]]);
  });

  it("handles fully overlapping ranges", () => {
    expect(expandAndMerge([[10, 20], [12, 15]], 3, 100)).toEqual([[7, 23]]);
  });

  it("returns empty for empty input", () => {
    expect(expandAndMerge([], 3, 100)).toEqual([]);
  });

  it("handles buffer of 0", () => {
    expect(expandAndMerge([[10, 12]], 0, 100)).toEqual([[10, 12]]);
  });

  it("sorts unsorted input ranges", () => {
    expect(expandAndMerge([[20, 22], [5, 7]], 3, 100)).toEqual([[2, 10], [17, 25]]);
  });
});

describe("lint", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-core-lint-"));
    // Initialize a git repo so `git diff` works
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit --allow-empty -m 'init'", { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns filesLinted=0 when no changed .cs files", async () => {
    const result = await lint(tmpDir);
    expect(result.filesLinted).toBe(0);
    expect(result.success).toBe(true);
  });
});
