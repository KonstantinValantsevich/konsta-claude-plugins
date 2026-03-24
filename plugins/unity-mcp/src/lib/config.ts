import path from "node:path";
import os from "node:os";

// Bridge protocol
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_VERSION = "4";

// Timeouts (milliseconds)
export const POLL_INTERVAL_MS = 500;
export const BRIDGE_READY_TIMEOUT_MS = 120_000;
export const BRIDGE_STATUS_TIMEOUT_MS = 120_000;
export const TEST_STATUS_TIMEOUT_MS = 300_000;
export const BRIDGE_BUSY_RETRY_DELAY_MS = 1_000;
export const BRIDGE_MAX_BUSY_RETRIES = 1;

// Paths
export const CACHE_DIR = path.join(os.homedir(), ".claude", "cache", "unity-recompile");
export const MARKER_DIR = path.join(CACHE_DIR, "markers");
export const TEST_STORE_DIR = path.join(CACHE_DIR, "test-runs");

// Bridge paths (relative to project root)
export const BRIDGE_ASSET_DIR = "Assets/Claude Bridge";
export const BRIDGE_EDITOR_DIR = "Assets/Claude Bridge/Editor";
export const BRIDGE_CS_FILES = [
  "ClaudeBridgeBase.cs",
  "ClaudeRecompileHandler.cs",
  "ClaudeTestHandler.cs",
];
export const BRIDGE_IPC_DIRNAME = "Library/ClaudeHookIPC";
export const BRIDGE_REQUEST_FILENAME = "request.json";
export const BRIDGE_READY_FILENAME = "bridge-ready.json";

// Legacy bridge paths (for migration)
export const LEGACY_BRIDGE_ASSET_DIR = "Assets/Recompile Hook";

// Git exclude patterns
export const GIT_EXCLUDE_PATTERNS = [
  "/Assets/Claude Bridge/",
  "/Assets/Claude Bridge.meta",
];

/** Resolve bridge paths for a given project root */
export function bridgePaths(projectPath: string) {
  const ipcDir = path.join(projectPath, BRIDGE_IPC_DIRNAME);
  return {
    bridgeRootDir: path.join(projectPath, BRIDGE_ASSET_DIR),
    bridgeEditorDir: path.join(projectPath, BRIDGE_EDITOR_DIR),
    bridgeFiles: BRIDGE_CS_FILES.map((f) =>
      path.join(projectPath, BRIDGE_EDITOR_DIR, f),
    ),
    ipcDir,
    requestFile: path.join(ipcDir, BRIDGE_REQUEST_FILENAME),
    readyFile: path.join(ipcDir, BRIDGE_READY_FILENAME),
    statusFile: (requestId: string) =>
      path.join(ipcDir, `status-${requestId}.json`),
  };
}
