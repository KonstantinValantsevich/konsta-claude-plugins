import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";

const UNITY_HUB_EDITOR_DIR = "/Applications/Unity/Hub/Editor";
const EDITOR_LOG_PATH = path.join(
  os.homedir(),
  "Library/Logs/Unity/Editor.log",
);

/**
 * Scan Unity Hub editor directory, return latest version string via semver sort.
 */
export function findLatestUnityVersion(): string {
  const entries = fs.readdirSync(UNITY_HUB_EDITOR_DIR);
  const versions = entries
    .filter((e) => /^\d+\.\d+\.\d+/.test(e))
    .sort((a, b) => {
      const pa = a.split(/[.\-f]/);
      const pb = b.split(/[.\-f]/);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = parseInt(pa[i] || "0", 10);
        const nb = parseInt(pb[i] || "0", 10);
        if (na !== nb) return na - nb;
      }
      return 0;
    });
  if (versions.length === 0) {
    throw new Error("No Unity versions found in " + UNITY_HUB_EDITOR_DIR);
  }
  return versions[versions.length - 1];
}

/** Full path to Unity.app for a version string. */
export function unityAppPath(version: string): string {
  return path.join(UNITY_HUB_EDITOR_DIR, version, "Unity.app");
}

/** Full path to Unity binary for a version string. */
export function unityBinaryPath(version: string): string {
  return path.join(unityAppPath(version), "Contents/MacOS/Unity");
}

/**
 * Create a new Unity project in batchmode. Blocks until Unity exits.
 */
export function createUnityProject(
  binaryPath: string,
  projectDir: string,
): void {
  execFileSync(binaryPath, ["-createProject", projectDir, "-quit", "-batchmode"], {
    timeout: 300_000,
    stdio: "ignore",
  });
}

/**
 * Open Unity Editor in non-batch mode for a project.
 */
export function openUnityEditor(appPath: string, projectDir: string): void {
  execSync(`open -a "${appPath}" --args -projectPath "${projectDir}"`, {
    timeout: 10_000,
  });
}

/**
 * Poll `ps aux` until a Unity process for the project path appears.
 * Returns the PID, or throws on timeout.
 */
export async function waitForUnityProcess(
  projectDir: string,
  timeoutMs: number = 120_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const output = execSync(
        `ps aux | grep '[U]nity' | grep "${projectDir}" | grep -v batchMode | awk '{print $2}' | head -1`,
        { encoding: "utf-8", timeout: 5_000 },
      ).trim();
      if (output) return parseInt(output, 10);
    } catch {
      // not found yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("Timed out waiting for Unity process");
}

/**
 * Poll Unity Editor.log for "Refresh completed" to confirm project is fully loaded.
 * Only checks lines written after `startTime` to avoid matching stale log entries.
 */
export async function waitForEditorLogRefresh(
  timeoutMs: number = 300_000,
  startTime?: Date,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const startTs = startTime ?? new Date();

  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(EDITOR_LOG_PATH);
      // Only check if log was modified after our start time
      if (stat.mtime >= startTs) {
        const content = fs.readFileSync(EDITOR_LOG_PATH, "utf-8");
        if (content.includes("Refresh completed")) {
          return;
        }
      }
    } catch {
      // log file doesn't exist yet
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error("Timed out waiting for editor log 'Refresh completed'");
}

/**
 * Send Cmd+R via osascript to trigger Unity recompilation (same pattern as applescript.ts).
 */
export function triggerOsascriptRefresh(pid: number): void {
  execSync(
    `osascript -e '
      set previousApp to (path to frontmost application as text)
      tell application "System Events"
        set frontmost of (first process whose unix id is ${pid}) to true
      end tell
      delay 0.3
      tell application "System Events"
        keystroke "r" using command down
      end tell
      tell application previousApp to activate
    '`,
    { timeout: 10_000 },
  );
}

/**
 * Kill Unity process.
 */
export function closeUnity(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
  // Wait for process to actually exit
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // check if alive
      execSync("sleep 1");
    } catch {
      return; // process is gone
    }
  }
}

/**
 * Check if `jb` CLI is available.
 */
export function isJbAvailable(): boolean {
  try {
    execSync("which jb", { encoding: "utf-8", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
