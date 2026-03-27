import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface WorktreeEntry {
  path: string;
  createdAt: number;
}

type WorktreeState = Record<string, WorktreeEntry>;

const DEFAULT_STATE_FILE_PATH = path.join(os.tmpdir(), "unity-mcp-worktrees.json");
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

let stateFilePath = DEFAULT_STATE_FILE_PATH;

/** Test-only: override state file path. */
export function _setStateFilePathForTest(p: string): void {
  stateFilePath = p;
}

export { stateFilePath as STATE_FILE_PATH };

export function readState(): WorktreeState {
  let state: WorktreeState;
  try {
    const raw = fs.readFileSync(stateFilePath, "utf-8");
    state = JSON.parse(raw);
  } catch {
    return {};
  }

  // Prune stale entries
  const now = Date.now();
  let pruned = false;
  for (const key of Object.keys(state)) {
    if (now - state[key].createdAt > STALE_THRESHOLD_MS) {
      delete state[key];
      pruned = true;
    }
  }
  if (pruned) {
    writeState(state);
  }
  return state;
}

export function writeState(state: WorktreeState): void {
  const dir = path.dirname(stateFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = stateFilePath + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFilePath);
}

export function registerWorktree(sessionId: string, worktreePath: string): void {
  const state = readState();
  state[sessionId] = { path: worktreePath, createdAt: Date.now() };
  writeState(state);
}

export function unregisterWorktree(sessionId: string): void {
  const state = readState();
  delete state[sessionId];
  writeState(state);
}

export function resolveTarget(sessionId: string, fallbackCwd: string): string {
  const state = readState();
  return state[sessionId]?.path ?? fallbackCwd;
}
