/**
 * FindE AI content script.
 *
 * SAFETY: only reads posts already rendered and visible when the user clicks.
 * No auto-scroll, no expanding hidden content, no login bypass, no background
 * work. Responds only to an explicit request from the popup.
 *
 * Facebook's DOM is heavily obfuscated: raw innerText of a post pulls in image
 * alt text ("Facebook" repeated), reaction blobs, and random class-like tokens.
 * So we target the real message containers (div[dir=auto]) and filter noise via
 * the pure helpers in extract-core.js (loaded first).
 */

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FINDE_EXTRACT_POSTS") {
    try {
      const posts = extractVisiblePosts();
      sendResponse({ ok: true, posts, count: posts.length });
    } catch (error) {
      sendResponse({ ok: false, error: error.message, posts: [] });
    }
  }
  return true;
});
