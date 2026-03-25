import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  findLatestUnityVersion,
  unityBinaryPath,
  unityAppPath,
  createUnityProject,
  openUnityEditor,
  waitForUnityProcess,
  waitForEditorLogRefresh,
  isJbAvailable,
} from "./helpers/unity.js";
import { writeState } from "./helpers/state.js";

export default async function globalSetup(): Promise<void> {
  console.log("[E2E] Starting global setup...");

  // 1. Find Unity
  const version = findLatestUnityVersion();
  console.log(`[E2E] Found Unity version: ${version}`);

  // 2. Check jb
  const jbAvailable = isJbAvailable();
  console.log(`[E2E] jb CLI available: ${jbAvailable}`);

  // 3. Create temp project
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "unity-mcp-e2e-"),
  );
  console.log(`[E2E] Creating Unity project at: ${projectDir}`);
  createUnityProject(unityBinaryPath(version), projectDir);
  console.log("[E2E] Unity project created");

  // 4. Init git + tag baseline
  execSync("git init", { cwd: projectDir, stdio: "ignore" });
  execSync("git add -A", { cwd: projectDir, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: projectDir, stdio: "ignore" });
  execSync("git tag e2e-baseline", { cwd: projectDir, stdio: "ignore" });
  console.log("[E2E] Git initialized with e2e-baseline tag");

  // 5. Open editor (non-batch)
  const startTime = new Date();
  console.log("[E2E] Opening Unity Editor...");
  openUnityEditor(unityAppPath(version), projectDir);

  // 6. Wait for Unity process
  const pid = await waitForUnityProcess(projectDir);
  console.log(`[E2E] Unity process detected: PID ${pid}`);

  // 7. Wait for editor to finish loading
  console.log("[E2E] Waiting for editor 'Refresh completed'...");
  await waitForEditorLogRefresh(300_000, startTime);
  console.log("[E2E] Editor ready");

  // 8. Write shared state
  writeState({
    projectPath: projectDir,
    unityVersion: version,
    unityPid: pid,
    jbAvailable,
  });

  console.log("[E2E] Global setup complete");
}
