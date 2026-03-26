# E2E Search Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add e2e tests covering the MCP resource API surface for Unity asset search (`unity://assets/search-syntax` and `unity://assets/search/{query}`).

**Architecture:** Extend the existing MCP test client with a `readResource` helper, then create a new test phase `06-search.test.ts` that follows the same structure as existing e2e phases (shared state, baseline reset, bootstrap).

**Tech Stack:** Vitest, MCP SDK (`@modelcontextprotocol/sdk`), existing e2e helpers (`mcp-client.ts`, `state.ts`, `fixtures.ts`)

---

## File Structure

| File | Action |
|------|--------|
| `plugins/unity-mcp/__tests__/e2e/helpers/mcp-client.ts` | Modify — add `cwd` to transport, add `readResource` method + update interface |
| `plugins/unity-mcp/__tests__/e2e/06-search.test.ts` | Create — new test phase |

---

### Task 1: Add `readResource` to MCP test client

**Files:**
- Modify: `plugins/unity-mcp/__tests__/e2e/helpers/mcp-client.ts`

- [ ] **Step 1: Add `readResource` to the `McpTestClient` interface**

In `plugins/unity-mcp/__tests__/e2e/helpers/mcp-client.ts`, add to the interface:

```typescript
export interface McpTestClient {
  client: Client;
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<string>;
  readResource: (uri: string) => Promise<string>;
  close: () => Promise<void>;
}
```

- [ ] **Step 2: Pass `cwd` to `StdioClientTransport`**

In the `createMcpClient` function, add `cwd: defaultProjectPath` to the transport options:

```typescript
const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER_PATH],
  stderr: "pipe",
  cwd: defaultProjectPath,
});
```

This ensures `process.cwd()` in the MCP server resolves to the Unity project directory, which resource handlers depend on.

- [ ] **Step 3: Add `readResource` function**

Add this function inside `createMcpClient`, after the `callTool` function (before `close`):

```typescript
async function readResource(uri: string): Promise<string> {
  console.log(`[E2E] readResource: ${uri}`);
  const result = await client.readResource(
    { uri },
    undefined,
    { timeout: 300_000 },
  );

  const content = result.contents as Array<{ uri: string; text?: string }>;
  const text = content
    .filter((c) => typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  console.log(`[E2E] resource ${uri} → ${text.slice(0, 200)}`);
  return text;
}
```

- [ ] **Step 4: Add `readResource` to the return object**

Update the return statement:

```typescript
return { client, callTool, readResource, close };
```

- [ ] **Step 5: Verify the project builds**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Clean build with no type errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/helpers/mcp-client.ts
git commit -m "feat(e2e): add readResource helper and cwd to MCP test client" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Create e2e test phase 06-search

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/06-search.test.ts`

- [ ] **Step 1: Write the test file**

Create `plugins/unity-mcp/__tests__/e2e/06-search.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import { simpleMonoBehaviour } from "./helpers/fixtures.js";

let mcp: McpTestClient;
let projectPath: string;

describe("Phase 06 — Search", () => {
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;

    // Cross-phase isolation
    execSync("git reset --hard e2e-baseline && git clean -fd", {
      cwd: projectPath,
      stdio: "ignore",
    });

    mcp = await createMcpClient(projectPath);

    // Bootstrap bridge
    await mcp.callTool("unity_recompile");

    // Create fixture MonoBehaviour for search tests
    const fixtureDir = path.join(projectPath, "Assets", "SearchFixture");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "SearchTestPlayer.cs"),
      simpleMonoBehaviour("SearchTestPlayer"),
    );

    // Recompile so Unity indexes the new asset
    await mcp.callTool("unity_recompile");
  }, 600_000);

  afterAll(async () => {
    if (mcp) await mcp.close();
  });

  it("test 21: search-syntax resource returns documentation", async () => {
    const text = await mcp.readResource("unity://assets/search-syntax");

    expect(text).toContain("t:");
    expect(text).toContain("ref:");
    expect(text).toContain("ext:");
  });

  it("test 22: basic type query returns results", async () => {
    const text = await mcp.readResource("unity://assets/search/t:MonoScript");
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("label");
      expect(entry).toHaveProperty("score");
    }
  });

  it("test 23: query for fixture asset finds it", async () => {
    const text = await mcp.readResource("unity://assets/search/SearchTestPlayer");
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    const match = results.find((r: { label: string }) =>
      r.label.includes("SearchTestPlayer"),
    );
    expect(match).toBeDefined();
  });

  it("test 24: limit parameter is respected", async () => {
    const text = await mcp.readResource(
      "unity://assets/search/t:MonoScript?limit=2",
    );
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("test 25: no-match query returns empty array", async () => {
    const text = await mcp.readResource(
      "unity://assets/search/xyzzy_nonexistent_asset_12345",
    );
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it("test 26: negative limit is clamped to 1", async () => {
    const text = await mcp.readResource(
      "unity://assets/search/t:MonoScript?limit=-1",
    );
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Verify the project builds**

Run: `npm --prefix plugins/unity-mcp run build`
Expected: Clean build (test file is not part of build, but ensures no import issues in the helper).

- [ ] **Step 3: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/06-search.test.ts
git commit -m "feat(e2e): add phase 06 search resource tests" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
