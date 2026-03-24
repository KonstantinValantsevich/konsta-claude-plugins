export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export interface CompilationError {
  assembly: string;
  file: string;
  line: number;
  column: number;
  message: string;
  type: string;
}

export interface RecompileResult {
  success: boolean;
  skipped: boolean;
  errors: CompilationError[];
}

export interface StatusResult {
  editorRunning: boolean;
  editorPid: number | null;
  bridgeReady: boolean;
  bridgeVersion: number | null;
  protocolVersion: number | null;
  unityVersion: string | null;
  projectPath: string;
  lastRecompileMarker: Date | null;
}

export interface LintResult {
  filesLinted: number;
  success: boolean;
}

export interface StoredTestRun {
  runId: string;
  timestamp: string;
  projectPath: string;
  filters: {
    categoryNames?: string[];
    groupNames?: string[];
    assemblyNames?: string[];
  };
  results: {
    totalCount: number;
    passCount: number;
    failCount: number;
    skipCount: number;
    inconclusiveCount: number;
    duration: number;
    tests: {
      fullName: string;
      name: string;
      status: "Passed" | "Failed" | "Skipped" | "Inconclusive";
      duration: number;
      message: string | null;
      stackTrace: string | null;
      output: string | null;
    }[];
  };
}

export interface RunTestsResult {
  runId: string;
  formatted: string;
}

export interface TestResultsViewResult {
  formatted: string;
  stale: boolean;
}
