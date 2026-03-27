import fs from "node:fs";
import { readState, cleanupState } from "./helpers/state.js";
import { closeUnityForProject } from "./helpers/unity.js";

export default async function globalTeardown(): Promise<void> {
  console.log("[E2E] Starting global teardown...");

  let state;
  try {
    state = readState();
  } catch {
    console.log("[E2E] No state file found, nothing to tear down");
    return;
  }

  // 1. Close Unity if still running
  if (state.projectPath) {
    console.log("[E2E] Closing Unity if running...");
    closeUnityForProject(state.projectPath);
    console.log("[E2E] Unity closed");

    // 2. Delete temp project
    console.log(`[E2E] Deleting project: ${state.projectPath}`);
    fs.rmSync(state.projectPath, { recursive: true, force: true });
    console.log("[E2E] Project deleted");
  }

  // 3. Cleanup state file
  cleanupState();

  console.log("[E2E] Global teardown complete");
}
