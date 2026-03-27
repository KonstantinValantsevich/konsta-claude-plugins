import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
const mockRecompile = vi.hoisted(() => vi.fn().mockResolvedValue({ skipped: true }));
const mockLint = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDetectProject = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockRegisterWorktree = vi.hoisted(() => vi.fn());
const mockUnregisterWorktree = vi.hoisted(() => vi.fn());
const mockResolveTarget = vi.hoisted(() => vi.fn((_, fallback) => fallback));

vi.mock("../../src/core/recompile.js", () => ({ recompile: mockRecompile }));
vi.mock("../../src/core/lint.js", () => ({ lint: mockLint }));
vi.mock("../../src/core/detect.js", () => ({ detectProject: mockDetectProject }));
vi.mock("../../src/hook/worktree-state.js", () => ({
  registerWorktree: mockRegisterWorktree,
  unregisterWorktree: mockUnregisterWorktree,
  resolveTarget: mockResolveTarget,
}));
vi.mock("../../src/lib/logger.js", () => ({ log: vi.fn() }));

import { handleHook } from "../../src/hook/index.js";

describe("hook routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTarget.mockImplementation((_, fallback) => fallback);
  });

  it("WorktreeCreate registers worktree and exits", async () => {
    const result = await handleHook({
      hook_event_name: "WorktreeCreate",
      session_id: "sess-1",
      cwd: "/main/project",
      worktree_path: "/tmp/worktree-feat",
    });
    expect(mockRegisterWorktree).toHaveBeenCalledWith("sess-1", "/tmp/worktree-feat");
    expect(result).toBe("registered");
    expect(mockRecompile).not.toHaveBeenCalled();
  });

  it("WorktreeRemove unregisters worktree and exits", async () => {
    const result = await handleHook({
      hook_event_name: "WorktreeRemove",
      session_id: "sess-1",
      cwd: "/main/project",
      worktree_path: "/tmp/worktree-feat",
    });
    expect(mockUnregisterWorktree).toHaveBeenCalledWith("sess-1");
    expect(result).toBe("unregistered");
    expect(mockRecompile).not.toHaveBeenCalled();
  });

  it("Stop resolves target via worktree state", async () => {
    mockResolveTarget.mockReturnValue("/tmp/worktree-feat");
    mockDetectProject.mockReturnValue("/tmp/worktree-feat");
    mockRecompile.mockResolvedValue({ skipped: true });

    await handleHook({
      hook_event_name: "Stop",
      session_id: "sess-1",
      cwd: "/main/project",
    });

    expect(mockResolveTarget).toHaveBeenCalledWith("sess-1", "/main/project");
    expect(mockDetectProject).toHaveBeenCalledWith("/tmp/worktree-feat");
  });

  it("SubagentStop resolves target via worktree state", async () => {
    mockResolveTarget.mockReturnValue("/fallback");
    mockDetectProject.mockReturnValue(null);

    await handleHook({
      hook_event_name: "SubagentStop",
      session_id: "sess-2",
      cwd: "/fallback",
    });

    expect(mockResolveTarget).toHaveBeenCalledWith("sess-2", "/fallback");
    expect(mockDetectProject).toHaveBeenCalledWith("/fallback");
    expect(mockRecompile).not.toHaveBeenCalled();
  });
});
