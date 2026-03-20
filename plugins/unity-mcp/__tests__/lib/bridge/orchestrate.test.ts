import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("bridge orchestration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-orch-"));
    fs.mkdirSync(path.join(tmpDir, "Library", "ClaudeHookIPC"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bridgeRequestAndWait resolves when status file appears", async () => {
    const { bridgeRequestAndWait } = await import(
      "../../../src/lib/bridge/orchestrate.js"
    );

    const ipcDir = path.join(tmpDir, "Library", "ClaudeHookIPC");

    const resultPromise = bridgeRequestAndWait(
      tmpDir,
      "recompile",
      5_000,
    );

    // Read the request file to get the request ID
    await new Promise((r) => setTimeout(r, 200));
    const requestFile = path.join(ipcDir, "request.json");
    const request = JSON.parse(fs.readFileSync(requestFile, "utf-8"));

    // Simulate bridge response
    const statusFile = path.join(
      ipcDir,
      `status-${request.requestId}.json`,
    );
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        protocolVersion: 1,
        requestId: request.requestId,
        bridgeVersion: "3",
        projectPath: tmpDir,
        state: "completed",
        createdAtUnixMs: Date.now(),
        updatedAtUnixMs: Date.now(),
        didCompile: true,
        isSuccess: true,
        errors: [],
        summary: "OK",
      }),
    );

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("bridgeRequestAndWait returns failure on timeout", async () => {
    const { bridgeRequestAndWait } = await import(
      "../../../src/lib/bridge/orchestrate.js"
    );

    const result = await bridgeRequestAndWait(tmpDir, "recompile", 1_000);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Timed out");
  });
});
