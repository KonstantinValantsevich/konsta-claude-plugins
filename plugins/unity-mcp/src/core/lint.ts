import { structuredPatch } from "diff";
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, LintResult, LintOptions } from "./types.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "hooks",
  "TripleDot.DotSettings",
);

const noopLogger: Logger = { log() {}, error() {} };

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
  const lines = stdout.split("\n");
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

  let newLineNum = 0;
  let runStart: number | null = null;
  let runEnd: number | null = null;

  const flushRun = () => {
    if (runStart !== null && runEnd !== null) {
      ranges.push([runStart, runEnd]);
      runStart = null;
      runEnd = null;
    }
  };

  for (const line of lines) {
    const hunkMatch = hunkHeaderRe.exec(line);
    if (hunkMatch) {
      flushRun();
      const count = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      // Pure deletion hunk: skip it entirely, new-side line counter doesn't advance
      if (count === 0) {
        newLineNum = -1; // sentinel: skip lines until next hunk
      } else {
        newLineNum = parseInt(hunkMatch[1], 10);
      }
      continue;
    }

    if (newLineNum === -1) continue; // inside a pure-deletion hunk

    if (line.startsWith("+++") || line.startsWith("---")) {
      // File header lines — skip, don't affect line counting
      continue;
    } else if (line.startsWith("+")) {
      // Added line on new side
      if (runStart === null) {
        runStart = newLineNum;
      }
      runEnd = newLineNum;
      newLineNum++;
    } else if (line.startsWith("-")) {
      // Deleted line: doesn't advance new-side counter
      flushRun();
    } else if (line.startsWith(" ") || line.startsWith("\\")) {
      // Context line or "No newline at end of file"
      flushRun();
      if (line.startsWith(" ")) {
        newLineNum++;
      }
    }
  }

  flushRun();
  return ranges;
}

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

/**
 * Run jb cleanupcode on changed C# files (async).
 */
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
    // If ranges is empty but file is in changed list, it could be a new file —
    // no rangesMap entry needed, which means we skip filtering and keep the full jb output.
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
