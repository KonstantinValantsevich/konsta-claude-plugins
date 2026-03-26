import { sendBridgeRequest } from "../lib/bridge/request.js";
import type { SearchPayload, SearchResultEntry } from "../lib/bridge/types.js";
import type { Logger } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface SearchAssetsOptions {
  projectPath: string;
  query: string;
  limit?: number;
  logger?: Logger;
}

export type SearchAssetsResult =
  | { ok: true; results: SearchResultEntry[] }
  | { ok: false; error: string };

export async function searchAssets(opts: SearchAssetsOptions): Promise<SearchAssetsResult> {
  const logger = opts.logger ?? noopLogger;
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const payload: SearchPayload = { query: opts.query, limit };

  const result = await sendBridgeRequest(opts.projectPath, "search_assets", { payload });
  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const { status } = result;
  logger.log("search_assets request completed");

  return { ok: true, results: status.searchResults ?? [] };
}
