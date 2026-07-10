/**
 * FindE AI background service worker.
 *
 * Receives live-capture batches from the content script and uploads them to
 * the backend with retries, so post collection keeps working while the user
 * scrolls — even with the popup closed. Progress is written to
 * chrome.storage.local ("liveStats") and mirrored on the action badge.
 */
const DEFAULT_API = "http://localhost:8080";

chrome.runtime.onInstalled.addListener(async () => {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  if (!apiBase) {
    await chrome.storage.local.set({ apiBase: DEFAULT_API });
  }
});

let queue = [];
let uploading = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FINDE_LIVE_BATCH") {
    queue.push(...(message.posts || []));
    drainQueue();
    sendResponse({ ok: true, queued: queue.length });
  }
  return true;
});

async function drainQueue() {
  if (uploading) return;
  uploading = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, 50);
      const result = await uploadBatch(batch);
      const { liveStats } = await chrome.storage.local.get("liveStats");
      const stats = liveStats || { captured: 0, indexed: 0, failed: 0 };
      stats.captured += batch.length;
      if (result) {
        stats.indexed += result.accepted ?? 0;
        stats.totalDocs = result.totalCommunityDocs ?? stats.totalDocs;
      } else {
        stats.failed += batch.length;
      }
      await chrome.storage.local.set({ liveStats: stats });
      updateBadge(stats.indexed);
    }
  } finally {
    uploading = false;
  }
}

async function uploadBatch(posts, attempt = 0) {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  try {
    const res = await fetch(`${apiBase || DEFAULT_API}/api/posts/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts, source: "live_capture" })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return uploadBatch(posts, attempt + 1);
    }
    console.warn("FindE live upload failed:", error.message);
    return null;
  }
}

function updateBadge(count) {
  const text = count > 999 ? "1k+" : count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#6C5CE7" });
}
