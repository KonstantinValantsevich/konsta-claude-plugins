import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MARKER_DIR } from "../config.js";

/** Get the marker file path for a project (MD5 hash of project path). */
export function getMarkerPath(
  projectPath: string,
  markerDir: string = MARKER_DIR,
): string {
  const hash = crypto.createHash("md5").update(projectPath).digest("hex");
  return path.join(markerDir, `recompile-${hash}`);
}

/**
 * Ensure the marker file exists. If it doesn't, create it with epoch mtime
 * so that all .cs files will be considered changed on first run.
 */
export function ensureMarker(markerPath: string): void {
  if (!fs.existsSync(markerPath)) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
    const epoch = new Date(0);
    fs.utimesSync(markerPath, epoch, epoch);
  }
}

/**
 * Check if any .cs files under Assets/ are newer than the marker file.
 * Uses `find -newer` for performance (same approach as the bash script).
 */
export function hasChangedCsFiles(
  projectPath: string,
  markerPath: string,
): boolean {
  try {
    const result = execSync(
      `find "${path.join(projectPath, "Assets")}" -name "*.cs" -newer "${markerPath}" -print -quit 2>/dev/null`,
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

/** Update marker mtime to now (marks recompilation as attempted). */
export function touchMarker(markerPath: string): void {
  if (!fs.existsSync(markerPath)) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
  }
  const now = new Date();
  fs.utimesSync(markerPath, now, now);
}
