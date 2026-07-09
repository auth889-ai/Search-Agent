/**
 * FindE AI content script.
 *
 * SAFETY: this only reads posts that are ALREADY rendered and visible on the
 * page at the moment the user clicks. It does NOT auto-scroll, does NOT open
 * hidden content, does NOT bypass login or privacy controls, and does NOT run
 * in the background. It responds only to an explicit request from the popup.
 */

const MIN_POST_CHARS = 20;
const MAX_POSTS = 40;

function cleanText(value) {
  return String(value || "")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  // Must intersect the viewport (i.e. actually on screen / near it).
  return rect.bottom > 0 && rect.top < window.innerHeight + rect.height;
}

function findPermalink(article) {
  const links = article.querySelectorAll('a[href*="/posts/"], a[href*="/groups/"], a[href*="/permalink/"], a[href*="/feed/update/"]');
  for (const link of links) {
    const href = link.href || "";
    if (href && !href.includes("#")) return href;
  }
  return "";
}

function extractVisiblePosts() {
  const articles = Array.from(document.querySelectorAll('[role="article"]'));
  const seen = new Set();
  const posts = [];
  const pageUrl = location.href;
  const groupName = cleanText(document.title).replace(/\s*\|\s*Facebook.*/i, "");

  for (const article of articles) {
    if (posts.length >= MAX_POSTS) break;
    if (!isVisible(article)) continue;

    const text = cleanText(article.innerText);
    if (text.length < MIN_POST_CHARS) continue;

    // Dedupe on a text fingerprint.
    const key = text.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);

    posts.push({
      text,
      url: findPermalink(article),
      pageUrl,
      groupName: groupName || "Community",
      platform: location.hostname.includes("linkedin") ? "linkedin" : "facebook",
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
  // Keep the message channel open for the synchronous response above.
  return true;
});
