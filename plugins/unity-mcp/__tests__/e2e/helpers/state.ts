import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface E2EState {
  projectPath: string;
  unityVersion: string;
  jbAvailable: boolean;
}

const STATE_FILE = path.join(os.tmpdir(), "unity-mcp-e2e-state.json");

export function writeState(state: E2EState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

export function readState(): E2EState {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

export function cleanupState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}
