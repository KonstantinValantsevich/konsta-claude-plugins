import fs from "node:fs";
import {
  bridgePaths,
  BRIDGE_PROTOCOL_VERSION,
  TEST_STATUS_TIMEOUT_MS,
} from "../lib/config.js";
import {
  generateRequestId,
  writeBridgeRequest,
  waitForBridgeStatus,
  bridgeReadyMatchesProject,
} from "../lib/bridge/ipc.js";
import { unityIsRunning } from "../lib/compile/applescript.js";
import { saveTestRun } from "../lib/test-store.js";
import { getTestResults } from "./test-results.js";
import { getMarkerPath, ensureMarker, touchMarker } from "../lib/project/changes.js";
import type { BridgeRequest, TestRunPayload } from "../lib/bridge/types.js";
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

  // Check Unity is running
  if (!unityIsRunning(projectPath)) {
    return { runId: "", formatted: "Unity editor must be running to execute tests." };
  }

  // Check bridge ready
  const paths = bridgePaths(projectPath);
  if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) {
    return { runId: "", formatted: "Bridge is not ready. Run unity_recompile first to initialize the bridge." };
  }

  // Build request
  const requestId = generateRequestId();
  const statusPath = paths.statusFile(requestId);

  try { fs.unlinkSync(statusPath); } catch { /* doesn't exist */ }

  const payload: TestRunPayload = {};
  if (opts.categoryNames?.length) payload.categoryNames = opts.categoryNames;
  if (opts.groupNames?.length) payload.groupNames = opts.groupNames;
  if (opts.assemblyNames?.length) payload.assemblyNames = opts.assemblyNames;

  const request: BridgeRequest = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    requestedAtUnixMs: Date.now(),
    projectPath,
    action: "run_tests",
    reason: "unity_run_tests MCP tool",
    source: "unity-mcp",
    payload,
  };

  fs.mkdirSync(paths.ipcDir, { recursive: true });
  writeBridgeRequest(paths.requestFile, request);
  logger.log("Sent run_tests request: " + requestId);

  // Poll for status
  const status = await waitForBridgeStatus(statusPath, requestId, TEST_STATUS_TIMEOUT_MS);
  if (!status) {
    return { runId: "", formatted: "Timed out waiting for test results (300s)." };
  }

  if (status.state === "failed" || status.state === "bridge_error") {
    return { runId: "", formatted: "Test run failed: " + (status.summary || "unknown error") };
  }

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
