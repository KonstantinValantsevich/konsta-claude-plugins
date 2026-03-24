import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateRequestId,
  writeBridgeRequest,
  readBridgeStatus,
  parseBridgeStatusToResult,
} from "../../../src/lib/bridge/ipc.js";
import type { BridgeStatus } from "../../../src/lib/bridge/types.js";

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
        bridgeVersion: "4",
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

    it("routes testResults to testList when state is list_tests_finished", () => {
      const statusPath = path.join(tmpDir, "status-list.json");
      const testListPayload = {
        totalCount: 3,
        matchedCount: 2,
        tests: [
          { fullName: "NS.Test1", name: "Test1", categories: ["Cat1"], assembly: "Asm" },
          { fullName: "NS.Test2", name: "Test2", categories: [], assembly: "Asm" },
        ],
      };
      const raw = {
        protocolVersion: 1,
        requestId: "test-list-123",
        bridgeVersion: "4",
        projectPath: "/test",
        state: "list_tests_finished",
        createdAtUnixMs: Date.now(),
        updatedAtUnixMs: Date.now(),
        didCompile: false,
        isSuccess: true,
        errors: [],
        summary: "2 test(s) matched",
        testResults: JSON.stringify(testListPayload),
      };
      fs.writeFileSync(statusPath, JSON.stringify(raw));
      const status = readBridgeStatus(statusPath);
      expect(status!.testList).toEqual(testListPayload);
      expect(status!.testResults).toBeUndefined();
    });

    it("routes testResults normally for tests_finished state", () => {
      const statusPath = path.join(tmpDir, "status-run.json");
      const testResultsPayload = {
        totalCount: 1, passCount: 1, failCount: 0, skipCount: 0,
        inconclusiveCount: 0, duration: 0.5,
        tests: [{ fullName: "NS.T1", name: "T1", status: "Passed", duration: 0.5, message: null, stackTrace: null, output: null }],
      };
      const raw = {
        protocolVersion: 1,
        requestId: "test-run-456",
        bridgeVersion: "4",
        projectPath: "/test",
        state: "tests_finished",
        createdAtUnixMs: Date.now(),
        updatedAtUnixMs: Date.now(),
        didCompile: false,
        isSuccess: true,
        errors: [],
        summary: "All passed",
        testResults: JSON.stringify(testResultsPayload),
      };
      fs.writeFileSync(statusPath, JSON.stringify(raw));
      const status = readBridgeStatus(statusPath);
      expect(status!.testResults).toEqual(testResultsPayload);
      expect(status!.testList).toBeUndefined();
    });
  });

  describe("parseBridgeStatusToResult", () => {
    it("returns success for completed status with isSuccess=true", () => {
      const status: BridgeStatus = {
        protocolVersion: 1, requestId: "x", bridgeVersion: "4", projectPath: "/p",
        state: "completed", createdAtUnixMs: 0, updatedAtUnixMs: 0,
        didCompile: true, isSuccess: true, errors: [], summary: "OK",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("returns failure with formatted errors for failed status", () => {
      const status: BridgeStatus = {
        protocolVersion: 1, requestId: "x", bridgeVersion: "4", projectPath: "/p",
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
        protocolVersion: 1, requestId: "x", bridgeVersion: "4", projectPath: "/p",
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
