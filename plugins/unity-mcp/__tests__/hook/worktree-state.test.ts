import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readState,
  registerWorktree,
  unregisterWorktree,
  resolveTarget,
  _setStateFilePathForTest,
} from "../../src/hook/worktree-state.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-state-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("worktree-state", () => {
  let stateFile: string;

  beforeEach(() => {
    stateFile = path.join(tmpDir, "worktrees.json");
    _setStateFilePathForTest(stateFile);
  });

  it("returns empty state when file does not exist", () => {
    expect(readState()).toEqual({});
  });

  it("registerWorktree writes session entry", () => {
    registerWorktree("sess-1", "/path/to/worktree");
    const state = readState();
    expect(state["sess-1"]).toBeDefined();
    expect(state["sess-1"].path).toBe("/path/to/worktree");
    expect(state["sess-1"].createdAt).toBeTypeOf("number");
  });

  it("unregisterWorktree removes session entry", () => {
    registerWorktree("sess-1", "/path/to/worktree");
    unregisterWorktree("sess-1");
    expect(readState()).toEqual({});
  });

  it("resolveTarget returns worktree path when session has entry", () => {
    registerWorktree("sess-1", "/path/to/worktree");
    expect(resolveTarget("sess-1", "/fallback")).toBe("/path/to/worktree");
  });

  it("resolveTarget returns fallback cwd when no entry exists", () => {
    expect(resolveTarget("sess-unknown", "/fallback")).toBe("/fallback");
  });

  it("prunes entries older than 24 hours on read", () => {
    const staleState = {
      "old-sess": {
        path: "/old/worktree",
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      },
      "new-sess": {
        path: "/new/worktree",
        createdAt: Date.now(),
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(staleState));
    const state = readState();
    expect(state["old-sess"]).toBeUndefined();
    expect(state["new-sess"]).toBeDefined();
  });

  it("registers multiple sessions independently", () => {
    registerWorktree("sess-a", "/worktree-a");
    registerWorktree("sess-b", "/worktree-b");
    const state = readState();
    expect(state["sess-a"].path).toBe("/worktree-a");
    expect(state["sess-b"].path).toBe("/worktree-b");
  });
});
