import crypto from "node:crypto";
import fs from "node:fs";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  POLL_INTERVAL_MS,
} from "../config.js";
import { log } from "../logger.js";
import type { BridgeRequest, BridgeStatus, CompileResult } from "./types.js";

/** Generate a unique request ID: `{unixSecs}-{pid}-{randomHex}` */
export function generateRequestId(): string {
  const secs = Math.floor(Date.now() / 1000);
  const rnd = crypto.randomBytes(4).toString("hex");
  return `${secs}-${process.pid}-${rnd}`;
}

/** Write a bridge request JSON file atomically. */
export function writeBridgeRequest(
  requestFilePath: string,
  request: BridgeRequest,
): void {
  const tmpPath = requestFilePath + ".tmp";
  // C# RequestPayload.payload is a string field — pre-serialize nested object
  const wire: Record<string, unknown> = { ...request };
  if (request.payload && typeof request.payload === "object") {
    wire.payload = JSON.stringify(request.payload);
  }
  fs.writeFileSync(tmpPath, JSON.stringify(wire));
  fs.renameSync(tmpPath, requestFilePath);
  const now = new Date();
  fs.utimesSync(requestFilePath, now, now);
  log(`Wrote bridge request: action=${request.action} requestId=${request.requestId}`);
}

/** Read and parse a bridge status JSON file. Returns null if missing or invalid. */
export function readBridgeStatus(statusPath: string): BridgeStatus | null {
  try {
    if (!fs.existsSync(statusPath)) return null;
    const content = fs.readFileSync(statusPath, "utf-8");
    // Parse with loose typing first since C# bridge may serialize testResults as a JSON string
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (typeof raw.testResults === "string" && raw.testResults) {
      try {
        const parsed = JSON.parse(raw.testResults as string);
        if (raw.state === "list_tests_finished") {
          raw.testList = parsed;
          delete raw.testResults;
        } else {
          raw.testResults = parsed;
        }
      } catch {
        // Leave as-is if parsing fails
      }
    }
    return raw as unknown as BridgeStatus;
  } catch {
    return null;
  }
}

/** Read and parse the bridge-ready JSON file. */
export function readBridgeReady(
  readyPath: string,
): { protocolVersion: number; bridgeVersion: string; projectPath: string } | null {
  try {
    if (!fs.existsSync(readyPath)) return null;
    return JSON.parse(fs.readFileSync(readyPath, "utf-8"));
  } catch {
    return null;
  }
}

/** Check if bridge-ready file matches the expected project and version. */
export function bridgeReadyMatchesProject(
  readyPath: string,
  projectPath: string,
): boolean {
  const ready = readBridgeReady(readyPath);
  if (!ready) return false;
  return (
    ready.projectPath === projectPath &&
    ready.bridgeVersion === BRIDGE_VERSION &&
    ready.protocolVersion === BRIDGE_PROTOCOL_VERSION
  );
}

/** Convert a BridgeStatus to a CompileResult with formatted error strings. */
export function parseBridgeStatusToResult(status: BridgeStatus): CompileResult {
  if (
    status.bridgeVersion !== BRIDGE_VERSION ||
    status.protocolVersion !== BRIDGE_PROTOCOL_VERSION
  ) {
    return {
      success: false,
      didCompile: false,
      errors: [
        `Bridge status version mismatch (got version=${status.bridgeVersion} protocol=${status.protocolVersion})`,
      ],
    };
  }
  if (status.state === "bridge_error" || status.state === "timeout") {
    return {
      success: false,
      didCompile: false,
      errors: [status.summary || "Bridge error"],
    };
  }
  if (status.isSuccess) {
    return { success: true, didCompile: status.didCompile, errors: [] };
  }
  const errors = (status.errors || []).map((e) => {
    if (e.message?.startsWith(`${e.file}(`)) return e.message;
    if (e.file) return `${e.file}(${e.line},${e.column}): ${e.message}`;
    return e.message;
  });
  if (errors.length === 0)
    errors.push(status.summary || "Unity compilation failed");
  return { success: false, didCompile: status.didCompile, errors };
}

/** Sleep for a given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "bridge_error",
  "timeout",
  "tests_finished",
  "list_tests_finished",
]);

/**
 * Poll for the bridge-ready file to match the expected project.
 */
export async function waitForBridgeReady(
  readyPath: string,
  projectPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bridgeReadyMatchesProject(readyPath, projectPath)) {
      log("Bridge ready file detected for project");
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log("Timed out waiting for bridge-ready.json");
  return false;
}

/**
 * Poll for a bridge status file with the matching request ID and terminal state.
 */
export async function waitForBridgeStatus(
  statusPath: string,
  requestId: string,
  timeoutMs: number,
): Promise<BridgeStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readBridgeStatus(statusPath);
    if (status && status.requestId === requestId) {
      if (
        status.bridgeVersion !== BRIDGE_VERSION ||
        status.protocolVersion !== BRIDGE_PROTOCOL_VERSION
      ) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (TERMINAL_STATES.has(status.state)) {
        log(
          `Bridge status final: requestId=${requestId} state=${status.state}`,
        );
        return status;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log(`Timed out waiting for bridge status: requestId=${requestId}`);
  return null;
}
