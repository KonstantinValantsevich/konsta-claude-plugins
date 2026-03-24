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
 * Run jb cleanupcode on changed C# files (async).
 */
export async function lint(
  projectPath: string,
  options: LintOptions = {},
): Promise<LintResult> {
  const logger = options.logger ?? noopLogger;
  const _bufferLines = options.bufferLines ?? 3;
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

  logger.log(`Lint: formatting ${files.length} file(s) with jb cleanupcode`);

  const args = ["cleanupcode", ...files];
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

  logger.log("Lint: done");
  return { filesLinted: files.length, success: true };
}
