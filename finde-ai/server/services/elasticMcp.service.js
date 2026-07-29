/**
 * Elastic MCP integration (hackathon partner requirement).
 *
 * The agent reaches Elasticsearch through Elastic's OFFICIAL MCP server
 * (@elastic/mcp-server-elasticsearch) instead of only the direct client:
 *
 *   FindE agent ──MCP (stdio, JSON-RPC)──> Elastic MCP server ──> Elasticsearch
 *
 * The server exposes real tools (list_indices, get_mappings, search, esql);
 * we connect as an MCP client via @modelcontextprotocol/sdk. Enabled with
 * ELASTIC_MCP_ENABLED=true. Fully optional and graceful: any failure returns
 * null and the pipeline keeps using the direct Elasticsearch client.
 */
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";

export function mcpEnabled() {
  return process.env.ELASTIC_MCP_ENABLED === "true";
}

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

      // Resolve the official Elastic MCP server entrypoint from node_modules.
      const serverEntry = require.resolve("@elastic/mcp-server-elasticsearch/dist/index.js");

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        env: {
          ...process.env,
          ES_URL: ELASTICSEARCH_NODE,
          // Local dev ES runs with security disabled; the server still wants
          // the var present in some versions.
          ES_USERNAME: process.env.ELASTICSEARCH_USERNAME || "",
          ES_PASSWORD: process.env.ELASTICSEARCH_PASSWORD || ""
        },
        stderr: "ignore"
      });

      const client = new Client({ name: "finde-ai-agent", version: "1.0.0" });
      await client.connect(transport);
      return client;
    })().catch((error) => {
      clientPromise = null; // allow retry later
      throw error;
    });
  }
  return clientPromise;
}

/** List the tools the Elastic MCP server exposes. Null on any failure. */
export async function mcpListTools() {
  if (!mcpEnabled()) return null;
  try {
    const client = await getClient();
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description }));
  } catch (error) {
    console.error(`[elastic-mcp] listTools failed: ${error.message}`);
    return null;
  }
}

/**
 * Run a query-DSL search THROUGH the Elastic MCP server's `search` tool.
 * Returns { hits, toolName } or null.
 */
export async function mcpSearch(index, queryBody, { size = 5 } = {}) {
  if (!mcpEnabled()) return null;
  try {
    const client = await getClient();
    const result = await client.callTool({
      name: "search",
      arguments: { index, queryBody: { ...queryBody, size } }
    });
    // Tool result content is text blocks; the first block(s) carry JSON/text
    // describing hits. Parse defensively — schema differs across versions.
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks.map((b) => b.text || "").join("\n");
    let hits = [];
    try {
      const parsed = JSON.parse(text);
      hits = parsed?.hits?.hits || parsed?.hits || parsed || [];
    } catch {
      hits = text ? [{ raw: text.slice(0, 2000) }] : [];
    }
    return { hits, toolName: "search", raw: text.slice(0, 4000) };
  } catch (error) {
    console.error(`[elastic-mcp] search failed: ${error.message}`);
    return null;
  }
}
