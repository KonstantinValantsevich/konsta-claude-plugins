# Line-Scoped Linting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the linter only apply JetBrains cleanupcode fixes to edited lines (+ configurable buffer), eliminating noisy diffs from unrelated formatting changes.

**Architecture:** Snapshot each file before running `jb cleanupcode`, then diff the snapshot against the linted output and keep only hunks that overlap the edited line ranges. Uses the `diff` npm package for line-based diffing.

**Tech Stack:** TypeScript, Node.js, `diff` npm package, vitest

**Spec:** `docs/superpowers/specs/2026-03-24-line-scoped-linting-design.md`

---

## File Structure

- **Modify:** `plugins/unity-mcp/src/core/lint.ts` — add three helpers (`getEditedLineRanges`, `expandAndMerge`, `filterHunks`), refactor `lint()` signature to accept `LintOptions`, add snapshot + hunk filtering logic
- **Modify:** `plugins/unity-mcp/src/core/types.ts` — add `LintOptions` interface
- **Modify:** `plugins/unity-mcp/src/hook/index.ts` — update `lint()` call to new signature
- **Modify:** `plugins/unity-mcp/src/mcp/server.ts` — update `lint()` call to new signature
- **Modify:** `plugins/unity-mcp/__tests__/core/lint.test.ts` — add tests for all three helpers + integration
- **Modify:** `plugins/unity-mcp/package.json` — add `diff` dependency

---

### Task 1: Install `diff` dependency

**Files:**
- Modify: `plugins/unity-mcp/package.json`

- [ ] **Step 1: Install the diff package**

Run: `npm --prefix plugins/unity-mcp install diff`

- [ ] **Step 2: Install types for diff**

Run: `npm --prefix plugins/unity-mcp install -D @types/diff`

- [ ] **Step 3: Verify installation**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```
git add plugins/unity-mcp/package.json plugins/unity-mcp/package-lock.json
git commit -m "chore: add diff dependency for line-scoped linting"
```

---

### Task 2: Add `LintOptions` type and update `lint()` signature

**Files:**
- Modify: `plugins/unity-mcp/src/core/types.ts:32-35`
- Modify: `plugins/unity-mcp/src/core/lint.ts:25-28`
- Modify: `plugins/unity-mcp/src/hook/index.ts:56`
- Modify: `plugins/unity-mcp/src/mcp/server.ts:76`
- Test: `plugins/unity-mcp/__tests__/core/lint.test.ts`

- [ ] **Step 1: Add LintOptions to types.ts**

In `plugins/unity-mcp/src/core/types.ts`, add after the existing `LintResult` interface (after line 35):

```ts
export interface LintOptions {
  logger?: Logger;
  bufferLines?: number;
}
```

- [ ] **Step 2: Update lint() signature in lint.ts**

In `plugins/unity-mcp/src/core/lint.ts`, change the import on line 6:

```ts
import type { Logger, LintResult, LintOptions } from "./types.js";
```

Change the function signature (lines 25-28) from:

```ts
export async function lint(
  projectPath: string,
  logger: Logger = noopLogger,
): Promise<LintResult> {
```

to:

```ts
export async function lint(
  projectPath: string,
  options: LintOptions = {},
): Promise<LintResult> {
  const logger = options.logger ?? noopLogger;
  const _bufferLines = options.bufferLines ?? 3;
```

Note: `_bufferLines` is prefixed with underscore since it's unused until Task 5. All existing references to `logger` in the function body remain unchanged.

- [ ] **Step 3: Update hook/index.ts caller**

In `plugins/unity-mcp/src/hook/index.ts`, change line 56 from:

```ts
    await lint(projectPath, logger);
```

to:

```ts
    await lint(projectPath, { logger });
```

- [ ] **Step 4: Update mcp/server.ts caller**

In `plugins/unity-mcp/src/mcp/server.ts`, change line 76 from:

```ts
      const result = await lint(projectPath, stderrLogger);
```

to:

```ts
      const result = await lint(projectPath, { logger: stderrLogger });
```

- [ ] **Step 5: Run existing test to verify no regression**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: PASS — the existing "returns filesLinted=0 when no changed .cs files" test passes

- [ ] **Step 6: Type-check**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```
git add plugins/unity-mcp/src/core/types.ts plugins/unity-mcp/src/core/lint.ts plugins/unity-mcp/src/hook/index.ts plugins/unity-mcp/src/mcp/server.ts
git commit -m "refactor: change lint() signature from Logger to LintOptions"
```

---

### Task 3: Implement and test `expandAndMerge`

This is a pure function with no I/O — easiest to TDD first.

**Files:**
- Modify: `plugins/unity-mcp/src/core/lint.ts`
- Test: `plugins/unity-mcp/__tests__/core/lint.test.ts`

- [ ] **Step 1: Write failing tests for expandAndMerge**

In `plugins/unity-mcp/__tests__/core/lint.test.ts`, add a new describe block. The function needs to be exported for testing — add a named export. Add these tests:

```ts
import { expandAndMerge } from "../../src/core/lint.js";

describe("expandAndMerge", () => {
  it("expands a single range by buffer", () => {
    // Range [10, 12], buffer 3, 100 lines → [7, 15]
    expect(expandAndMerge([[10, 12]], 3, 100)).toEqual([[7, 15]]);
  });

  it("clamps to line 1 at the start", () => {
    // Range [2, 4], buffer 3 → [1, 7] (not [-1, 7])
    expect(expandAndMerge([[2, 4]], 3, 100)).toEqual([[1, 7]]);
  });

  it("clamps to lineCount at the end", () => {
    // Range [98, 100], buffer 3, 100 lines → [95, 100]
    expect(expandAndMerge([[98, 100]], 3, 100)).toEqual([[95, 100]]);
  });

  it("merges overlapping ranges after expansion", () => {
    // Ranges [10, 12] and [14, 16], buffer 3
    // Expanded: [7, 15] and [11, 19] → merged: [7, 19]
    expect(expandAndMerge([[10, 12], [14, 16]], 3, 100)).toEqual([[7, 19]]);
  });

  it("merges adjacent ranges after expansion", () => {
    // Ranges [10, 10] and [17, 17], buffer 3
    // Expanded: [7, 13] and [14, 20] → adjacent, merge: [7, 20]
    expect(expandAndMerge([[10, 10], [17, 17]], 3, 100)).toEqual([[7, 20]]);
  });

  it("keeps non-overlapping ranges separate", () => {
    // Ranges [5, 5] and [20, 20], buffer 3
    // Expanded: [2, 8] and [17, 23] → separate
    expect(expandAndMerge([[5, 5], [20, 20]], 3, 100)).toEqual([[2, 8], [17, 23]]);
  });

  it("handles single-line range", () => {
    expect(expandAndMerge([[50, 50]], 3, 100)).toEqual([[47, 53]]);
  });

  it("handles fully overlapping ranges", () => {
    // [10, 20] and [12, 15] → already overlapping before expansion
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: FAIL — `expandAndMerge` is not exported / doesn't exist

- [ ] **Step 3: Implement expandAndMerge**

In `plugins/unity-mcp/src/core/lint.ts`, add this exported function before the `lint` function:

```ts
/**
 * Expand each range by `buffer` lines, clamp to [1, lineCount], merge overlapping/adjacent.
 * Ranges are [start, end] inclusive, 1-indexed.
 */
export function expandAndMerge(
  ranges: [number, number][],
  buffer: number,
  lineCount: number,
): [number, number][] {
  if (ranges.length === 0) return [];

  const expanded: [number, number][] = ranges.map(([s, e]) => [
    Math.max(1, s - buffer),
    Math.min(lineCount, e + buffer),
  ]);

  expanded.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [expanded[0]];
  for (let i = 1; i < expanded.length; i++) {
    const last = merged[merged.length - 1];
    const curr = expanded[i];
    if (curr[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }

  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```
git add plugins/unity-mcp/src/core/lint.ts plugins/unity-mcp/__tests__/core/lint.test.ts
git commit -m "feat: add expandAndMerge helper for line-scoped linting"
```

---

### Task 4: Implement and test `getEditedLineRanges`

**Files:**
- Modify: `plugins/unity-mcp/src/core/lint.ts`
- Test: `plugins/unity-mcp/__tests__/core/lint.test.ts`

- [ ] **Step 1: Write failing tests for getEditedLineRanges**

These tests use real git repos (like the existing lint test). Add to `__tests__/core/lint.test.ts`:

```ts
import { getEditedLineRanges } from "../../src/core/lint.js";

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

  it("returns ranges for modified lines", () => {
    const file = path.join(tmpDir, "Test.cs");
    // Create and commit an initial file with 10 lines
    const original = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    fs.writeFileSync(file, original);
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    // Modify lines 3 and 7
    const lines = original.split("\n");
    lines[2] = "modified line 3";
    lines[6] = "modified line 7";
    fs.writeFileSync(file, lines.join("\n"));

    const ranges = await getEditedLineRanges(tmpDir, file);
    expect(ranges).toEqual([[3, 3], [7, 7]]);
  });

  it("returns range for multi-line addition", () => {
    const file = path.join(tmpDir, "Test.cs");
    const original = "line 1\nline 2\nline 3\n";
    fs.writeFileSync(file, original);
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    // Insert 2 lines after line 1
    fs.writeFileSync(file, "line 1\nnew A\nnew B\nline 2\nline 3\n");

    const ranges = await getEditedLineRanges(tmpDir, file);
    // New lines appear at positions 2-3 in the new file
    expect(ranges).toEqual([[2, 3]]);
  });

  it("ignores pure deletion hunks (no new-side lines)", () => {
    const file = path.join(tmpDir, "Test.cs");
    fs.writeFileSync(file, "line 1\nline 2\nline 3\n");
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    // Delete line 2
    fs.writeFileSync(file, "line 1\nline 3\n");

    const ranges = await getEditedLineRanges(tmpDir, file);
    // Pure deletion: the hunk has 0 new-side lines, should be ignored
    expect(ranges).toEqual([]);
  });

  it("returns empty for a file with no changes", () => {
    const file = path.join(tmpDir, "Test.cs");
    fs.writeFileSync(file, "line 1\n");
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    const ranges = await getEditedLineRanges(tmpDir, file);
    expect(ranges).toEqual([]);
  });

  it("handles single-line hunk header without count", () => {
    const file = path.join(tmpDir, "Test.cs");
    // File with enough context to produce a single-line hunk
    fs.writeFileSync(file, "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
    execSync("git add . && git commit -m 'add file'", { cwd: tmpDir, stdio: "ignore" });

    // Change just one line in the middle
    fs.writeFileSync(file, "a\nb\nc\nd\nX\nf\ng\nh\ni\nj\n");

    const ranges = await getEditedLineRanges(tmpDir, file);
    // Line 5 was changed
    expect(ranges).toEqual([[5, 5]]);
  });
});
```

Note: these tests need `async` — update the test callbacks to be async.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: FAIL — `getEditedLineRanges` not exported / doesn't exist

- [ ] **Step 3: Implement getEditedLineRanges**

In `plugins/unity-mcp/src/core/lint.ts`, add this exported function:

```ts
/**
 * Parse `git diff HEAD -- <file>` to get edited line ranges on the new-file side.
 * Returns [start, end][] (1-indexed, inclusive). Pure deletion hunks are ignored.
 */
export async function getEditedLineRanges(
  projectPath: string,
  filePath: string,
): Promise<[number, number][]> {
  let stdout: string;
  try {
    const result = await execAsync(
      `git -C "${projectPath}" diff HEAD -- "${filePath}"`,
      { timeout: 10_000 },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  if (!stdout) return [];

  const ranges: [number, number][] = [];
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;

  while ((match = hunkRe.exec(stdout)) !== null) {
    const start = parseInt(match[1], 10);
    const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;

    // Skip pure deletion hunks (0 new-side lines)
    if (count === 0) continue;

    ranges.push([start, start + count - 1]);
  }

  return ranges;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```
git add plugins/unity-mcp/src/core/lint.ts plugins/unity-mcp/__tests__/core/lint.test.ts
git commit -m "feat: add getEditedLineRanges helper for line-scoped linting"
```

---

### Task 5: Implement and test `filterHunks`

**Files:**
- Modify: `plugins/unity-mcp/src/core/lint.ts`
- Test: `plugins/unity-mcp/__tests__/core/lint.test.ts`

- [ ] **Step 1: Write failing tests for filterHunks**

Add to `__tests__/core/lint.test.ts`:

```ts
import { filterHunks } from "../../src/core/lint.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: FAIL — `filterHunks` not exported / doesn't exist

- [ ] **Step 3: Implement filterHunks**

In `plugins/unity-mcp/src/core/lint.ts`, add the import and function:

```ts
import { structuredPatch } from "diff";
```

```ts
/**
 * Diff original vs linted, keep only hunks overlapping allowedRanges (original-side positions).
 * Apply accepted hunks bottom-to-top to avoid offset drift.
 */
export function filterHunks(
  original: string,
  linted: string,
  allowedRanges: [number, number][],
): string {
  if (allowedRanges.length === 0) return original;
  if (original === linted) return original;

  const patch = structuredPatch("file", "file", original, linted, "", "", { context: 0 });

  // Determine which hunks overlap any allowed range
  // Hunk positions are 1-indexed. oldStart/oldLines = original side.
  const acceptedHunks = patch.hunks.filter((hunk) => {
    const hunkStart = hunk.oldStart;
    const hunkEnd = hunk.oldStart + Math.max(hunk.oldLines - 1, 0);
    return allowedRanges.some(
      ([rStart, rEnd]) => hunkStart <= rEnd && hunkEnd >= rStart,
    );
  });

  if (acceptedHunks.length === 0) return original;

  // Apply accepted hunks bottom-to-top to the original lines
  const lines = original.split("\n");

  // Sort hunks by oldStart descending for bottom-to-top application
  const sorted = [...acceptedHunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sorted) {
    const removeStart = hunk.oldStart - 1; // convert to 0-indexed
    const removeCount = hunk.oldLines;
    const newLines = hunk.lines
      .filter((l) => l.startsWith("+") || l.startsWith(" "))
      .map((l) => l.slice(1));

    lines.splice(removeStart, removeCount, ...newLines);
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```
git add plugins/unity-mcp/src/core/lint.ts plugins/unity-mcp/__tests__/core/lint.test.ts
git commit -m "feat: add filterHunks helper for line-scoped linting"
```

---

### Task 6: Integrate helpers into `lint()` function

**Files:**
- Modify: `plugins/unity-mcp/src/core/lint.ts:25-83`
- Test: `plugins/unity-mcp/__tests__/core/lint.test.ts`

- [ ] **Step 1: Write integration test**

Add to `__tests__/core/lint.test.ts` inside the existing `describe("lint", ...)` block. This test doesn't need `jb` — it tests the snapshot/filter logic by checking that the function correctly identifies changed files. Since `jb` isn't available in CI, we just verify the no-change and new-file paths work:

```ts
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
```

- [ ] **Step 2: Run test to verify it passes (no behavioral change yet for empty case)**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: PASS

- [ ] **Step 3: Integrate snapshot + hunk filtering into lint()**

Replace the main body of `lint()` in `plugins/unity-mcp/src/core/lint.ts`. The full updated function:

```ts
export async function lint(
  projectPath: string,
  options: LintOptions = {},
): Promise<LintResult> {
  const logger = options.logger ?? noopLogger;
  const bufferLines = options.bufferLines ?? 3;

  // Check if jb is available
  try {
    await execAsync("which jb", { timeout: 5_000 });
  } catch {
    logger.log("Lint: jb not found, skipping");
    return { filesLinted: 0, success: true };
  }

  // Get changed .cs files
  let changedOutput: string;
  try {
    const { stdout } = await execAsync(
      `git -C "${projectPath}" diff HEAD --name-only -- '*.cs'`,
      { timeout: 10_000 },
    );
    changedOutput = stdout.trim();
  } catch {
    logger.log("Lint: could not get changed files, skipping");
    return { filesLinted: 0, success: true };
  }

  if (!changedOutput) {
    logger.log("Lint: no changed .cs files, skipping");
    return { filesLinted: 0, success: true };
  }

  const files = changedOutput
    .split("\n")
    .filter(Boolean)
    .map((f) => path.join(projectPath, f))
    .filter((f) => fs.existsSync(f));

  if (files.length === 0) {
    logger.log("Lint: no changed .cs files exist on disk, skipping");
    return { filesLinted: 0, success: true };
  }

  // Build per-file snapshots and edited ranges (before jb modifies files)
  const snapshots = new Map<string, string>();
  const rangesMap = new Map<string, [number, number][]>();

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf-8");
    snapshots.set(filePath, content);

    const ranges = await getEditedLineRanges(projectPath, filePath);
    if (ranges.length > 0) {
      const lineCount = content.split("\n").length;
      rangesMap.set(filePath, expandAndMerge(ranges, bufferLines, lineCount));
    }
    // If ranges is empty but file is in changedRelPaths, it's a new file — no rangesMap entry needed,
    // which means we skip filtering and keep the full jb output.
  }

  // Filter out files with empty ranges that are NOT new files
  // (tracked files with only deletions — nothing to lint)
  const filesToLint: string[] = [];
  for (const f of files) {
    const ranges = rangesMap.get(f);
    if (ranges && ranges.length > 0) {
      filesToLint.push(f);
      continue;
    }
    // Check if file is new (not in HEAD) — if so, lint the whole thing
    try {
      await execAsync(
        `git -C "${projectPath}" cat-file -e HEAD:"${path.relative(projectPath, f)}"`,
        { timeout: 5_000 },
      );
      // File exists in HEAD but has no new-side ranges — skip it
    } catch {
      // File not in HEAD — it's new, lint the whole thing
      filesToLint.push(f);
    }
  }

  if (filesToLint.length === 0) {
    logger.log("Lint: no files need linting after range analysis, skipping");
    return { filesLinted: 0, success: true };
  }

  logger.log(`Lint: formatting ${filesToLint.length} file(s) with jb cleanupcode`);

  const args = ["cleanupcode", ...filesToLint];
  if (fs.existsSync(SETTINGS_PATH)) {
    args.push(`--settings=${SETTINGS_PATH}`);
  }
  args.push("--profile=Built-in: Full Cleanup");
  args.push("--verbosity=WARN");

  try {
    await execFileAsync("jb", args, { timeout: 120_000 });
  } catch {
    logger.log("Lint: jb cleanupcode returned non-zero (warnings likely)");
  }

  // Apply selective restore — only keep linter changes within allowed ranges
  for (const filePath of filesToLint) {
    const snapshot = snapshots.get(filePath);
    const ranges = rangesMap.get(filePath);

    // No snapshot means something unexpected — skip
    if (snapshot === undefined) continue;

    // No ranges means new file — keep full jb output, no filtering needed
    if (!ranges) continue;

    const linted = fs.readFileSync(filePath, "utf-8");
    const filtered = filterHunks(snapshot, linted, ranges);
    if (filtered !== linted) {
      fs.writeFileSync(filePath, filtered);
    }
  }

  logger.log("Lint: done");
  return { filesLinted: filesToLint.length, success: true };
}
```

No new imports needed — `execAsync` is already available.

- [ ] **Step 4: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/lint.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Type-check**

Run: `npx --prefix plugins/unity-mcp tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Build**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```
git add plugins/unity-mcp/src/core/lint.ts plugins/unity-mcp/__tests__/core/lint.test.ts
git commit -m "feat: integrate line-scoped hunk filtering into lint()"
```

---

### Task 7: Build and final verification

**Files:**
- Verify: `plugins/unity-mcp/dist/server.mjs`

- [ ] **Step 1: Run full test suite**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: ALL PASS

- [ ] **Step 2: Build the bundle**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Build succeeds, `dist/server.mjs` is updated

- [ ] **Step 3: Commit build output**

```
git add plugins/unity-mcp/dist/server.mjs
git commit -m "build: regenerate server.mjs with line-scoped linting"
```
