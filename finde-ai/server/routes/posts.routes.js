import express from "express";
import {
  ingestCommunityPosts,
  ingestSingleCommunityPost,
  normalizeCommunityPost
} from "../services/ingestion.service.js";

const router = express.Router();

// Sample payload so the extension / client knows the expected shape.
const DEMO_PAYLOAD = {
  source: "demo",
  posts: [
    {
      groupName: "CSE Internship Bangladesh",
      text: "Remote frontend internship for CSE students. Skills: React, JavaScript, REST API. Paid. Deadline June 30.",
      comments: ["I applied last week, they asked React hooks."],
      url: "https://facebook.com/groups/demo/posts/sample-1",
      date: "2026-06-05",
      captureMode: "user_clicked_visible_posts"
    }
  ]
};

router.get("/posts/demo-payload", (_req, res) => {
  res.json({ ok: true, example: DEMO_PAYLOAD });
});

router.post("/posts/demo-ingest", async (_req, res) => {
  try {
    const result = await ingestCommunityPosts({
      posts: DEMO_PAYLOAD.posts,
      source: "demo"
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Demo ingest failed"
    });
  }
});

// Bulk index of visible posts captured by the Chrome extension.
router.post("/posts/index", async (req, res) => {
  try {
    const result = await ingestCommunityPosts({
      posts: req.body.posts || [],
      source: req.body.source || "chrome_extension"
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Post ingestion failed"
    });
  }
});

// Index a single post.
router.post("/posts/index-one", async (req, res) => {
  try {
    const result = await ingestSingleCommunityPost(
      req.body.post || req.body,
      req.body.source || "chrome_extension"
    );
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Post ingestion failed"
    });
  }
});

// Preview normalization without indexing (useful for debugging the extension).
router.post("/posts/preview", (req, res) => {
  try {
    const normalized = normalizeCommunityPost(req.body.post || req.body);
    res.json({ ok: true, normalized });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message || "Preview failed"
    });
  }
});

export default router;
