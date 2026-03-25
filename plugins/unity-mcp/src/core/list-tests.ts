import { sendBridgeRequest } from "../lib/bridge/request.js";
import type { TestDiscoveryFilters } from "../lib/bridge/types.js";
import type { Logger, ListTestsResult } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

export interface ListTestsOptions {
  projectPath: string;
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
  logger?: Logger;
}

export async function listTests(opts: ListTestsOptions): Promise<ListTestsResult> {
  const logger = opts.logger ?? noopLogger;
  const empty: ListTestsResult = { formatted: "", totalCount: 0, matchedCount: 0 };

  const payload: TestDiscoveryFilters = {};
  if (opts.categoryNames?.length) payload.categoryNames = opts.categoryNames;
  if (opts.groupNames?.length) payload.groupNames = opts.groupNames;
  if (opts.assemblyNames?.length) payload.assemblyNames = opts.assemblyNames;

  const result = await sendBridgeRequest(opts.projectPath, "list_tests", { payload });
  if (!result.ok) {
    return { ...empty, formatted: result.message };
  }

  const { status } = result;
  logger.log("list_tests request completed");

  if (!status.testList) {
    return { ...empty, formatted: "Bridge returned no test list." };
  }

  const { totalCount, matchedCount, tests } = status.testList;

  return {
    formatted: formatTestList(tests, totalCount, matchedCount, payload),
    totalCount,
    matchedCount,
  };
}

function formatTestList(
  tests: { fullName: string; name: string; categories: string[]; assembly: string }[],
  totalCount: number,
  matchedCount: number,
  filters: TestDiscoveryFilters,
): string {
  if (totalCount === 0) {
    return "No EditMode tests found.";
  }

  const hasFilters = !!(filters.categoryNames?.length || filters.groupNames?.length || filters.assemblyNames?.length);

  if (matchedCount === 0 && hasFilters) {
    return `No EditMode tests matched the filter (${totalCount} total).`;
  }

  const lines: string[] = [];

  if (hasFilters) {
    const filterParts: string[] = [];
    if (filters.categoryNames?.length) filterParts.push(`categoryNames=${JSON.stringify(filters.categoryNames)}`);
    if (filters.groupNames?.length) filterParts.push(`groupNames=${JSON.stringify(filters.groupNames)}`);
    if (filters.assemblyNames?.length) filterParts.push(`assemblyNames=${JSON.stringify(filters.assemblyNames)}`);
    lines.push(`Matched ${matchedCount} of ${totalCount} EditMode tests (filter: ${filterParts.join(", ")}):`);
  } else {
    lines.push(`Available EditMode tests (${totalCount} total):`);
  }

  const byAssembly = new Map<string, typeof tests>();
  for (const test of tests) {
    const group = byAssembly.get(test.assembly) ?? [];
    group.push(test);
    byAssembly.set(test.assembly, group);
  }

  for (const [assembly, assemblyTests] of byAssembly) {
    lines.push("");
    lines.push(`  ${assembly}`);
    for (const t of assemblyTests) {
      const cats = t.categories.length > 0 ? ` [${t.categories.join(", ")}]` : "";
      lines.push(`    ${t.fullName}${cats}`);
    }
  }

  return lines.join("\n");
}
