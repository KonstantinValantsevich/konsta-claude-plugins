import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/core/recompile.js", () => ({
  recompile: vi.fn(() => Promise.resolve({ success: true, skipped: true, errors: [] })),
}));

import { lint, expandAndMerge, getEditedLineRanges, filterHunks } from "../../src/core/lint.js";

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

describe("getEditedLineRanges", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-lint-ranges-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit --allow-empty -m 'init'", { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns ranges for modified lines", async () => {
    const file = path.join(tmpDir, "Test.cs");
    const original = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    fs.writeFileSync(file, original);
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    const lines = original.split("\n");
    lines[2] = "modified line 3";
    lines[6] = "modified line 7";
    fs.writeFileSync(file, lines.join("\n"));

    const ranges = await getEditedLineRanges(tmpDir, file);
    expect(ranges).toEqual([[3, 3], [7, 7]]);
  });

  it("returns range for multi-line addition", async () => {
    const file = path.join(tmpDir, "Test.cs");
    const original = "line 1\nline 2\nline 3\n";
    fs.writeFileSync(file, original);
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    fs.writeFileSync(file, "line 1\nnew A\nnew B\nline 2\nline 3\n");

    const ranges = await getEditedLineRanges(tmpDir, file);
    expect(ranges).toEqual([[2, 3]]);
  });

  it("ignores pure deletion hunks (no new-side lines)", async () => {
    const file = path.join(tmpDir, "Test.cs");
    fs.writeFileSync(file, "line 1\nline 2\nline 3\n");
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    fs.writeFileSync(file, "line 1\nline 3\n");

    const ranges = await getEditedLineRanges(tmpDir, file);
    expect(ranges).toEqual([]);
  });

  it("returns empty for a file with no changes", async () => {
    const file = path.join(tmpDir, "Test.cs");
    fs.writeFileSync(file, "line 1\n");
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    const ranges = await getEditedLineRanges(tmpDir, file);
    expect(ranges).toEqual([]);
  });

  it("handles single-line hunk header without count", async () => {
    const file = path.join(tmpDir, "Test.cs");
    fs.writeFileSync(file, "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    fs.writeFileSync(file, "a\nb\nc\nd\nX\nf\ng\nh\ni\nj\n");

    const ranges = await getEditedLineRanges(tmpDir, file);
    expect(ranges).toEqual([[5, 5]]);
  });
});

describe("filterHunks", () => {
  it("keeps changes within allowed range (same line count)", () => {
    const original = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    const linted = "line 1\nFIXED 2\nline 3\nFIXED 4\nline 5\n";
    // Only allow range around line 2
    const result = filterHunks(original, linted, [[2, 2]]);
    expect(result).toBe("line 1\nFIXED 2\nline 3\nline 4\nline 5\n");
  });

  it("discards changes fully outside allowed range", () => {
    const original = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    const linted = "line 1\nline 2\nline 3\nFIXED 4\nline 5\n";
    // Only allow range around line 2 — change at line 4 is outside
    const result = filterHunks(original, linted, [[2, 2]]);
    expect(result).toBe(original);
  });

  it("handles linted version with more lines (insertion in allowed range)", () => {
    const original = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    // Linter inserts a blank line after line 2
    const linted = "line 1\nline 2\nextra\nline 3\nline 4\nline 5\n";
    const result = filterHunks(original, linted, [[2, 3]]);
    expect(result).toBe("line 1\nline 2\nextra\nline 3\nline 4\nline 5\n");
  });

  it("handles linted version with fewer lines (deletion in allowed range)", () => {
    const original = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    // Linter removes line 3
    const linted = "line 1\nline 2\nline 4\nline 5\n";
    const result = filterHunks(original, linted, [[2, 4]]);
    expect(result).toBe("line 1\nline 2\nline 4\nline 5\n");
  });

  it("preserves lines outside allowed range when insertion shifts them", () => {
    const original = "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n";
    // Linter inserts 2 lines at position 3, and also changes line 8
    const linted = "A\nB\nX1\nX2\nC\nD\nE\nF\nG\nHH\nI\nJ\n";
    // Only allow range [3, 3] — the insertion is allowed, line 8 change is not
    const result = filterHunks(original, linted, [[3, 3]]);
    // Insertion at line 3 is kept, but change at original line 8 is discarded
    expect(result).toBe("A\nB\nX1\nX2\nC\nD\nE\nF\nG\nH\nI\nJ\n");
  });

  it("returns original when no ranges provided", () => {
    const original = "line 1\nline 2\n";
    const linted = "FIXED 1\nFIXED 2\n";
    const result = filterHunks(original, linted, []);
    expect(result).toBe(original);
  });

  it("returns linted when all lines are in range", () => {
    const original = "line 1\nline 2\n";
    const linted = "FIXED 1\nFIXED 2\n";
    const result = filterHunks(original, linted, [[1, 2]]);
    expect(result).toBe(linted);
  });

  it("handles identical original and linted", () => {
    const content = "line 1\nline 2\nline 3\n";
    const result = filterHunks(content, content, [[1, 3]]);
    expect(result).toBe(content);
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

  it("returns filesLinted=0 when no changed .cs files (with LintOptions)", async () => {
    const result = await lint(tmpDir, { bufferLines: 5 });
    expect(result.filesLinted).toBe(0);
    expect(result.success).toBe(true);
  });

  it("treats new (untracked) .cs files as full-scope", async () => {
    // Create a new .cs file that is NOT committed (not in HEAD)
    const file = path.join(tmpDir, "NewFile.cs");
    fs.writeFileSync(file, "public class Foo {}\n");
    // Stage it so git diff HEAD sees it
    execSync("git add .", { cwd: tmpDir, stdio: "ignore" });

    // getEditedLineRanges should return the whole file as edited
    const ranges = await getEditedLineRanges(tmpDir, file);
    expect(ranges.length).toBeGreaterThan(0);

    // The file should NOT be filtered out by the new-file detection
    // (We can't test full lint() without jb, but we verify the range logic)
  });
});
