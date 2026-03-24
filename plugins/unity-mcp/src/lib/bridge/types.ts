export interface BridgeRequest {
  protocolVersion: number;
  requestId: string;
  requestedAtUnixMs: number;
  projectPath: string;
  action: "recompile" | "bootstrap_handshake" | "run_tests";
  reason: string;
  source: string;
  payload?: TestRunPayload;
}

export interface TestRunPayload {
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
}

export interface CompileError {
  assembly: string;
  file: string;
  line: number;
  column: number;
  message: string;
  type: string;
}

export interface BridgeStatus {
  protocolVersion: number;
  requestId: string;
  bridgeVersion: string;
  projectPath: string;
  state:
    | "queued"
    | "refresh_requested"
    | "compilation_started"
    | "compilation_finished"
    | "completed"
    | "failed"
    | "bridge_error"
    | "busy"
    | "timeout"
    | "tests_finished";
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  didCompile: boolean;
  isSuccess: boolean;
  errors: CompileError[];
  summary: string;
  testResults?: TestResults;
}

export interface TestResults {
  totalCount: number;
  passCount: number;
  failCount: number;
  skipCount: number;
  inconclusiveCount: number;
  duration: number;
  tests: TestResultEntry[];
}

export interface TestResultEntry {
  fullName: string;
  name: string;
  status: "Passed" | "Failed" | "Skipped" | "Inconclusive";
  duration: number;
  message: string | null;
  stackTrace: string | null;
  output: string | null;
}

export interface BridgeReady {
  protocolVersion: number;
  bridgeVersion: string;
  projectPath: string;
  readyAtUnixMs: number;
}

export interface CompileResult {
  success: boolean;
  didCompile: boolean;
  errors: string[];
}
