import express from "express";
import { matchCapturedPosts } from "../services/match.service.js";

const router = express.Router();

// Direct LLM match: extension sends captured visible posts + the user's query,
// the LLM ranks them by fit (any language) with a reason. No link required.
router.post("/match", async (req, res) => {
  try {
    const result = await matchCapturedPosts({
      query: req.body.query,
      posts: req.body.posts || [],
      limit: req.body.limit || 10
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Match failed"
    });
  }
});

export default router;
