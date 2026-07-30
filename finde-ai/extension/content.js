/**
 * FindE AI content script.
 *
 * Two modes, both user-controlled:
 *  1. One-shot — the popup asks for the posts visible right now.
 *  2. Live capture — the user turns it ON, then scrolls normally; every post
 *     that appears on screen is extracted, deduplicated, and streamed to the
 *     backend in small batches. This is how the index grows to thousands of
 *     posts instead of one screenful.
 *
 * SAFETY: only reads posts already rendered and visible to the user. No
 * auto-scroll, no expanding hidden content, no clicking "see more", no login
 * bypass, no background work without the user switching live capture on.
 *
 * All DOM knowledge lives in platforms.js (Facebook + LinkedIn adapters) and
 * all text filtering in extract-core.js; this file only orchestrates.
 */

(() => {
  // Guard against double-injection (popup injects on demand if the tab was
  // opened before the extension loaded).
  if (globalThis.__FINDE_CONTENT_ACTIVE__) return;
  globalThis.__FINDE_CONTENT_ACTIVE__ = true;

  const MAX_POSTS = 60;
  const { cleanText, dedupeKey, deriveGroupName } = globalThis.FindEExtract;
  const { detect } = globalThis.FindEPlatforms;

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // Intersects the viewport at all — the user has this post on screen.
    return rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function extractVisiblePosts() {
    const adapter = detect(location.hostname);
    if (!adapter) return [];

    const seen = new Set();
    const posts = [];
    const pageUrl = location.href;
    const groupName = deriveGroupName(document.title);

    for (const container of adapter.postContainers()) {
      if (posts.length >= MAX_POSTS) break;
      if (adapter.isNested(container)) continue;
      if (!isVisible(container)) continue;

      const text = adapter.message(container);
      if (!text) continue;

      const url = adapter.permalink(container);
      const date = adapter.date(container);

      // Identity is the permalink when the platform gives one, text otherwise.
      const key = dedupeKey({ url, text });
      if (seen.has(key)) continue;
      seen.add(key);

      posts.push({
        text,
        authorDisplay: adapter.author(container),
        url,
        ...(date ? { date, dateSource: "post_timestamp" } : {}),
        pageUrl,
        groupName,
        platform: adapter.name,
        captureMode: "user_clicked_visible_posts",
        capturedBy: "finde_chrome_extension"
      });
    }

    return posts;
  }

  // Diagnostics for the popup's empty state: distinguishes "no post containers
  // on this page" (wrong page / selectors stale) from "containers but no text".
  function extractionStats() {
    const adapter = detect(location.hostname);
    if (!adapter) return { platform: "unsupported", containers: 0, visible: 0 };
    const containers = adapter.postContainers().filter((el) => !adapter.isNested(el));
    return {
      platform: adapter.name,
      containers: containers.length,
      visible: containers.filter(isVisible).length
    };
  }

  /* ---------------- live capture (user-initiated, user-scrolled) ---------------- */

  const live = {
    on: false,
    seen: new Set(), // post identities already sent this session
    buffer: [],
    captured: 0,
    scanTimer: null,
    flushTimer: null,
    observer: null
  };

  function liveFlush() {
    clearTimeout(live.flushTimer);
    live.flushTimer = null;
    if (!live.buffer.length) return;
    const batch = live.buffer.splice(0);
    // Background service worker uploads + retries; content script stays light.
    chrome.runtime.sendMessage({
      type: "FINDE_LIVE_BATCH",
      posts: batch.map((p) => ({ ...p, captureMode: "user_scrolled_visible_posts" }))
    });
  }

  function liveScan() {
    if (!live.on) return;
    for (const post of extractVisiblePosts()) {
      const key = dedupeKey(post);
      if (live.seen.has(key)) continue;
      live.seen.add(key);
      live.buffer.push(post);
      live.captured += 1;
    }
    if (live.buffer.length >= 6) liveFlush();
    else if (live.buffer.length && !live.flushTimer) {
      live.flushTimer = setTimeout(liveFlush, 4000);
    }
  }

  // Throttle: both feeds mutate the DOM constantly; scan at most ~once/second.
  function scheduleLiveScan() {
    if (!live.on || live.scanTimer) return;
    live.scanTimer = setTimeout(() => {
      live.scanTimer = null;
      liveScan();
    }, 1000);
  }

  function liveStart() {
    if (live.on) return;
    live.on = true;
    live.observer = new MutationObserver(scheduleLiveScan);
    live.observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", scheduleLiveScan, { passive: true });
    liveScan(); // capture what is on screen right now
  }

  function liveStop() {
    live.on = false;
    live.observer?.disconnect();
    live.observer = null;
    window.removeEventListener("scroll", scheduleLiveScan);
    clearTimeout(live.scanTimer);
    live.scanTimer = null;
    liveFlush();
  }

  function liveStatus() {
    return { active: live.on, captured: live.captured };
  }

  /* ---------------- message bridge ---------------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case "FINDE_PING":
          sendResponse({ ok: true, platform: detect(location.hostname)?.name || null });
          break;
        case "FINDE_EXTRACT_POSTS": {
          const posts = extractVisiblePosts();
          sendResponse({ ok: true, posts, count: posts.length, stats: extractionStats() });
          break;
        }
        case "FINDE_LIVE_START":
          liveStart();
          sendResponse({ ok: true, ...liveStatus() });
          break;
        case "FINDE_LIVE_STOP":
          liveStop();
          sendResponse({ ok: true, ...liveStatus() });
          break;
        case "FINDE_LIVE_STATUS":
          sendResponse({ ok: true, ...liveStatus() });
          break;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message, posts: [] });
    }
    return true;
  });
})();
