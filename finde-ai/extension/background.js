/**
 * FindE AI background service worker.
 * Minimal for now — sets sensible defaults on install. All search/index work
 * happens from the popup so nothing runs without an explicit user action.
 */
chrome.runtime.onInstalled.addListener(async () => {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  if (!apiBase) {
    await chrome.storage.local.set({ apiBase: "http://localhost:8080" });
  }
});
