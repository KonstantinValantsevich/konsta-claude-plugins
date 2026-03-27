import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../compile/applescript.js", () => ({
  unityIsRunning: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

describe("readUnityVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses version from ProjectVersion.txt", async () => {
    const fs = (await import("node:fs")).default;
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "m_EditorVersion: 2022.3.0f1\nm_EditorVersionWithRevision: 2022.3.0f1 (abc123)",
    );

    const { readUnityVersion } = await import("../launch.js");
    expect(readUnityVersion("/project")).toBe("2022.3.0f1");
  });

  it("returns null when file is missing", async () => {
    const fs = (await import("node:fs")).default;
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { readUnityVersion } = await import("../launch.js");
    expect(readUnityVersion("/project")).toBeNull();
  });

  it("returns null when version line is missing", async () => {
    const fs = (await import("node:fs")).default;
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("some other content");

    const { readUnityVersion } = await import("../launch.js");
    expect(readUnityVersion("/project")).toBeNull();
  });
});

describe("resolveUnityBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns path when binary exists", async () => {
    const fs = (await import("node:fs")).default;
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { resolveUnityBinary } = await import("../launch.js");
    expect(resolveUnityBinary("2022.3.0f1")).toBe(
      "/Applications/Unity/Hub/Editor/2022.3.0f1/Unity.app/Contents/MacOS/Unity",
    );
  });

  it("throws when binary does not exist", async () => {
    const fs = (await import("node:fs")).default;
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { resolveUnityBinary } = await import("../launch.js");
    expect(() => resolveUnityBinary("2022.3.0f1")).toThrow("unity_not_found");
  });
});

describe("ensureUnityRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns immediately when Unity is already running", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { ensureUnityRunning } = await import("../launch.js");
    await ensureUnityRunning("/project");

    const { spawn } = await import("node:child_process");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns Unity detached with correct args when not running", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const fs = (await import("node:fs")).default;
    const { spawn } = await import("node:child_process");

    // Not running initially, then running after spawn
    (unityIsRunning as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(false)  // initial check
      .mockReturnValueOnce(true);  // poll after spawn

    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "m_EditorVersion: 2022.3.0f1",
    );
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const mockUnref = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue({ unref: mockUnref });

    const { ensureUnityRunning } = await import("../launch.js");
    await ensureUnityRunning("/project");

    expect(spawn).toHaveBeenCalledWith(
      "/Applications/Unity/Hub/Editor/2022.3.0f1/Unity.app/Contents/MacOS/Unity",
      ["-projectPath", "/project", "-buildTarget", "iOS"],
      { detached: true, stdio: "ignore" },
    );
    expect(mockUnref).toHaveBeenCalled();
  });

  it("throws unity_launch_failed when process never appears", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const fs = (await import("node:fs")).default;
    const { spawn } = await import("node:child_process");

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "m_EditorVersion: 2022.3.0f1",
    );
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const mockUnref = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue({ unref: mockUnref });

    const { ensureUnityRunning } = await import("../launch.js");
    // Use a short timeout for the test
    await expect(ensureUnityRunning("/project", 100)).rejects.toThrow("unity_launch_failed");
  });

  it("throws when version cannot be read", async () => {
    const { unityIsRunning } = await import("../../compile/applescript.js");
    const fs = (await import("node:fs")).default;

    (unityIsRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { ensureUnityRunning } = await import("../launch.js");
    await expect(ensureUnityRunning("/project")).rejects.toThrow(
      "Could not detect Unity version",
    );
  });
});
