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
 * auto-scroll, no expanding hidden content, no login bypass, no background
 * work without the user switching live capture on.
 *
 * Facebook's DOM is heavily obfuscated: raw innerText of a post pulls in image
 * alt text ("Facebook" repeated), reaction blobs, and random class-like tokens.
 * So we target the real message containers (div[dir=auto]) and filter noise via
 * the pure helpers in extract-core.js (loaded first).
 */

(() => {
  // Guard against double-injection (popup injects on demand if the tab was
  // opened before the extension loaded).
  if (globalThis.__FINDE_CONTENT_ACTIVE__) return;
  globalThis.__FINDE_CONTENT_ACTIVE__ = true;

  const MAX_POSTS = 40;
  const { cleanText, looksLikeRealText, stripTrailingUi, UI_NOISE } = globalThis.FindEExtract;

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return rect.bottom > 0 && rect.top < window.innerHeight + rect.height;
  }

  // Extract the post message from a Facebook article by reading dir="auto" blocks.
  function extractMessage(article) {
    const blocks = Array.from(article.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
    const seen = new Set();
    const candidates = [];

    for (const b of blocks) {
      // Skip container blocks that wrap other dir=auto blocks (avoids duplicates).
      if (b.querySelector('div[dir="auto"], span[dir="auto"]')) continue;

      const t = stripTrailingUi(b.innerText || b.textContent);
      if (!looksLikeRealText(t)) continue;

      const key = t.slice(0, 80).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(t);
    }

    if (!candidates.length) return "";
    // The post body is almost always the longest genuine block.
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }

  function extractAuthor(article) {
    const el = article.querySelector('h2 a, h3 a, h4 a, strong a, a[role="link"] strong');
    const name = cleanText(el?.textContent || "");
    return name && name.length <= 60 && !UI_NOISE.test(name) ? name : "";
  }

  function findPermalink(article) {
    const links = article.querySelectorAll(
      'a[href*="/posts/"], a[href*="/permalink/"], a[href*="/groups/"], a[href*="story_fbid"], a[href*="/feed/update/"]'
    );
    for (const link of links) {
      const href = link.href || "";
      if (href && !href.includes("#")) return href.split("?")[0];
    }
    return "";
  }

  function extractVisiblePosts() {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    const seen = new Set();
    const posts = [];
    const pageUrl = location.href;
    const platform = location.hostname.includes("linkedin") ? "linkedin" : "facebook";
    const groupName = cleanText(document.title).replace(/\s*[|·].*$/i, "") || "Community";

    for (const article of articles) {
      if (posts.length >= MAX_POSTS) break;
      // Comments render as articles nested inside the post article — skip them.
      if (article.parentElement?.closest('[role="article"]')) continue;
      if (!isVisible(article)) continue;

      const text = extractMessage(article);
      if (!text) continue;

      const key = text.slice(0, 120).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      posts.push({
        text,
        authorDisplay: extractAuthor(article),
        url: findPermalink(article),
        pageUrl,
        groupName,
        platform,
        captureMode: "user_clicked_visible_posts",
        capturedBy: "finde_chrome_extension"
      });
    }

    return posts;
  }

  /* ---------------- live capture (user-initiated, user-scrolled) ---------------- */

  const live = {
    on: false,
    seen: new Set(), // content keys already sent this session
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
      const key = post.text.slice(0, 120).toLowerCase();
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

  // Throttle: Facebook mutates the DOM constantly; scan at most ~once/second.
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
          sendResponse({ ok: true });
          break;
        case "FINDE_EXTRACT_POSTS": {
          const posts = extractVisiblePosts();
          sendResponse({ ok: true, posts, count: posts.length });
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
