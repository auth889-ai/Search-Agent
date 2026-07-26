import { Router } from "express";
import { logFeedback, feedbackStats } from "../services/feedback.service.js";
import { upcomingDeadlines } from "../services/digest.service.js";

const router = Router();

// Log a click / save / dismiss on a result. Fire-and-forget from the UI.
router.post("/feedback", async (req, res) => {
  try {
    const out = await logFeedback(req.body || {});
    res.json(out);
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message });
  }
});

router.get("/feedback/stats", async (req, res) => {
  res.json({ ok: true, actions: await feedbackStats() });
});

// Opportunity radar: everything with a deadline in the next N days.
router.get("/digest", async (req, res) => {
  try {
    const out = await upcomingDeadlines({
      days: req.query.days,
      limit: req.query.limit
    });
    res.json(out);
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message });
  }
});

export default router;
