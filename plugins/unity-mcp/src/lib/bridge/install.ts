import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { bridgePaths, BRIDGE_CS_FILES, GIT_EXCLUDE_PATTERNS, LEGACY_BRIDGE_ASSET_DIR } from "../config.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from __dirname to find the package root (where package.json lives).
 *  Works from both source (src/lib/bridge/) and bundle (dist/). */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return startDir;
}

const TEMPLATES_DIR = path.join(findPackageRoot(__dirname), "templates");

export function ensureBridgeInstalled(projectPath: string): {
  changed: boolean;
} {
  const paths = bridgePaths(projectPath);

  // Migration: remove old folder if it exists
  const legacyDir = path.join(projectPath, LEGACY_BRIDGE_ASSET_DIR);
  if (fs.existsSync(legacyDir)) {
    log("Migrating: removing legacy bridge folder " + legacyDir);
    fs.rmSync(legacyDir, { recursive: true, force: true });
    const legacyMeta = legacyDir + ".meta";
    if (fs.existsSync(legacyMeta)) fs.unlinkSync(legacyMeta);
  }

  fs.mkdirSync(paths.bridgeEditorDir, { recursive: true });

  let anyChanged = false;
  for (const filename of BRIDGE_CS_FILES) {
    const templatePath = path.join(TEMPLATES_DIR, filename);
    const destPath = path.join(paths.bridgeEditorDir, filename);

    if (!fs.existsSync(templatePath)) {
      log("Template not found, skipping: " + filename);
      continue;
    }

    const templateContent = fs.readFileSync(templatePath, "utf-8");

    if (fs.existsSync(destPath)) {
      const existing = fs.readFileSync(destPath, "utf-8");
      if (existing === templateContent) {
        continue;
      }
    }

    const tmpFile = destPath + ".tmp";
    fs.writeFileSync(tmpFile, templateContent);
    fs.renameSync(tmpFile, destPath);
    log("Bridge installed/updated: " + destPath);
    anyChanged = true;
  }

  if (!anyChanged) {
    log("All bridge files up to date");
  }
  return { changed: anyChanged };
}

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
        log("Bridge exclude: added " + pattern);
      }
    }

    if (changed) {
      fs.writeFileSync(excludeFile, content);
    }
  } catch {
    log("Bridge exclude: unable to locate .git dir, skipping");
  }
}
