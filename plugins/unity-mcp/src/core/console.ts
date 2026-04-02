import { sendBridgeRequest } from "../lib/bridge/request.js";
import type { ConsolePayload, LogEntry, LogsResponse } from "../lib/bridge/types.js";
import { formatLogEntries } from "./logs.js";
import type { Logger } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export interface GetConsoleOptions {
  projectPath: string;
  limit?: number;
  filter?: string;
  search?: string;
  logger?: Logger;
}

export type GetConsoleResult =
  | { ok: true; entries: LogEntry[]; nextCursor: number; totalBuffered: number; dropped: number; formatted: string }
  | { ok: false; error: string };

export async function getConsole(opts: GetConsoleOptions): Promise<GetConsoleResult> {
  const logger = opts.logger ?? noopLogger;
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const payload: ConsolePayload = { limit };
  if (opts.filter) payload.filter = opts.filter;
  if (opts.search) payload.search = opts.search;

  const result = await sendBridgeRequest(opts.projectPath, "get_console", { payload });
  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const { status } = result;
  logger.log("get_console request completed");

  if (!status.isSuccess) {
    return { ok: false, error: status.summary || "get_console failed" };
  }

  const response = status.logsResponse ?? { entries: [], nextCursor: 0, totalBuffered: 0, dropped: 0 };
  return {
    ok: true,
    entries: response.entries,
    nextCursor: response.nextCursor,
    totalBuffered: response.totalBuffered,
    dropped: response.dropped,
    formatted: formatLogEntries(response),
  };
}
