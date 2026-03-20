import fs from "node:fs";
import { MARKER_DIR, bridgePaths } from "./config.js";
import { log } from "./logger.js";
import { detectUnityProject } from "./project/detect.js";
import {
  ensureMarker,
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "./project/changes.js";
import { ensureBridgeInstalled, ensureGitExclude } from "./bridge/install.js";
import { orchestrateRecompile } from "./bridge/orchestrate.js";
import { runJbCleanupLint } from "./lint.js";

async function main(): Promise<void> {
  log("=== Hook started ===");

  // Read stdin JSON for cwd
  let cwd = process.cwd();
  try {
    const stdin = fs.readFileSync(0, "utf-8");
    log(`stdin length: ${stdin.length}`);
    if (stdin) {
      const data = JSON.parse(stdin);
      if (data.cwd) {
        cwd = data.cwd;
        log(`cwd: ${cwd}`);
      } else {
        log(`cwd (from PWD): ${cwd}`);
      }
    }
  } catch {
    log(`cwd (from PWD): ${cwd}`);
  }

  // Detect Unity project
  const projectPath = detectUnityProject(cwd);
  if (!projectPath) {
    log(`Not a Unity project: ${cwd}`);
    process.exit(0);
  }
  log(`Unity project: ${projectPath}`);

  // Check skip marker
  const skipMarker = `${projectPath}/.claude/hooks-skip-recompile`;
  if (fs.existsSync(skipMarker)) {
    log("Skipping: project has .claude/hooks-skip-recompile marker");
    process.exit(0);
  }

  // Change detection
  fs.mkdirSync(MARKER_DIR, { recursive: true });
  const markerPath = getMarkerPath(projectPath);
  ensureMarker(markerPath);

  if (!hasChangedCsFiles(projectPath, markerPath)) {
    log("No .cs files changed since last check, exiting");
    process.exit(0);
  }
  log("C# files changed, triggering recompilation");

  // Install bridge
  const paths = bridgePaths(projectPath);
  ensureGitExclude(projectPath);
  fs.mkdirSync(paths.ipcDir, { recursive: true });
  const { changed: bridgeChangedThisRun } =
    ensureBridgeInstalled(projectPath);

  // Orchestrate recompilation
  const result = await orchestrateRecompile(projectPath, bridgeChangedThisRun);

  // Update marker only when recompilation was actually attempted
  // (matches bash script's attempted_recompile guard)
  if (result.success || result.didCompile) {
    touchMarker(markerPath);
    log(`Marker file updated: ${markerPath}`);
  }

  // Output results
  if (result.success) {
    log("SUCCESS: Unity recompilation complete");
    process.stderr.write("Unity compiled successfully\n");
    runJbCleanupLint(projectPath);
    process.exit(0);
  } else {
    log("FAILED: Unity compilation errors found");
    process.stderr.write("Unity compilation failed:\n\n");
    process.stderr.write(result.errors.join("\n") + "\n\n");
    process.stderr.write("Fix these errors to continue.\n");
    process.exit(2);
  }
}

main().catch((err) => {
  log(`Unhandled error: ${err}`);
  process.stderr.write(`Unity recompile hook error: ${err}\n`);
  process.exit(1);
});
