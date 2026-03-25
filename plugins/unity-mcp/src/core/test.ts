import { sendBridgeRequest } from "../lib/bridge/request.js";
import { saveTestRun } from "../lib/test-store.js";
import { getTestResults } from "./test-results.js";
import { getMarkerPath, ensureMarker, touchMarker } from "../lib/project/changes.js";
import { recompile } from "./recompile.js";
import type { TestDiscoveryFilters } from "../lib/bridge/types.js";
import type { Logger, RunTestsResult } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

export interface RunTestsOptions {
  projectPath: string;
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
  verbose?: boolean;
  logger?: Logger;
  storeDir?: string;
  markerDir?: string;
}

export async function runTests(opts: RunTestsOptions): Promise<RunTestsResult> {
  const logger = opts.logger ?? noopLogger;
  const projectPath = opts.projectPath;

  // Recompile first to ensure tests run against latest code
  const compileResult = await recompile(projectPath, logger);
  if (!compileResult.success && !compileResult.skipped) {
    const errorMsg = compileResult.errors.map((e) => e.message).join("\n");
    return { runId: "", formatted: "Recompilation failed before test run:\n" + errorMsg };
  }

  // Build payload
  const payload: TestDiscoveryFilters = {};
  if (opts.categoryNames?.length) payload.categoryNames = opts.categoryNames;
  if (opts.groupNames?.length) payload.groupNames = opts.groupNames;
  if (opts.assemblyNames?.length) payload.assemblyNames = opts.assemblyNames;

  // Send test request
  const result = await sendBridgeRequest(projectPath, "run_tests", { payload });
  if (!result.ok) {
    return { runId: "", formatted: result.message };
  }

  const { status } = result;

  if (!status.testResults) {
    return { runId: "", formatted: "Bridge returned no test results." };
  }

  // Store results
  const runId = "test-" + Date.now();
  const storedRun = {
    runId,
    timestamp: new Date().toISOString(),
    projectPath,
    filters: payload,
    results: status.testResults,
  };
  saveTestRun(storedRun, opts.storeDir);

  // Touch marker
  const markerPath = getMarkerPath(projectPath, "test-run", opts.markerDir);
  ensureMarker(markerPath);
  touchMarker(markerPath);

  // Format and return
  const view = getTestResults({
    projectPath,
    runId,
    verbose: opts.verbose,
    storeDir: opts.storeDir,
    markerDir: opts.markerDir,
  });

  return { runId, formatted: view.formatted };
}
