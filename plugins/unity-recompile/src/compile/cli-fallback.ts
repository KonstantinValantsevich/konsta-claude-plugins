import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import type { CompileResult } from "../bridge/types.js";

/**
 * Read the Unity version from ProjectSettings/ProjectVersion.txt.
 */
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
 * Run Unity in batch mode to refresh/compile the project.
 * Used when Unity Editor is not running.
 */
export function runCliFallback(projectPath: string): CompileResult {
  const version = readUnityVersion(projectPath);
  if (!version) {
    return {
      success: false,
      didCompile: false,
      errors: ["Could not detect Unity version from ProjectVersion.txt"],
    };
  }

  const unityPath = `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`;
  if (!fs.existsSync(unityPath)) {
    return {
      success: false,
      didCompile: false,
      errors: [
        `Unity not found at: ${unityPath}`,
        `Please ensure Unity ${version} is installed via Unity Hub`,
      ],
    };
  }

  process.stderr.write(
    "Unity not running. Starting batch compilation (this may take a moment)...\n",
  );
  log("CLI fallback: starting batch compilation");

  try {
    const output = execSync(
      `"${unityPath}" -batchmode -projectPath "${projectPath}" -executeMethod UnityEditor.AssetDatabase.Refresh -logFile - -quit 2>&1 | grep "error CS" || true`,
      { encoding: "utf-8", timeout: 300_000 },
    ).trim();

    const errors = output ? output.split("\n").filter(Boolean) : [];
    log(
      `CLI fallback: ${errors.length > 0 ? `${errors.length} errors` : "success"}`,
    );
    return {
      success: errors.length === 0,
      didCompile: true,
      errors,
    };
  } catch (err) {
    log(`CLI fallback failed: ${err}`);
    return {
      success: false,
      didCompile: false,
      errors: [`Batch compilation failed: ${err}`],
    };
  }
}
