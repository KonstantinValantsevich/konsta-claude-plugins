import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";

describe("MCP server", () => {
  it("registers all 4 tools", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "unity_detect_project",
      "unity_lint",
      "unity_recompile",
      "unity_status",
    ]);

    await client.close();
    await server.close();
  });
});
