import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";

describe("MCP server", () => {
  it("registers all 6 tools", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "unity_lint",
      "unity_list_tests",
      "unity_recompile",
      "unity_run_tests",
      "unity_status",
      "unity_test_results",
    ]);

    await client.close();
    await server.close();
  });

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
});
