import fs from "node:fs";
import {
  bridgePaths,
  BRIDGE_BUSY_RETRY_DELAY_MS,
  BRIDGE_MAX_BUSY_RETRIES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_READY_TIMEOUT_MS,
  BRIDGE_STATUS_TIMEOUT_MS,
} from "../config.js";
import { log } from "../logger.js";
import {
  triggerEditorRefreshOnly,
  unityIsRunning,
} from "../compile/applescript.js";
import { runCliFallback } from "../compile/cli-fallback.js";
import type { BridgeRequest, CompileResult } from "./types.js";
import {
  bridgeReadyMatchesProject,
  generateRequestId,
  parseBridgeStatusToResult,
  sleep,
  waitForBridgeReady,
  waitForBridgeStatus,
  writeBridgeRequest,
} from "./ipc.js";

/**
 * Send a bridge request and wait for the status response.
 * Handles busy retries.
 */
export async function bridgeRequestAndWait(
  projectPath: string,
  action: "recompile" | "bootstrap_handshake",
  timeoutMs: number,
): Promise<CompileResult> {
  const paths = bridgePaths(projectPath);
  let attempt = 0;

  while (true) {
    const requestId = generateRequestId();
    const statusPath = paths.statusFile(requestId);

    try { fs.unlinkSync(statusPath); } catch { /* doesn't exist */ }

    const request: BridgeRequest = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId,
      requestedAtUnixMs: Date.now(),
      projectPath,
      action,
      reason: "claude-stop-hook",
      source: "unity-recompile-ts",
    };

    fs.mkdirSync(paths.ipcDir, { recursive: true });
    writeBridgeRequest(paths.requestFile, request);

    const status = await waitForBridgeStatus(statusPath, requestId, timeoutMs);
    if (!status) {
      return {
        success: false,
        didCompile: false,
        errors: [`Timed out waiting for bridge status (${action})`],
      };
    }

    const result = parseBridgeStatusToResult(status);

    if (status.state === "busy" && attempt < BRIDGE_MAX_BUSY_RETRIES) {
      attempt++;
      log(`Bridge busy, retrying action=${action} attempt=${attempt}`);
      await sleep(BRIDGE_BUSY_RETRY_DELAY_MS);
      continue;
    }

    return result;
  }
}

/**
 * Bootstrap flow: trigger refresh via AppleScript, wait for bridge ready,
 * then send handshake + recompile.
 */
export async function runBridgeBootstrapAndRecompile(
  projectPath: string,
): Promise<CompileResult> {
  log("Bridge bootstrap flow starting");
  const paths = bridgePaths(projectPath);

  if (!unityIsRunning(projectPath)) {
    log("Bridge bootstrap unavailable: Unity editor not running");
    return {
      success: false,
      didCompile: false,
      errors: ["Unity Editor is not running, cannot bootstrap bridge IPC"],
    };
  }

  triggerEditorRefreshOnly(projectPath);

  const ready = await waitForBridgeReady(
    paths.readyFile,
    projectPath,
    BRIDGE_READY_TIMEOUT_MS,
  );
  if (!ready) {
    return {
      success: false,
      didCompile: false,
      errors: ["Bridge did not become ready after bootstrap refresh"],
    };
  }

  const handshake = await bridgeRequestAndWait(
    projectPath,
    "bootstrap_handshake",
    BRIDGE_READY_TIMEOUT_MS,
  );
  if (!handshake.success) return handshake;

  log("Bridge bootstrap handshake succeeded, requesting authoritative recompile");
  return bridgeRequestAndWait(projectPath, "recompile", BRIDGE_STATUS_TIMEOUT_MS);
}

/**
 * Direct recompile flow: bridge is already ready, send recompile directly.
 */
export async function runBridgeRecompileDirect(
  projectPath: string,
): Promise<CompileResult | null> {
  if (!unityIsRunning(projectPath)) return null;

  const paths = bridgePaths(projectPath);
  if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) return null;

  log("Bridge direct recompile flow");
  return bridgeRequestAndWait(projectPath, "recompile", BRIDGE_STATUS_TIMEOUT_MS);
}

/**
 * Top-level orchestration: pick compilation strategy based on state.
 */
export async function orchestrateRecompile(
  projectPath: string,
  bridgeChangedThisRun: boolean,
): Promise<CompileResult> {
  if (unityIsRunning(projectPath)) {
    log("Unity IS running");

    if (bridgeChangedThisRun) {
      log("Bridge changed this run; using bootstrap flow");
      return runBridgeBootstrapAndRecompile(projectPath);
    }

    const direct = await runBridgeRecompileDirect(projectPath);
    if (direct) {
      log("Bridge ready; used direct bridge path");
      return direct;
    }

    log("Bridge not ready; using bootstrap flow");
    return runBridgeBootstrapAndRecompile(projectPath);
  }

  log("Unity NOT running, using CLI fallback");
  return runCliFallback(projectPath);
}
