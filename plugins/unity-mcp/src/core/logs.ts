import { sendBridgeRequest } from "../lib/bridge/request.js";
import type { LogsPayload, LogEntry, LogsResponse } from "../lib/bridge/types.js";
import type { Logger } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export interface GetLogsOptions {
  projectPath: string;
  cursor?: number;
  limit?: number;
  filter?: string;
  search?: string;
  logger?: Logger;
}

export type GetLogsResult =
  | { ok: true; entries: LogEntry[]; nextCursor: number; totalBuffered: number; dropped: number; formatted: string }
  | { ok: false; error: string };

export function formatLogEntries(response: LogsResponse): string {
  const lines: string[] = [];

  for (const entry of response.entries) {
    const ts = `+${entry.timestamp.toFixed(2)}s`;
    lines.push(`[${entry.type}] ${entry.message} (id:${entry.id}, ${ts})`);
    if (entry.stackTrace) {
      lines.push(`  ${entry.stackTrace}`);
    }
  }

  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(`Cursor: ${response.nextCursor} | Buffered: ${response.totalBuffered} | Dropped: ${response.dropped}`);

  return lines.join("\n");
}

export async function getLogs(opts: GetLogsOptions): Promise<GetLogsResult> {
  const logger = opts.logger ?? noopLogger;
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const payload: LogsPayload = { limit };
  if (opts.cursor !== undefined) payload.cursor = opts.cursor;
  if (opts.filter) payload.filter = opts.filter;
  if (opts.search) payload.search = opts.search;

  const result = await sendBridgeRequest(opts.projectPath, "get_logs", { payload });
  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const { status } = result;
  logger.log("get_logs request completed");

  if (!status.isSuccess) {
    return { ok: false, error: status.summary || "get_logs failed" };
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
