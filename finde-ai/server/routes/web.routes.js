import express from "express";
import { searchWebWithProvider } from "../services/webProviders.service.js";

const router = express.Router();

router.post("/web/search", async (req, res) => {
  try {
    const result = await searchWebWithProvider({
      query: req.body.query,
      provider: req.body.provider || "",
      limit: req.body.limit || 5,
      cache: req.body.cache !== false,
      urls: req.body.urls || []
    });

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Web search failed"
    });
  }
});

router.get("/web/search/demo", async (_req, res) => {
  try {
    const result = await searchWebWithProvider({
      query: "remote software engineering internship for CSE students",
      provider: process.env.WEB_SEARCH_PROVIDER || "tavily",
      limit: 5,
      cache: true
    });

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Web search demo failed"
    });
  }
});

router.post("/web/manual", async (req, res) => {
  try {
    const result = await searchWebWithProvider({
      query: req.body.query,
      provider: "manual",
      urls: req.body.urls || [],
      cache: req.body.cache !== false
    });

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Manual web ingestion failed"
    });
  }
});

export default router;
