import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { unityIsRunning } from "../compile/applescript.js";
import { log } from "../logger.js";
import { UNITY_LAUNCH_TIMEOUT_MS, UNITY_BUILD_TARGET, POLL_INTERVAL_MS } from "../config.js";

const UNITY_HUB_EDITOR_DIR = "/Applications/Unity/Hub/Editor";

/**
 * Read the Unity version from ProjectSettings/ProjectVersion.txt.
 */
export function readUnityVersion(projectPath: string): string | null {
  const versionFile = path.join(projectPath, "ProjectSettings", "ProjectVersion.txt");
  try {
    const content = fs.readFileSync(versionFile, "utf-8");
    const match = content.match(/m_EditorVersion:\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the full path to the Unity binary for a given version.
 * Throws with error code "unity_not_found" if the binary doesn't exist.
 */
export function resolveUnityBinary(version: string): string {
  const binaryPath = path.join(
    UNITY_HUB_EDITOR_DIR,
    version,
    "Unity.app",
    "Contents/MacOS/Unity",
  );
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `unity_not_found: Unity ${version} not found at ${binaryPath}. Ensure it is installed via Unity Hub.`,
    );
  }
  return binaryPath;
}

/**
 * Ensure Unity Editor is running for the given project.
 * If not running, launches it interactively (detached) and waits for the process to appear.
 */
export async function ensureUnityRunning(
  projectPath: string,
  launchTimeoutMs: number = UNITY_LAUNCH_TIMEOUT_MS,
): Promise<boolean> {
  if (unityIsRunning(projectPath)) {
    return false; // was already running
  }

  const version = readUnityVersion(projectPath);
  if (!version) {
    throw new Error(
      `Could not detect Unity version from ProjectVersion.txt in ${projectPath}`,
    );
  }

  const binaryPath = resolveUnityBinary(version);

  log(`Launching Unity ${version} for project: ${projectPath}`);
  process.stderr.write(
    `Unity not running. Launching Unity ${version} (this may take a moment)...\n`,
  );

  const child = spawn(binaryPath, ["-projectPath", projectPath, "-buildTarget", UNITY_BUILD_TARGET], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll until Unity process appears
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    if (unityIsRunning(projectPath)) {
      log("Unity process detected after launch");
      return true; // was freshly launched
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `unity_launch_failed: Unity process did not appear within ${launchTimeoutMs / 1000}s. Check Unity installation.`,
  );
}
