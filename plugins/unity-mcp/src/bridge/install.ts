import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { bridgePaths, GIT_EXCLUDE_PATTERNS } from "../config.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "templates",
  "ClaudeRecompileBridge.cs",
);

/**
 * Ensure the bridge C# file is installed and up-to-date in the Unity project.
 * Returns whether the file was changed (installed or updated).
 */
export function ensureBridgeInstalled(projectPath: string): {
  changed: boolean;
} {
  const paths = bridgePaths(projectPath);
  const templateContent = fs.readFileSync(TEMPLATE_PATH, "utf-8");

  fs.mkdirSync(paths.bridgeEditorDir, { recursive: true });

  if (fs.existsSync(paths.bridgeFile)) {
    const existing = fs.readFileSync(paths.bridgeFile, "utf-8");
    if (existing === templateContent) {
      log("Bridge already up to date");
      return { changed: false };
    }
  }

  // Atomic write: tmp file + rename
  const tmpFile = paths.bridgeFile + ".tmp";
  fs.writeFileSync(tmpFile, templateContent);
  fs.renameSync(tmpFile, paths.bridgeFile);
  log(`Bridge installed/updated: ${paths.bridgeFile}`);
  return { changed: true };
}

/**
 * Ensure bridge paths are in .git/info/exclude so they don't pollute git status.
 */
export function ensureGitExclude(projectPath: string): void {
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    if (!gitDir) return;

    const excludeFile = path.join(projectPath, gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });

    let content = "";
    try {
      content = fs.readFileSync(excludeFile, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    let changed = false;
    for (const pattern of GIT_EXCLUDE_PATTERNS) {
      if (!content.split("\n").includes(pattern)) {
        content += `${pattern}\n`;
        changed = true;
        log(`Bridge exclude: added ${pattern}`);
      }
    }

    if (changed) {
      fs.writeFileSync(excludeFile, content);
    }
  } catch {
    log("Bridge exclude: unable to locate .git dir, skipping");
  }
}
