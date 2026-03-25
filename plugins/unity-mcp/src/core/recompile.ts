import fs from "node:fs";
import { MARKER_DIR } from "../lib/config.js";
import {
  ensureMarker,
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "../lib/project/changes.js";
import { ensureBridgeInstalled, ensureGitExclude } from "../lib/bridge/install.js";
import { unityIsRunning } from "../lib/compile/applescript.js";
import { runCliFallback } from "../lib/compile/cli-fallback.js";
import { sendBridgeRequest } from "../lib/bridge/request.js";
import { parseBridgeStatusToResult } from "../lib/bridge/ipc.js";
import type { Logger, RecompileResult, CompilationError } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

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
    logger.log("No .cs files changed since last check");
    return { success: true, skipped: true, errors: [] };
  }
  logger.log(bridgeChangedThisRun ? "Bridge updated, triggering recompilation" : "C# files changed, triggering recompilation");

  // 3. Compile
  let compileErrors: string[];
  let success: boolean;
  let didCompile: boolean;

  if (unityIsRunning(projectPath)) {
    const result = await sendBridgeRequest(projectPath, "recompile");
    if (!result.ok) {
      return {
        success: false,
        skipped: false,
        errors: [{ assembly: "", file: "", line: 0, column: 0, message: result.message, type: "error" }],
      };
    }
    const parsed = parseBridgeStatusToResult(result.status);
    success = parsed.success;
    didCompile = parsed.didCompile;
    compileErrors = parsed.errors;
  } else {
    const cliResult = await runCliFallback(projectPath);
    success = cliResult.success;
    didCompile = cliResult.didCompile;
    compileErrors = cliResult.errors;
  }

  // 4. Touch marker when recompilation was attempted
  if (success || didCompile) {
    touchMarker(markerPath);
    logger.log("Marker file updated");
  }

  // 5. Convert string errors to structured CompilationError
  const errors: CompilationError[] = compileErrors.map((errStr) => {
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

  return { success, skipped: false, errors };
}
