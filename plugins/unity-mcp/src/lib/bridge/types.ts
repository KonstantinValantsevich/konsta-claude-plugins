export interface BridgeRequest {
  protocolVersion: number;
  requestId: string;
  requestedAtUnixMs: number;
  projectPath: string;
  action: BridgeAction | "bootstrap_handshake";
  reason: string;
  source: string;
  payload?: TestDiscoveryFilters | SearchPayload | LogsPayload | ConsolePayload;
}

/** Filters for test discovery/execution — only flow into bridge requests */
export interface TestDiscoveryFilters {
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
}

/** Filters for post-hoc result viewing — only used on stored results */
export interface TestResultFilters {
  statusFilter?: "passed" | "failed" | "skipped";
  nameFilter?: string;
}

/** Payload for the search_assets bridge action */
export interface SearchPayload {
  query: string;
  limit: number;
}

/** A single search result entry returned by the search_assets action */
export interface SearchResultEntry {
  id: string;
  label: string;
  score: number;
}

/** Payload for get_logs bridge action */
export interface LogsPayload {
  cursor?: number;
  limit: number;
  filter?: string;
  search?: string;
}

/** Payload for get_console bridge action */
export interface ConsolePayload {
  limit: number;
  filter?: string;
  search?: string;
}

/** A single log entry returned by get_logs / get_console */
export interface LogEntry {
  id: number;
  type: "Log" | "Warning" | "Error" | "Exception" | "Assert";
  message: string;
  stackTrace: string;
  timestamp: number;
}

/** Response shape for get_logs and get_console */
export interface LogsResponse {
  entries: LogEntry[];
  nextCursor: number;
  totalBuffered: number;
  dropped: number;
}

export interface CompileError {
  assembly: string;
  file: string;
  line: number;
  column: number;
  message: string;
  type: string;
}

export interface TestListEntry {
  fullName: string;
  name: string;
  categories: string[];
  assembly: string;
}

export interface TestListResult {
  totalCount: number;
  matchedCount: number;
  tests: TestListEntry[];
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
    | "timeout"
    | "tests_finished"
    | "list_tests_finished";
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  didCompile: boolean;
  isSuccess: boolean;
  errors: CompileError[];
  summary: string;
  testResults?: TestResults;
  testList?: TestListResult;
  searchResults?: SearchResultEntry[];
  logsResponse?: LogsResponse;
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

// --- Bridge-Aware IPC Layer types ---

/** Actions that tools may request via sendBridgeRequest. */
export type BridgeAction = "recompile" | "run_tests" | "list_tests" | "search_assets" | "get_logs" | "get_console";

/** Discriminated union returned by sendBridgeRequest. */
export type BridgeResult =
  | { ok: true; status: BridgeStatus }
  | { ok: false; error: BridgeError; message: string };

export type BridgeError =
  | "unity_not_running"
  | "bridge_bootstrap_failed"
  | "bridge_error"
  | "compilation_failed"
  | "version_mismatch"
  | "request_timeout";
