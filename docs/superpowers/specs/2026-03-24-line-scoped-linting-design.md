# Line-Scoped Linting Design

## Problem

The current `lint()` function runs `jb cleanupcode` on entire files that have any git changes. This reformats untouched code, creating noisy diffs full of unrelated formatting changes.

## Goal

Only apply linter fixes to actually edited lines (plus a configurable buffer), so diffs stay clean and only show intentional changes.

## Approach: Snapshot & Selective Restore

For each changed `.cs` file:

1. **Get edited line ranges** — parse `git diff HEAD -- <file>` to extract added/modified line numbers from `@@ -a,b +c,d @@` hunk headers
2. **Expand ranges by buffer** (default 3 lines) — merge overlapping/adjacent ranges
3. **Snapshot** — read the original file content into memory
4. **Run `jb cleanupcode`** — on the whole file, as today
5. **Selective restore** — compare linted file against snapshot line-by-line; keep linted content for lines within allowed ranges, restore original for everything else

**New files** (not in HEAD) skip steps 1-2 and treat the entire file as in-range, since every line is new and the full-file edit won't add noise to the diff.

## Configuration

```ts
interface LintOptions {
  logger?: Logger;
  bufferLines?: number; // default: 3
}
```

Both callers (`hook/index.ts` and `mcp/server.ts`) pass it through. The MCP tool `unity_lint` uses the default for now.

## Code Structure

All changes stay within `src/core/lint.ts`. Three internal helpers:

- **`getEditedLineRanges(projectPath, filePath)`** — runs `git diff HEAD -- <file>`, parses `@@ +c,d @@` hunk headers, returns `[start, end][]` ranges (1-indexed, on the new-file side)
- **`expandAndMerge(ranges, buffer)`** — expands each range by `buffer` lines, merges overlapping ranges
- **`selectiveRestore(original, linted, allowedRanges)`** — line-by-line merge: keeps linted content within allowed ranges, restores original elsewhere. Returns merged content string.

Main `lint()` function changes:
1. Accept `LintOptions` instead of bare `Logger`
2. Before calling `jb`, snapshot each file's content into a `Map<string, string>`
3. After `jb` finishes, apply `selectiveRestore` per file
4. New files (not in `git diff HEAD --name-only` output) skip range filtering

`LintResult` type stays the same — no API change for callers.

## Testing

Extend `__tests__/core/lint.test.ts`:

- **`getEditedLineRanges`** — create file, commit, modify specific lines, verify returned ranges
- **`expandAndMerge`** — pure function: overlapping ranges, adjacent ranges, buffer expansion, clamping to file bounds
- **`selectiveRestore`** — given original/linted content and allowed ranges, verify only allowed lines kept from linted version
- **Integration** — mock `jb` or skip if unavailable, verify only lines near edit are changed

Existing "no changed files" test stays as-is.