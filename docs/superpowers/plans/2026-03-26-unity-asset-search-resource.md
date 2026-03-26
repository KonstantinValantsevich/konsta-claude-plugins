# Unity Asset Search Resource Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two MCP resources to the Unity MCP plugin — a dynamic search resource (`unity://assets/search/{query}`) that queries Unity's Search API via the bridge, and a static syntax reference resource (`unity://assets/search-syntax`).

**Architecture:** Extends the existing file-based IPC bridge with a new `"search_assets"` action. A new C# handler (`ClaudeSearchHandler.cs`) uses `UnityEditor.Search.SearchService` to execute queries. The TypeScript side adds a new core module (`search.ts`) and registers both resources in `server.ts`. The C# `StatusPayload` gets a dedicated `searchResults` field (not reusing `testResults`) to avoid fragile disambiguation logic in `readBridgeStatus`.

**Tech Stack:** TypeScript (MCP SDK `McpServer.registerResource()` / `ResourceTemplate`), C# (Unity `UnityEditor.Search` API), Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-03-26-unity-asset-search-resource-design.md`

---

### Task 1: Add bridge types for search

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/types.ts`

- [ ] **Step 1: Write failing test — new types compile**

Create a test file that imports the new types to verify they exist.

```typescript
// File: plugins/unity-mcp/__tests__/lib/bridge/search-types.test.ts
import { describe, it, expect } from "vitest";
import type { SearchPayload, SearchResultEntry, BridgeAction } from "../../../src/lib/bridge/types.js";

describe("search bridge types", () => {
  it("SearchPayload has query and limit fields", () => {
    const payload: SearchPayload = { query: "t:prefab", limit: 100 };
    expect(payload.query).toBe("t:prefab");
    expect(payload.limit).toBe(100);
  });

  it("SearchResultEntry has id, label, score fields", () => {
    const entry: SearchResultEntry = { id: "Assets/Foo.prefab", label: "Foo", score: 0 };
    expect(entry.id).toBe("Assets/Foo.prefab");
  });

  it("BridgeAction includes search_assets", () => {
    const action: BridgeAction = "search_assets";
    expect(action).toBe("search_assets");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/lib/bridge/search-types.test.ts`
Expected: FAIL — `SearchPayload` and `SearchResultEntry` don't exist yet.

- [ ] **Step 3: Add types to types.ts**

In `plugins/unity-mcp/src/lib/bridge/types.ts`:

Add after the `TestResultFilters` interface:

```typescript
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
```

Update the `BridgeAction` type to include `"search_assets"`:

```typescript
export type BridgeAction = "recompile" | "run_tests" | "list_tests" | "search_assets";
```

Update `BridgeRequest.action` to reference `BridgeAction` instead of repeating the union:

```typescript
action: BridgeAction | "bootstrap_handshake";
```

Generalize `BridgeRequest.payload`:

```typescript
payload?: TestDiscoveryFilters | SearchPayload;
```

Add `searchResults` field to `BridgeStatus`:

```typescript
searchResults?: SearchResultEntry[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/lib/bridge/search-types.test.ts`
Expected: PASS

- [ ] **Step 5: Run all existing tests to check nothing broke**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/unity-mcp/src/lib/bridge/types.ts plugins/unity-mcp/__tests__/lib/bridge/search-types.test.ts
git commit -m "feat: add search bridge types (SearchPayload, SearchResultEntry, BridgeAction)"
```

---

### Task 2: Update bridge request layer for search

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/request.ts`
- Modify: `plugins/unity-mcp/src/lib/bridge/ipc.ts`

- [ ] **Step 1: Update sendBridgeRequest opts to accept SearchPayload**

In `plugins/unity-mcp/src/lib/bridge/request.ts`:

Update the import to include `SearchPayload`:

```typescript
import type { BridgeAction, BridgeRequest, BridgeResult, SearchPayload } from "./types.js";
import type { TestDiscoveryFilters } from "./types.js";
```

Update the `opts` parameter type in `sendBridgeRequest`:

```typescript
opts?: {
  payload?: TestDiscoveryFilters | SearchPayload;
  timeoutMs?: number;
},
```

Update the `opts` parameter type in `sendRawRequest`:

```typescript
opts?: { payload?: TestDiscoveryFilters | SearchPayload; timeoutMs?: number },
```

Update `reasonForAction` to handle search:

```typescript
function reasonForAction(action: BridgeAction | "bootstrap_handshake"): string {
  if (action === "bootstrap_handshake") return "bridge bootstrap handshake";
  if (action === "search_assets") return "unity_search_assets MCP resource";
  return `unity_${action} MCP tool`;
}
```

- [ ] **Step 2: Update readBridgeStatus in ipc.ts to parse search results**

In `plugins/unity-mcp/src/lib/bridge/ipc.ts`, update the `readBridgeStatus` function. Search results come through a dedicated `searchResults` wire field (separate from `testResults`) to avoid fragile disambiguation. Add parsing for `searchResults` after the existing `testResults` parsing:

```typescript
export function readBridgeStatus(statusPath: string): BridgeStatus | null {
  try {
    if (!fs.existsSync(statusPath)) return null;
    const content = fs.readFileSync(statusPath, "utf-8");
    // Parse with loose typing first since C# bridge may serialize testResults as a JSON string
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (typeof raw.testResults === "string" && raw.testResults) {
      try {
        const parsed = JSON.parse(raw.testResults as string);
        if (raw.state === "list_tests_finished") {
          raw.testList = parsed;
          delete raw.testResults;
        } else {
          raw.testResults = parsed;
        }
      } catch {
        // Leave as-is if parsing fails
      }
    }
    // Parse searchResults — dedicated wire field from ClaudeSearchHandler
    if (typeof raw.searchResults === "string" && raw.searchResults) {
      try {
        raw.searchResults = JSON.parse(raw.searchResults as string);
      } catch {
        // Leave as-is if parsing fails
      }
    }
    return raw as unknown as BridgeStatus;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Run all existing tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All tests still pass — existing behavior unchanged (test results have state `"tests_finished"`, not `"completed"`, so the new branch is never hit for old tests).

- [ ] **Step 4: Commit**

```bash
git add plugins/unity-mcp/src/lib/bridge/request.ts plugins/unity-mcp/src/lib/bridge/ipc.ts
git commit -m "feat: update bridge request layer to support search_assets action"
```

---

### Task 3: Create core search module

**Files:**
- Create: `plugins/unity-mcp/src/core/search.ts`
- Create: `plugins/unity-mcp/__tests__/core/search.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// File: plugins/unity-mcp/__tests__/core/search.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/lib/bridge/ipc.js", () => ({
  generateRequestId: () => "mock-search-req-id",
  writeBridgeRequest: vi.fn(),
  waitForBridgeStatus: vi.fn(),
  sleep: vi.fn(),
  bridgeReadyMatchesProject: vi.fn(() => true),
  readBridgeStatus: vi.fn(),
}));

vi.mock("../../src/lib/compile/applescript.js", () => ({
  unityIsRunning: vi.fn(() => true),
}));

import { searchAssets } from "../../src/core/search.js";
import { waitForBridgeStatus } from "../../src/lib/bridge/ipc.js";
import { unityIsRunning } from "../../src/lib/compile/applescript.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

describe("searchAssets", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-proj-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "Library", "ClaudeHookIPC"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns error when Unity is not running", async () => {
    vi.mocked(unityIsRunning).mockReturnValue(false);
    const result = await searchAssets({ projectPath: projectDir, query: "t:prefab" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unity editor is not running");
    }
  });

  it("returns error on timeout", async () => {
    vi.mocked(waitForBridgeStatus).mockResolvedValue(null);
    const result = await searchAssets({ projectPath: projectDir, query: "t:prefab" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Timed out");
    }
  });

  it("returns search results on success", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-search-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Search completed",
      searchResults: [
        { id: "Assets/Prefabs/Enemy.prefab", label: "Enemy", score: 0 },
        { id: "Assets/Prefabs/Ally.prefab", label: "Ally", score: 10 },
      ],
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await searchAssets({ projectPath: projectDir, query: "t:prefab" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe("Assets/Prefabs/Enemy.prefab");
      expect(result.results[0].label).toBe("Enemy");
      expect(result.results[0].score).toBe(0);
    }
  });

  it("returns empty array when no results", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-search-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Search completed",
      searchResults: [],
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await searchAssets({ projectPath: projectDir, query: "nonexistent" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toEqual([]);
    }
  });

  it("clamps limit to 500 max", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-search-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Search completed",
      searchResults: [],
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const { writeBridgeRequest } = await import("../../src/lib/bridge/ipc.js");
    await searchAssets({ projectPath: projectDir, query: "t:prefab", limit: 9999 });

    const call = vi.mocked(writeBridgeRequest).mock.calls[0];
    const request = call[1];
    expect((request.payload as { limit: number }).limit).toBe(500);
  });

  it("defaults limit to 100", async () => {
    const mockStatus = {
      protocolVersion: 1,
      requestId: "mock-search-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "completed",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Search completed",
      searchResults: [],
    } as BridgeStatus;
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const { writeBridgeRequest } = await import("../../src/lib/bridge/ipc.js");
    await searchAssets({ projectPath: projectDir, query: "t:prefab" });

    const call = vi.mocked(writeBridgeRequest).mock.calls[0];
    const request = call[1];
    expect((request.payload as { limit: number }).limit).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/search.test.ts`
Expected: FAIL — `search.ts` doesn't exist yet.

- [ ] **Step 3: Implement search.ts**

```typescript
// File: plugins/unity-mcp/src/core/search.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/core/search.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/unity-mcp/src/core/search.ts plugins/unity-mcp/__tests__/core/search.test.ts
git commit -m "feat: add core searchAssets module"
```

---

### Task 4: Register MCP resources in server.ts

**Files:**
- Modify: `plugins/unity-mcp/src/mcp/server.ts`
- Modify: `plugins/unity-mcp/__tests__/mcp/server.test.ts`

- [ ] **Step 1: Write failing test — resources are registered**

Update `plugins/unity-mcp/__tests__/mcp/server.test.ts`:

Add a new test after the existing one:

```typescript
it("registers asset search resource template and syntax resource", async () => {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  const { resourceTemplates } = await client.listResourceTemplates();
  const templateNames = resourceTemplates.map((t) => t.name);
  expect(templateNames).toContain("unity_asset_search");

  const { resources } = await client.listResources();
  const resourceNames = resources.map((r) => r.name);
  expect(resourceNames).toContain("unity_asset_search_syntax");

  await client.close();
  await server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/mcp/server.test.ts`
Expected: FAIL — resources not registered yet.

- [ ] **Step 3: Add resource registrations to server.ts**

In `plugins/unity-mcp/src/mcp/server.ts`:

Add imports at the top:

```typescript
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchAssets } from "../core/search.js";
```

Add the following after the last `server.tool(...)` call (before `return server;`):

```typescript
// --- MCP Resources ---

const SEARCH_SYNTAX_CONTENT = `# Unity Asset Search Syntax Reference

## Filter Tokens

| Token | Description | Example |
|-------|-------------|---------|
| \`t:\` / \`t=\` | Type (partial/exact) | \`t:prefab\`, \`t=Texture2D\` |
| \`l:\` / \`l=\` | Label (partial/exact) | \`l:arch\`, \`l=Wall\` |
| \`ref:\` | References asset | \`ref:Crystal\`, \`ref="Assets/Prefabs/Crystal.prefab"\` |
| \`ext:\` | File extension | \`ext:png\`, \`ext:cs\` |
| \`dir:\` | Directory scope | \`dir:Assets/Prefabs\` |
| \`name:\` | File name | \`name:laser\` |
| \`size\` | File size (bytes) | \`size>4096\`, \`size<=1024\` |
| \`age\` | Days since modified | \`age<3\`, \`age>30\` |
| \`a:\` | Area | \`a:assets\`, \`a:packages\`, \`a:all\` |
| \`prefab:\` | Prefab type | \`prefab:root\`, \`prefab:variant\`, \`prefab:model\`, \`prefab:modified\` |
| \`is:\` | State filter | \`is:subasset\` |
| \`missing:\` | Missing refs | \`missing:scripts\` |

## Comparison Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| \`:\` | Contains/partial | \`t:texture\` |
| \`=\` | Exact match | \`t=Texture2D\` |
| \`!=\` | Not equal | \`filtermode!=0\` |
| \`>\` | Greater than | \`size>4096\` |
| \`<\` | Less than | \`age<3\` |
| \`>=\` | Greater or equal | \`width>=4096\` |
| \`<=\` | Less or equal | \`bounciness<=0.5\` |

## Boolean Logic

| Syntax | Meaning | Example |
|--------|---------|---------|
| space | AND (implicit) | \`t:texture volume\` |
| \`or\` | OR | \`player or monster\` |
| \`-\` | Exclude | \`-t:scene\` |
| \`()\` | Grouping | \`t:prefab (enemy or ally)\` |
| \`!\` | Exact name match | \`!stone\` |

## Indexed Property Queries

When the project search index is built, serialized properties can be queried directly:
- Numeric: \`health=2\`, \`bounciness>0.1\`
- Boolean: \`generatePath=true\`
- String: \`trait:indestru\` (partial), \`trait="tough but fair"\` (exact)
- Color (hex): \`color:ADA\`, \`color=ADADAD\`
- Vector component: \`bounds.x>1\`, \`acceleration.z=2\`
- Object ref: \`sprite:CharacterBody\`
- Null check: \`property=none\`

## Query Flags

| Flag | Effect |
|------|--------|
| \`+noResultsLimit\` | Return all results (default cap ~2999) |
| \`+fuzzy\` | Fuzzy/approximate matching |

## Examples

- All prefabs: \`t:prefab\`
- Prefabs with "enemy" in name: \`t:prefab enemy\`
- Large textures: \`t:texture size>1048576\`
- Recently modified scripts: \`ext:cs age<7\`
- Prefab variants: \`prefab:variant\`
- Materials in specific folder: \`t:material dir:Assets/Art/Materials\`
- Assets referencing a specific prefab: \`ref="Assets/Prefabs/Player.prefab"\``;

// Static resource: search syntax reference
server.registerResource(
  "unity_asset_search_syntax",
  "unity://assets/search-syntax",
  {
    description: "Full Unity asset search query syntax reference — filter tokens, operators, boolean logic, property queries, and examples.",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{
      uri: "unity://assets/search-syntax",
      mimeType: "text/markdown",
      text: SEARCH_SYNTAX_CONTENT,
    }],
  }),
);

// Dynamic resource template: asset search
const searchTemplate = new ResourceTemplate("unity://assets/search/{query}", { list: undefined });

server.registerResource(
  "unity_asset_search",
  searchTemplate,
  {
    description: `Search Unity project assets. Returns JSON array of {id, label, score}.
Common query syntax:
  - By name: "enemy", "player*"
  - By type: "t:prefab", "t:material", "t:texture", "t:scene"
  - By label: "l:mylabel"
  - By extension: "ext:png", "ext:cs"
  - By directory: "dir:Assets/Prefabs"
  - Combined: "t:prefab enemy" (AND), "player or monster" (OR)
  - Exclude: "-t:scene" (NOT)
  - Prefab variants: "prefab:variant", "prefab:model"
Read unity://assets/search-syntax for full syntax reference.`,
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const query = decodeURIComponent(String(variables.query ?? ""));
    if (!query) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: "[]",
        }],
      };
    }

    // Parse limit from query string
    const limitParam = uri.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    // Auto-detect project path (same logic as tools)
    const projectPath = process.cwd();

    const result = await searchAssets({
      projectPath,
      query,
      limit: Number.isFinite(limit) ? limit : undefined,
      logger: stderrLogger,
    });

    if (!result.ok) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: `Search failed: ${result.error}`,
        }],
      };
    }

    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(result.results),
      }],
    };
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --prefix plugins/unity-mcp vitest run __tests__/mcp/server.test.ts`
Expected: PASS (both existing and new test).

- [ ] **Step 5: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/unity-mcp/src/mcp/server.ts plugins/unity-mcp/__tests__/mcp/server.test.ts
git commit -m "feat: register asset search resource template and syntax resource"
```

---

### Task 5: Create C# search handler

**Files:**
- Create: `plugins/unity-mcp/templates/ClaudeSearchHandler.cs`
- Modify: `plugins/unity-mcp/templates/ClaudeBridgeBase.cs` (register action)
- Modify: `plugins/unity-mcp/src/lib/config.ts` (add to BRIDGE_CS_FILES)

- [ ] **Step 1: Create ClaudeSearchHandler.cs**

```csharp
// File: plugins/unity-mcp/templates/ClaudeSearchHandler.cs
// ClaudeSearchHandler Version: 1
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Search;
using UnityEngine;

internal static class ClaudeSearchHandler
{
    [Serializable]
    private class SearchRequestPayload
    {
        public string query;
        public int limit = 100;
    }

    [Serializable]
    private class SearchResultEntry
    {
        public string id;
        public string label;
        public int score;
    }

    [Serializable]
    private class SearchResultList
    {
        public List<SearchResultEntry> items;
    }

    internal static void Register()
    {
        ClaudeBridgeBase.RegisterAction("search_assets", HandleSearchAssets);
    }

    private static void HandleSearchAssets(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);

        SearchContext context = null;
        try
        {
            var payload = new SearchRequestPayload();
            if (!string.IsNullOrEmpty(request.payload))
                payload = JsonUtility.FromJson<SearchRequestPayload>(request.payload);

            if (string.IsNullOrEmpty(payload.query))
            {
                ClaudeBridgeBase.WriteSearchStatus(request, "completed", true, "Empty query", "[]");
                ClaudeBridgeBase.FinalizeRequest(request);
                return;
            }

            int limit = Mathf.Clamp(payload.limit, 1, 500);

            context = SearchService.CreateContext("asset", payload.query);

            SearchService.Request(context, (SearchContext ctx, IList<SearchItem> items) =>
            {
                try
                {
                    var results = new List<SearchResultEntry>();

                    // Items are already sorted by score from SearchService
                    int count = 0;
                    foreach (var item in items)
                    {
                        if (count >= limit) break;

                        string itemLabel = null;
                        try { itemLabel = item.GetLabel(ctx, true); } catch { }

                        results.Add(new SearchResultEntry
                        {
                            id = item.id ?? string.Empty,
                            label = itemLabel ?? item.id ?? string.Empty,
                            score = item.score,
                        });
                        count++;
                    }

                    // Serialize as JSON array string
                    // JsonUtility doesn't serialize List<T> directly at top level,
                    // so wrap in a helper and extract the array
                    var wrapper = new SearchResultList { items = results };
                    string json = JsonUtility.ToJson(wrapper, false);

                    // Extract just the array: {"items":[...]} -> [...]
                    string arrayJson = "[]";
                    int startIdx = json.IndexOf('[');
                    int endIdx = json.LastIndexOf(']');
                    if (startIdx >= 0 && endIdx > startIdx)
                        arrayJson = json.Substring(startIdx, endIdx - startIdx + 1);

                    ClaudeBridgeBase.WriteSearchStatus(
                        request, "completed", true,
                        results.Count + " asset(s) found",
                        arrayJson
                    );
                }
                catch (Exception ex)
                {
                    ClaudeBridgeBase.WriteStatus(request, "failed", false, false,
                        "Search failed: " + ex.Message);
                }
                finally
                {
                    if (context != null)
                    {
                        context.Dispose();
                        context = null;
                    }
                    ClaudeBridgeBase.FinalizeRequest(request);
                }
            });
        }
        catch (Exception ex)
        {
            if (context != null)
            {
                context.Dispose();
                context = null;
            }
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false,
                "Search failed: " + ex.Message);
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }
}
```

- [ ] **Step 2: Add searchResults field and WriteSearchStatus to ClaudeBridgeBase.cs**

In `plugins/unity-mcp/templates/ClaudeBridgeBase.cs`:

Add `searchResults` field to `StatusPayload` (after `testResults`):

```csharp
public string searchResults;
```

Add a new `WriteSearchStatus` method (after the existing `WriteStatus`):

```csharp
internal static void WriteSearchStatus(RequestPayload request, string state, bool isSuccess, string summary, string searchResultsJson)
{
    if (request == null || string.IsNullOrEmpty(request.requestId))
        return;

    var payload = new StatusPayload
    {
        protocolVersion = ProtocolVersion,
        requestId = request.requestId,
        bridgeVersion = BridgeVersion,
        projectPath = ProjectPath,
        state = state,
        createdAtUnixMs = NowUnixMs(),
        updatedAtUnixMs = NowUnixMs(),
        didCompile = false,
        isSuccess = isSuccess,
        errors = new List<ErrorPayload>(),
        summary = summary ?? string.Empty,
        searchResults = searchResultsJson,
    };

    string json = JsonUtility.ToJson(payload, true);
    string path = Path.Combine(IpcDir, "status-" + request.requestId + ".json");
    TryWriteJsonAtomic(path, json);
}
```

Register the handler in the static constructor. Add after `ClaudeTestHandler.Register();`:

```csharp
ClaudeSearchHandler.Register();
```

- [ ] **Step 3: Add ClaudeSearchHandler.cs to BRIDGE_CS_FILES in config.ts**

In `plugins/unity-mcp/src/lib/config.ts`, update:

```typescript
export const BRIDGE_CS_FILES = [
  "ClaudeBridgeBase.cs",
  "ClaudeRecompileHandler.cs",
  "ClaudeTestHandler.cs",
  "ClaudeSearchHandler.cs",
];
```

- [ ] **Step 4: Run all tests**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All pass. The install test may need updating if it checks the exact file list.

- [ ] **Step 5: Commit**

```bash
git add plugins/unity-mcp/templates/ClaudeSearchHandler.cs plugins/unity-mcp/templates/ClaudeBridgeBase.cs plugins/unity-mcp/src/lib/config.ts
git commit -m "feat: add C# search handler and register in bridge"
```

---

### Task 6: Build, version bump, and final verification

**Files:**
- Modify: `plugins/unity-mcp/package.json` (version bump)
- Rebuild: `plugins/unity-mcp/dist/server.mjs`

- [ ] **Step 1: Run full test suite**

Run: `npx --prefix plugins/unity-mcp vitest run`
Expected: All pass.

- [ ] **Step 2: Build the bundle**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Successful build producing updated `dist/server.mjs`.

- [ ] **Step 3: Bump version**

Increment the minor version:
- `plugins/unity-mcp/package.json`: `"1.2.0"` -> `"1.3.0"` (minor bump — new feature)

- [ ] **Step 4: Final commit**

```bash
git add plugins/unity-mcp/package.json plugins/unity-mcp/dist/server.mjs
git commit -m "chore: bump unity-mcp to 1.3.0 — asset search resource"
```
