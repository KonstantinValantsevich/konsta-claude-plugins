import path from "node:path";
import os from "node:os";

// Bridge protocol
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_VERSION = "3";

// Timeouts (milliseconds)
export const POLL_INTERVAL_MS = 500;
export const BRIDGE_READY_TIMEOUT_MS = 120_000;
export const BRIDGE_STATUS_TIMEOUT_MS = 120_000;
export const BRIDGE_BUSY_RETRY_DELAY_MS = 1_000;
export const BRIDGE_MAX_BUSY_RETRIES = 1;

// Paths
export const CACHE_DIR = path.join(os.homedir(), ".claude", "cache", "unity-recompile");
export const MARKER_DIR = path.join(CACHE_DIR, "markers");

// Bridge paths (relative to project root)
export const BRIDGE_ASSET_DIR = "Assets/Recompile Hook";
export const BRIDGE_EDITOR_DIR = "Assets/Recompile Hook/Editor";
export const BRIDGE_CS_FILENAME = "ClaudeRecompileBridge.cs";
export const BRIDGE_IPC_DIRNAME = "Library/ClaudeHookIPC";
export const BRIDGE_REQUEST_FILENAME = "request.json";
export const BRIDGE_READY_FILENAME = "bridge-ready.json";

// Git exclude patterns
export const GIT_EXCLUDE_PATTERNS = [
  "/Assets/Recompile Hook/",
  "/Assets/Recompile Hook.meta",
];

/** Resolve bridge paths for a given project root */
export function bridgePaths(projectPath: string) {
  const ipcDir = path.join(projectPath, BRIDGE_IPC_DIRNAME);
  return {
    bridgeRootDir: path.join(projectPath, BRIDGE_ASSET_DIR),
    bridgeEditorDir: path.join(projectPath, BRIDGE_EDITOR_DIR),
    bridgeFile: path.join(projectPath, BRIDGE_EDITOR_DIR, BRIDGE_CS_FILENAME),
    ipcDir,
    requestFile: path.join(ipcDir, BRIDGE_REQUEST_FILENAME),
    readyFile: path.join(ipcDir, BRIDGE_READY_FILENAME),
    statusFile: (requestId: string) =>
      path.join(ipcDir, `status-${requestId}.json`),
  };
}
