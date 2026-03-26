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
    const text = await mcp.callTool("unity_search_assets", {
      query: "t:MonoScript",
    });
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
    const text = await mcp.callTool("unity_search_assets", {
      query: "SearchTestPlayer",
    });
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    const match = results.find((r: { label: string }) =>
      r.label.includes("SearchTestPlayer"),
    );
    expect(match).toBeDefined();
  });

  it("test 24: limit parameter is respected", async () => {
    const text = await mcp.callTool("unity_search_assets", {
      query: "t:MonoScript",
      limit: 2,
    });
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("test 25: no-match query returns empty array", async () => {
    const text = await mcp.callTool("unity_search_assets", {
      query: "xyzzy_nonexistent_asset_12345",
    });
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it("test 26: negative limit is clamped to 1", async () => {
    const text = await mcp.callTool("unity_search_assets", {
      query: "t:MonoScript",
      limit: -1,
    });
    const results = JSON.parse(text);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});
