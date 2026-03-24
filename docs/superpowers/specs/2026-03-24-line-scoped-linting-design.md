# Line-Scoped Linting Design

## Problem

The current `lint()` function runs `jb cleanupcode` on entire files that have any git changes. This reformats untouched code, creating noisy diffs full of unrelated formatting changes.

## Goal

Only apply linter fixes to actually edited lines (plus a configurable buffer), so diffs stay clean and only show intentional changes.

## Approach: Snapshot & Hunk Filtering

For each changed `.cs` file:

1. **Get edited line ranges** — parse `git diff HEAD -- <file>` to extract added/modified line numbers from `@@ -a,b +c,d @@` hunk headers (1-indexed, new-file side). Handle omitted counts (e.g., `+c` without `,d` means a single line).
2. **Expand ranges by buffer** (default 3 lines) — expand each range, clamp to `[1, lineCount]`, merge overlapping/adjacent ranges. `expandAndMerge` receives `lineCount` as a parameter.
3. **Snapshot** — read the original file content into memory.
4. **Run `jb cleanupcode`** — on the whole file, as today.
5. **Hunk filtering** — diff the snapshot against the linted output (using a line-based diff algorithm, not a naive positional zip). For each diff hunk, check if it overlaps any allowed range. Accept overlapping hunks, discard the rest. Apply accepted hunks to the snapshot to produce the final output.

This hunk-based approach is necessary because `jb` can insert or delete lines (e.g., adding blank lines between methods, collapsing expressions). A positional line-by-line merge would produce corrupted output when line counts change.

**New files** (not in HEAD) skip steps 1-2 and treat the entire file as in-range, since every line is new and the full-file edit won't add noise to the diff.

**Deleted files** are already filtered out by the existing `fs.existsSync` guard (line 59 of current code). The spec preserves this behavior.

**Renamed files** — `git diff HEAD --name-only` (without `-M`) shows renamed files as add+delete. The new path appears as a new file and gets full-file treatment, which is acceptable.

## Configuration

```ts
interface LintOptions {
  logger?: Logger;
  bufferLines?: number; // default: 3
}
```

Both callers update from `lint(projectPath, logger)` to `lint(projectPath, { logger })`:
- `hook/index.ts` line 56
- `mcp/server.ts` line 75

The no-argument form `lint(projectPath)` continues to work with defaults. The MCP tool `unity_lint` uses the default buffer for now.

## Code Structure

All changes stay within `src/core/lint.ts`. Three internal helpers:

- **`getEditedLineRanges(projectPath, filePath)`** — runs `git diff HEAD -- <file>`, parses `@@ +c,d @@` hunk headers, returns `[start, end][]` ranges (1-indexed, new-file side). Handles omitted counts (`+c` = single line). Pure deletion hunks (no new-file-side lines) are ignored since there are no lines to lint.
- **`expandAndMerge(ranges, buffer, lineCount)`** — expands each range by `buffer` lines, clamps to `[1, lineCount]`, sorts, merges overlapping/adjacent ranges.
- **`filterHunks(original, linted, allowedRanges)`** — computes a line-based diff between original and linted content. Each diff hunk that overlaps any allowed range is accepted; others are discarded. Returns the merged content with only accepted hunks applied.

For the diff algorithm in `filterHunks`: use a simple longest-common-subsequence (LCS) diff or a lightweight npm package. The diff operates on string arrays (lines), not characters. The output is a list of change hunks with original/linted line positions, which we filter by allowed ranges and apply.

Main `lint()` function changes:
1. Accept `LintOptions` instead of bare `Logger`
2. Before calling `jb`, snapshot each file's content into a `Map<string, string>`
3. After `jb` finishes, apply `filterHunks` per file
4. New files (not in `git diff HEAD --name-only` output) skip range filtering

`LintResult` type stays the same — no API change for callers.

## Edge Cases

- **Empty diff for a tracked file** — `getEditedLineRanges` returns `[]`, `filterHunks` discards all linter changes. Could short-circuit by skipping `jb` for that file entirely.
- **Buffer clamping** — `expandAndMerge` clamps start to >= 1 and end to <= lineCount to avoid out-of-bounds ranges.
- **Hunk header variants** — `+c` (no comma) = single line, `+0,0` = empty file. Both handled in parsing.

## Testing

Extend `__tests__/core/lint.test.ts`:

- **`getEditedLineRanges`** — create file, commit, modify specific lines, verify returned ranges. Include: single-line additions (`+c` without `,d`), multi-line hunks, pure deletion hunks (should return no new-side ranges).
- **`expandAndMerge`** — pure function: overlapping ranges, adjacent ranges after expansion, buffer clamping at line 1 and line N, single-line range, fully overlapping ranges.
- **`filterHunks`** — cases where linted version has same line count, more lines, and fewer lines than original. Verify only hunks within allowed ranges are kept. Include a case where a linter insertion inside an allowed range shifts subsequent lines — verify lines outside the range are unaffected.
- **New file path** — create untracked `.cs` file, run lint, verify entire file is treated as in-scope.
- **Integration** — mock `jb` or skip if unavailable, verify only lines near the edit are changed.

Existing "no changed files" test stays as-is.
