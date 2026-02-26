import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.resolve(
  __dirname,
  "..",
  "hooks",
  "TripleDot.DotSettings",
);

/**
 * Run `jb cleanupcode` on changed .cs files synchronously.
 * All files are passed in a single invocation (JVM startup dominates;
 * additional files are essentially free).
 */
export function runJbCleanupLint(projectPath: string): void {
  try {
    execSync("which jb", { stdio: "ignore", timeout: 5_000 });
  } catch {
    log("Lint: jb not found, skipping");
    return;
  }

  let changedFiles: string;
  try {
    changedFiles = execSync(
      `git -C "${projectPath}" diff HEAD --name-only -- '*.cs'`,
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
  } catch {
    log("Lint: could not get changed files, skipping");
    return;
  }
  if (!changedFiles) {
    log("Lint: no changed .cs files, skipping");
    return;
  }

  const files = changedFiles
    .split("\n")
    .filter(Boolean)
    .map((f) => path.join(projectPath, f))
    .filter((f) => fs.existsSync(f));

  if (files.length === 0) {
    log("Lint: no changed .cs files exist on disk, skipping");
    return;
  }

  log(`Lint: formatting ${files.length} file(s) with jb cleanupcode`);

  const args = [...files];
  if (fs.existsSync(SETTINGS_PATH)) {
    args.push(`--settings=${SETTINGS_PATH}`);
  }
  args.push("--verbosity=WARN");

  try {
    execFileSync("jb", ["cleanupcode", ...args], {
      timeout: 120_000,
      stdio: "pipe",
    });
  } catch {
    log("Lint: jb cleanupcode returned non-zero (warnings likely)");
  }

  log("Lint: done");
}
