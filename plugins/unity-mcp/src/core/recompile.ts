import fs from "node:fs";
import { MARKER_DIR } from "../lib/config.js";
import {
  ensureMarker,
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "../lib/project/changes.js";
import { ensureBridgeInstalled, ensureGitExclude } from "../lib/bridge/install.js";
import { sendBridgeRequest } from "../lib/bridge/request.js";
import { parseBridgeStatusToResult } from "../lib/bridge/ipc.js";
import type { Logger, RecompileResult, CompilationError } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

/** Convert raw error strings from the bridge into structured CompilationError objects. */
function parseErrorStrings(errorStrings: string[]): CompilationError[] {
  return errorStrings.map((errStr) => {
    const match = errStr.match(/^(.+)\((\d+),(\d+)\):\s*(.+)$/);
    if (match) {
      return {
        assembly: "",
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        message: errStr,
        type: "error",
      };
    }
    return { assembly: "", file: "", line: 0, column: 0, message: errStr, type: "error" };
  });
}

/**
 * Trigger Unity recompilation for a project.
 * Internalizes the full pipeline: change detection -> bridge install -> compile -> marker touch.
 */
export async function recompile(
  projectPath: string,
  logger: Logger = noopLogger,
): Promise<RecompileResult> {
  // 1. Change detection
  fs.mkdirSync(MARKER_DIR, { recursive: true });
  const markerPath = getMarkerPath(projectPath, "recompile");
  ensureMarker(markerPath);

  // 2. Bridge install — called for return value (idempotent, sendBridgeRequest also calls internally)
  const { changed: bridgeChangedThisRun } = ensureBridgeInstalled(projectPath);
  ensureGitExclude(projectPath);

  const csChanged = hasChangedCsFiles(projectPath, markerPath);
  if (!csChanged && !bridgeChangedThisRun) {
    logger.log("No .cs files changed since last check — checking for existing errors");

    // Even without changes, the project may still have compilation errors.
    // Query the bridge to surface them instead of silently skipping.
    const checkResult = await sendBridgeRequest(projectPath, "recompile");
    if (checkResult.ok) {
      const parsed = parseBridgeStatusToResult(checkResult.status);
      if (!parsed.success && parsed.errors.length > 0) {
        logger.log("Project still has compilation errors");
        return { success: false, skipped: false, errors: parseErrorStrings(parsed.errors) };
      }
    }

    return { success: true, skipped: true, errors: [] };
  }
  logger.log(bridgeChangedThisRun ? "Bridge updated, triggering recompilation" : "C# files changed, triggering recompilation");

  // 3. Compile via bridge (auto-launches Unity if needed)
  const result = await sendBridgeRequest(projectPath, "recompile");
  if (!result.ok) {
    return {
      success: false,
      skipped: false,
      errors: [{ assembly: "", file: "", line: 0, column: 0, message: result.message, type: "error" }],
    };
  }
  const parsed = parseBridgeStatusToResult(result.status);
  const success = parsed.success;
  const didCompile = parsed.didCompile;

  // 4. Touch marker when recompilation was attempted
  if (success || didCompile) {
    touchMarker(markerPath);
    logger.log("Marker file updated");
  }

  return { success, skipped: false, errors: parseErrorStrings(parsed.errors) };
}
