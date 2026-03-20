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
