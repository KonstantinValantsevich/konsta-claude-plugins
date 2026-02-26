import { execSync } from "node:child_process";
import { log } from "../logger.js";

/** Find the PID of the Unity Editor process for a given project (excluding batchMode). */
export function findUnityPid(projectPath: string): string | null {
  try {
    const output = execSync(
      `ps aux | grep '[U]nity' | grep "${projectPath}" | grep -v batchMode | awk '{print $2}' | head -1`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** Check if Unity Editor is running for the given project. */
export function unityIsRunning(projectPath: string): boolean {
  return findUnityPid(projectPath) !== null;
}

/**
 * Trigger Unity Editor refresh via AppleScript (Cmd+R).
 * Returns the previous frontmost app name (for restoring focus), or null on failure.
 */
export function triggerRefreshAppleScript(projectPath: string): string | null {
  const pid = findUnityPid(projectPath);
  if (!pid) {
    log("AppleScript: Could not find Unity process");
    return null;
  }

  try {
    const result = execSync(
      `osascript -e '
        set previousApp to (path to frontmost application as text)
        tell application "System Events"
          set frontmost of (first process whose unix id is ${pid}) to true
        end tell
        delay 0.3
        tell application "System Events"
          keystroke "r" using command down
        end tell
        return previousApp
      '`,
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    log("Triggered editor refresh via AppleScript");
    return result || null;
  } catch (err) {
    log(`AppleScript trigger failed: ${err}`);
    return null;
  }
}

/** Switch focus back to a previously frontmost application. */
export function switchBackToApp(appName: string): void {
  try {
    execSync(`osascript -e 'tell application "${appName}" to activate'`, {
      timeout: 5_000,
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Trigger editor refresh and restore the previous app in focus.
 */
export function triggerEditorRefreshOnly(projectPath: string): boolean {
  const previousApp = triggerRefreshAppleScript(projectPath);
  if (previousApp) {
    switchBackToApp(previousApp);
  }
  log("Triggered editor refresh (trigger-only path)");
  return true;
}
