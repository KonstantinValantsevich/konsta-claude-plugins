# E2E Tests for Search Tool

**Date:** 2026-03-26
**Status:** Draft

## Overview

Add e2e test phase `06-search.test.ts` covering the MCP resource API surface for Unity asset search. Tests exercise both the static search-syntax reference resource and the dynamic search template resource against a real Unity editor instance.

## Scope

**In scope:** MCP resources only — `unity://assets/search-syntax` and `unity://assets/search/{query}`.

**Out of scope:** Direct `searchAssets()` calls (covered by unit tests), C# handler internals, error scenarios already covered by unit tests.

## Prerequisites

1. The MCP test client (`mcp-client.ts`) currently only supports `callTool`. A `readResource` helper must be added to support reading MCP resources in e2e tests.
2. The MCP server resolves `projectPath` via `process.cwd()` for resource reads. The `StdioClientTransport` in `createMcpClient` must pass `cwd: defaultProjectPath` so the spawned server process runs in the Unity project directory.

## Changes

### 1. Add `readResource` to MCP test client

**File:** `__tests__/e2e/helpers/mcp-client.ts`

Two changes:

**a) Pass `cwd` to `StdioClientTransport`:**
Add `cwd: defaultProjectPath` to the transport options so the MCP server's `process.cwd()` resolves to the Unity project directory. This is required for resource handlers that use `process.cwd()` to find the project.

**b) Add `readResource` method:**
Add a `readResource` method to `McpTestClient` that wraps `client.readResource({ uri })` and extracts text content, mirroring the existing `callTool` pattern.

```typescript
interface McpTestClient {
  client: Client;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<string>;
  readResource: (uri: string) => Promise<string>;
  close: () => Promise<void>;
}
```

The `readResource` implementation calls `client.readResource({ uri })`, extracts text from the content array, and returns it as a string. Timeout: 300s (same as `callTool`).

### 2. Test phase file

**File:** `__tests__/e2e/06-search.test.ts`

#### Setup (`beforeAll`, 600s timeout)

1. Read shared state (`readState()`) to get `projectPath`
2. Reset to baseline: `git reset --hard e2e-baseline && git clean -fd`
3. Create MCP client via `createMcpClient(projectPath)`
4. Bootstrap bridge: `mcp.callTool("unity_recompile")`
5. Create fixture MonoBehaviour: write `Assets/SearchFixture/SearchTestPlayer.cs` using `simpleMonoBehaviour("SearchTestPlayer")` from existing `fixtures.ts`
6. Recompile again so Unity indexes the new asset

#### Teardown (`afterAll`)

Close MCP client.

#### Test cases

**Test 1: search-syntax resource returns documentation**
- Read `unity://assets/search-syntax`
- Assert response contains key syntax tokens: `t:`, `ref:`, `ext:`

**Test 2: basic type query returns results**
- Read `unity://assets/search/t:MonoScript`
- Parse JSON array from response
- Assert array is non-empty
- Assert each entry has `id`, `label`, `score` properties

**Test 3: query for fixture asset finds it**
- Read `unity://assets/search/SearchTestPlayer`
- Parse JSON array
- Assert at least one result where `label` contains `SearchTestPlayer`

**Test 4: limit parameter is respected**
- Read `unity://assets/search/t:MonoScript?limit=2`
- Parse JSON array
- Assert array length is at most 2

**Test 5: no-match query returns empty array**
- Read `unity://assets/search/xyzzy_nonexistent_asset_12345`
- Parse JSON array
- Assert array is empty

**Test 6: negative limit is clamped to 1**
- Read `unity://assets/search/t:MonoScript?limit=-1`
- Parse JSON array
- Assert array length is at most 1 (limit is clamped via `Math.max(1, ...)` in `searchAssets`)

## File inventory

| File | Action |
|------|--------|
| `__tests__/e2e/helpers/mcp-client.ts` | Edit — add `cwd` to transport, add `readResource` method |
| `__tests__/e2e/06-search.test.ts` | Create — new test phase |

## No other changes

- No new fixtures needed (`simpleMonoBehaviour` already exists)
- No config changes (vitest.e2e.config.ts already picks up `__tests__/e2e/*.test.ts`)
- No version bump (tests only, not a feature)
