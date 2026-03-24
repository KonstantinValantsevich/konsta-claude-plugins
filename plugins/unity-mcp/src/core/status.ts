import fs from "node:fs";
import path from "node:path";
import { bridgePaths } from "../lib/config.js";
import { getMarkerPath } from "../lib/project/changes.js";
import { findUnityPid } from "../lib/compile/applescript.js";
import { readBridgeReady } from "../lib/bridge/ipc.js";
import type { Logger, StatusResult } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

function readUnityVersion(projectPath: string): string | null {
  const versionFile = path.join(
    projectPath,
    "ProjectSettings",
    "ProjectVersion.txt",
  );
  try {
    const content = fs.readFileSync(versionFile, "utf-8");
    const match = content.match(/m_EditorVersion:\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Gather diagnostic status for a Unity project.
 */
export async function getStatus(
  projectPath: string,
  logger: Logger = noopLogger,
): Promise<StatusResult> {
  logger.log("Gathering Unity project status");

  const unityVersion = readUnityVersion(projectPath);
  const editorPid = findUnityPid(projectPath);
  const pidNum = editorPid ? parseInt(editorPid, 10) : null;

  const paths = bridgePaths(projectPath);
  const bridgeReadyData = readBridgeReady(paths.readyFile);
  const bridgeReady = bridgeReadyData !== null;
  const bridgeVersion = bridgeReadyData
    ? parseInt(bridgeReadyData.bridgeVersion, 10)
    : null;
  const protocolVersion = bridgeReadyData?.protocolVersion ?? null;

  let lastRecompileMarker: Date | null = null;
  try {
    const markerPath = getMarkerPath(projectPath, "recompile");
    const stat = fs.statSync(markerPath);
    lastRecompileMarker = stat.mtime;
  } catch {
    // Marker doesn't exist
  }

  return {
    editorRunning: editorPid !== null,
    editorPid: pidNum,
    bridgeReady,
    bridgeVersion,
    protocolVersion,
    unityVersion,
    projectPath,
    lastRecompileMarker,
  };
}
