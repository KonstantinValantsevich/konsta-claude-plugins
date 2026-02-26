import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateRequestId,
  writeBridgeRequest,
  readBridgeStatus,
  parseBridgeStatusToResult,
} from "../../src/bridge/ipc.js";
import type { BridgeStatus } from "../../src/bridge/types.js";

describe("bridge IPC", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-ipc-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("generateRequestId", () => {
    it("returns a non-empty string", () => {
      const id = generateRequestId();
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("returns unique IDs on consecutive calls", () => {
      const a = generateRequestId();
      const b = generateRequestId();
      expect(a).not.toBe(b);
    });
  });

  describe("writeBridgeRequest", () => {
    it("writes valid JSON to the request file path", () => {
      const requestFile = path.join(tmpDir, "request.json");
      writeBridgeRequest(requestFile, {
        protocolVersion: 1,
        requestId: "test-123",
        requestedAtUnixMs: Date.now(),
        projectPath: "/test/project",
        action: "recompile",
        reason: "test",
        source: "test",
      });
      expect(fs.existsSync(requestFile)).toBe(true);
      const content = JSON.parse(fs.readFileSync(requestFile, "utf-8"));
      expect(content.requestId).toBe("test-123");
      expect(content.action).toBe("recompile");
    });
  });

  describe("readBridgeStatus", () => {
    it("returns null when file does not exist", () => {
      expect(readBridgeStatus(path.join(tmpDir, "nope.json"))).toBeNull();
    });

    it("parses valid status JSON", () => {
      const statusPath = path.join(tmpDir, "status.json");
      const status: BridgeStatus = {
        protocolVersion: 1,
        requestId: "test-123",
        bridgeVersion: "3",
        projectPath: "/test",
        state: "completed",
        createdAtUnixMs: Date.now(),
        updatedAtUnixMs: Date.now(),
        didCompile: true,
        isSuccess: true,
        errors: [],
        summary: "OK",
      };
      fs.writeFileSync(statusPath, JSON.stringify(status));
      expect(readBridgeStatus(statusPath)).toEqual(status);
    });
  });

  describe("parseBridgeStatusToResult", () => {
    it("returns success for completed status with isSuccess=true", () => {
      const status: BridgeStatus = {
        protocolVersion: 1, requestId: "x", bridgeVersion: "3", projectPath: "/p",
        state: "completed", createdAtUnixMs: 0, updatedAtUnixMs: 0,
        didCompile: true, isSuccess: true, errors: [], summary: "OK",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("returns failure with formatted errors for failed status", () => {
      const status: BridgeStatus = {
        protocolVersion: 1, requestId: "x", bridgeVersion: "3", projectPath: "/p",
        state: "failed", createdAtUnixMs: 0, updatedAtUnixMs: 0,
        didCompile: true, isSuccess: false,
        errors: [{
          assembly: "Assembly-CSharp", file: "Assets/Test.cs",
          line: 10, column: 5, message: "error CS1001: ; expected", type: "Error",
        }],
        summary: "Compilation failed",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it("returns failure for busy state", () => {
      const status: BridgeStatus = {
        protocolVersion: 1, requestId: "x", bridgeVersion: "3", projectPath: "/p",
        state: "busy", createdAtUnixMs: 0, updatedAtUnixMs: 0,
        didCompile: false, isSuccess: false, errors: [], summary: "Bridge is busy",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("busy");
    });

    it("returns failure for version mismatch", () => {
      const status: BridgeStatus = {
        protocolVersion: 99, requestId: "x", bridgeVersion: "99", projectPath: "/p",
        state: "completed", createdAtUnixMs: 0, updatedAtUnixMs: 0,
        didCompile: true, isSuccess: true, errors: [], summary: "OK",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("mismatch");
    });
  });
});
