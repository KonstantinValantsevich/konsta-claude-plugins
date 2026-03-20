import fs from "node:fs";
import { MARKER_DIR, bridgePaths } from "../lib/config.js";
import {
  ensureMarker,
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "../lib/project/changes.js";
import { ensureBridgeInstalled, ensureGitExclude } from "../lib/bridge/install.js";
import { orchestrateRecompile } from "../lib/bridge/orchestrate.js";
import type { Logger, RecompileResult, CompilationError } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

/**
 * Trigger Unity recompilation for a project.
 * Internalizes the full pipeline: change detection → bridge install → orchestrate → marker touch.
 */
export async function recompile(
  projectPath: string,
  logger: Logger = noopLogger,
): Promise<RecompileResult> {
  // 1. Change detection
  fs.mkdirSync(MARKER_DIR, { recursive: true });
  const markerPath = getMarkerPath(projectPath);
  ensureMarker(markerPath);

  if (!hasChangedCsFiles(projectPath, markerPath)) {
    logger.log("No .cs files changed since last check");
    return { success: true, skipped: true, errors: [] };
  }
  logger.log("C# files changed, triggering recompilation");

  // 2. Bridge installation
  const paths = bridgePaths(projectPath);
  ensureGitExclude(projectPath);
  fs.mkdirSync(paths.ipcDir, { recursive: true });
  const { changed: bridgeChangedThisRun } = ensureBridgeInstalled(projectPath);

  // 3. Orchestrate recompilation
  const result = await orchestrateRecompile(projectPath, bridgeChangedThisRun);

  // 4. Touch marker when recompilation was attempted
  if (result.success || result.didCompile) {
    touchMarker(markerPath);
    logger.log("Marker file updated");
  }

  // 5. Convert CompileResult to RecompileResult
  const errors: CompilationError[] = result.errors.map((errStr) => ({
    assembly: "",
    file: "",
    line: 0,
    column: 0,
    message: errStr,
    type: "error",
  }));

  return {
    success: result.success,
    skipped: false,
    errors,
  };
}
