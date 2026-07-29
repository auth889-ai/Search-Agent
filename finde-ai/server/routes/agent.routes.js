import express from "express";
import { runAgent } from "../services/agent.service.js";
import { mcpEnabled, mcpListTools } from "../services/elasticMcp.service.js";

const router = express.Router();

// Partner-integration proof: list the live tools of the official Elastic MCP
// server the agent talks to (list_indices, get_mappings, search, get_shards).
router.get("/mcp/tools", async (_req, res) => {
  if (!mcpEnabled()) {
    return res.json({ ok: false, enabled: false, message: "Set ELASTIC_MCP_ENABLED=true" });
  }
  const tools = await mcpListTools();
  res.json({ ok: Boolean(tools), enabled: true, server: "@elastic/mcp-server-elasticsearch", tools: tools || [] });
});

// Full agent pipeline: plan -> retrieve -> verify -> compose grounded answer.
router.post("/agent/ask", async (req, res) => {
  try {
    const result = await runAgent({
      query: req.body.query,
      sourceMode: req.body.sourceMode || "all",
      limit: req.body.limit || 8,
      useWeb: req.body.useWeb === true,
      minFit: req.body.minFit ?? 20
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Agent failed"
    });
  }
});

router.get("/agent/demo", async (_req, res) => {
  try {
    const result = await runAgent({
      query: "remote frontend internship for beginners",
      sourceMode: "all",
      limit: 5
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Agent demo failed"
    });
  }
});

export default router;
