/**
 * Make the official Elastic MCP server talk to Elasticsearch 8.x.
 *
 * @elastic/mcp-server-elasticsearch ships with the v9 JS client, which sends
 * "compatible-with=9" headers that ES 8.15 rejects (media_type_header_exception).
 * The root package.json declares an npm `overrides` pin to the v8 client, but
 * npm (11.x) skips overrides when the same package is also a direct workspace
 * dependency — a known limitation. This postinstall removes the nested v9
 * client + transport so Node resolution falls back to the hoisted v8 client
 * that the rest of the project already uses.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nested = path.join(
  root,
  "node_modules/@elastic/mcp-server-elasticsearch/node_modules/@elastic"
);

let removed = [];
for (const pkg of ["elasticsearch", "transport"]) {
  const dir = path.join(nested, pkg);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(pkg);
  }
}

console.log(
  removed.length
    ? `[fix-mcp-es-client] removed nested v9 ${removed.join(", ")} — MCP server now uses the hoisted v8 client`
    : "[fix-mcp-es-client] nothing to fix (already clean)"
);
