import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const SERVER_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "dist",
  "server.mjs",
);

export interface McpTestClient {
  client: Client;
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Spawn MCP server, connect via StdioClientTransport.
 * `callTool` auto-injects `projectPath` from the provided default.
 */
export async function createMcpClient(
  defaultProjectPath: string,
): Promise<McpTestClient> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
  });

  const client = new Client(
    { name: "e2e-test-client", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  async function callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    const mergedArgs = { projectPath: defaultProjectPath, ...args };
    const result = await client.callTool({ name, arguments: mergedArgs });

    // Extract text from MCP content array
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return text;
  }

  async function close(): Promise<void> {
    await client.close();
  }

  return { client, callTool, close };
}
