import fs from "node:fs";
import {
  bridgePaths,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_READY_LAUNCH_TIMEOUT_MS,
  BRIDGE_READY_TIMEOUT_MS,
  BRIDGE_STATUS_TIMEOUT_MS,
  BRIDGE_VERSION,
  TEST_STATUS_TIMEOUT_MS,
} from "../config.js";
import { log } from "../logger.js";
import { triggerEditorRefreshOnly } from "../compile/applescript.js";
import { ensureUnityRunning } from "./launch.js";
import { ensureBridgeInstalled, ensureGitExclude } from "./install.js";
import type { BridgeAction, BridgeRequest, BridgeResult, SearchPayload, LogsPayload, ConsolePayload } from "./types.js";
import type { TestDiscoveryFilters } from "./types.js";
import {
  bridgeReadyMatchesProject,
  generateRequestId,
  waitForBridgeReady,
  waitForBridgeStatus,
  writeBridgeRequest,
} from "./ipc.js";

/** Default timeout per action. */
function defaultTimeout(action: BridgeAction | "bootstrap_handshake"): number {
  if (action === "run_tests" || action === "list_tests") return TEST_STATUS_TIMEOUT_MS;
  return BRIDGE_STATUS_TIMEOUT_MS;
}

/** Reason string for request metadata. */
function reasonForAction(action: BridgeAction | "bootstrap_handshake"): string {
  if (action === "bootstrap_handshake") return "bridge bootstrap handshake";
  if (action === "search_assets") return "unity_search_assets MCP resource";
  if (action === "get_logs") return "unity_logs MCP tool";
  if (action === "get_console") return "unity_console MCP tool";
  return `unity_${action} MCP tool`;
}

/**
 * Self-sufficient bridge IPC entry point.
 * Installs bridge, ensures readiness (bootstrapping if needed), sends request, polls for result.
 */
export async function sendBridgeRequest(
  projectPath: string,
  action: BridgeAction,
  opts?: {
    payload?: TestDiscoveryFilters | SearchPayload | LogsPayload | ConsolePayload;
    timeoutMs?: number;
  },
): Promise<BridgeResult> {
  // 1. Ensure Unity is running (launches if needed)
  const freshlyLaunched = await ensureUnityRunning(projectPath);

  // 2. Install bridge + ensure git exclude + create IPC dir
  const paths = bridgePaths(projectPath);
  ensureBridgeInstalled(projectPath);
  ensureGitExclude(projectPath);
  fs.mkdirSync(paths.ipcDir, { recursive: true });

  // 3. Ensure bridge ready — bootstrap if needed
  if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) {
    log("Bridge not ready, starting bootstrap flow");
    triggerEditorRefreshOnly(projectPath);

    const bootstrapTimeout = freshlyLaunched ? BRIDGE_READY_LAUNCH_TIMEOUT_MS : BRIDGE_READY_TIMEOUT_MS;
    const ready = await waitForBridgeReady(paths.readyFile, projectPath, bootstrapTimeout);
    if (!ready) {
      return { ok: false, error: "bridge_bootstrap_failed", message: "Bridge did not become ready after bootstrap refresh." };
    }

    // Send bootstrap handshake
    const handshakeResult = await sendRawRequest(projectPath, paths, "bootstrap_handshake");
    if (!handshakeResult.ok) return handshakeResult;

    log("Bridge bootstrap handshake succeeded");
  }

  // 4. Send the actual request
  return sendRawRequest(projectPath, paths, action, opts);
}

/**
 * Low-level: send a single bridge request and poll for status.
 * Used for both bootstrap_handshake (internal) and user-facing actions.
 */
async function sendRawRequest(
  projectPath: string,
  paths: ReturnType<typeof bridgePaths>,
  action: BridgeAction | "bootstrap_handshake",
  opts?: { payload?: TestDiscoveryFilters | SearchPayload | LogsPayload | ConsolePayload; timeoutMs?: number },
): Promise<BridgeResult> {
  const timeoutMs = opts?.timeoutMs ?? defaultTimeout(action);
  const requestId = generateRequestId();
  const statusPath = paths.statusFile(requestId);
  const requestPath = paths.requestFile(requestId);

  const request: BridgeRequest = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    requestedAtUnixMs: Date.now(),
    projectPath,
    action,
    reason: reasonForAction(action),
    source: "unity-mcp",
    payload: opts?.payload,
  };

  writeBridgeRequest(requestPath, request);

  const status = await waitForBridgeStatus(statusPath, requestId, timeoutMs);

  // Clean up status file after reading (happy-path cleanup)
  try { fs.unlinkSync(statusPath); } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") log(`Warning: failed to clean status file: ${e.message}`);
  }

  if (!status) {
    return { ok: false, error: "request_timeout", message: `Timed out waiting for bridge response (${action}).` };
  }

  // Version mismatch — detect explicitly instead of masking as timeout
  if (
    status.bridgeVersion !== BRIDGE_VERSION ||
    status.protocolVersion !== BRIDGE_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      error: "version_mismatch",
      message: `Bridge version mismatch (got version=${status.bridgeVersion} protocol=${status.protocolVersion}).`,
    };
  }

  if (status.state === "bridge_error") {
    return { ok: false, error: "bridge_error", message: status.summary || "Bridge error." };
  }

  // "failed" is a valid terminal state — return the full status so callers
  // can extract structured errors via parseBridgeStatusToResult.
  return { ok: true, status };
}
