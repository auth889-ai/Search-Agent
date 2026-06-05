import express from "express";
import { searchFindE } from "../services/search.service.js";

const router = express.Router();

router.post("/search", async (req, res) => {
  try {
    const result = await searchFindE({
      query: req.body.query,
      sourceMode: req.body.sourceMode || "all",
      topics: req.body.topics || [],
      location: req.body.location || "",
      sourceType: req.body.sourceType || "",
      dateFrom: req.body.dateFrom || "",
      dateTo: req.body.dateTo || "",
      includeExpired: req.body.includeExpired !== false,
      limit: req.body.limit || 10
    });

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Search failed"
    });
  }
});

router.get("/search/demo", async (_req, res) => {
  try {
    const result = await searchFindE({
      query: "AI cybersecurity research idea for beginner",
      sourceMode: "all",
      limit: 5
    });

    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Demo search failed"
    });
  }
});

export default router;
