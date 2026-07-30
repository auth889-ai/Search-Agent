/**
 * FindE AI platform adapters — the DOM-shaped half of extraction.
 *
 * Facebook and LinkedIn structure their feeds completely differently, so a
 * single selector set cannot serve both:
 *
 *   Facebook  posts are [role="article"] with the message split across many
 *             div[dir="auto"] leaf blocks; comments are NESTED articles.
 *   LinkedIn  posts are div.feed-shared-update-v2 / [data-urn*="activity"];
 *             the message lives in .update-components-text; comments are
 *             separate .comments-comment-* entities; and every accessible
 *             label is rendered TWICE (visually-hidden + aria-hidden).
 *
 * Each adapter exposes the same interface so content.js stays platform-blind:
 *   postContainers() -> Element[]      outermost post nodes on screen
 *   isNested(el)     -> boolean        true if el is a comment / inner post
 *   message(el)      -> string         the human-written body
 *   author(el)       -> string
 *   date(el)         -> ISO string | ""
 *   permalink(el)    -> string
 *
 * SELECTOR STRATEGY: both sites ship obfuscated, frequently-changing markup.
 * Every lookup is a layered fallback — exact class, then class-substring, then
 * a structural guess — so a rename degrades one field instead of returning
 * zero posts.
 */
(function (root) {
  const {
    cleanText,
    stripDuplicatedHalf,
    looksLikeRealText,
    stripTrailingUi,
    linkedInPermalinkFromUrn,
    parsePostTimestamp,
    UI_NOISE
  } = root.FindEExtract;

  const MAX_POST_CHARS = 6000;

  /* ---------------- shared helpers ---------------- */

  // First element matching any selector in the layered list.
  function pick(el, selectors) {
    for (const sel of selectors) {
      try {
        const found = el.querySelector(sel);
        if (found) return found;
      } catch {
        /* invalid selector on an old Chrome — skip this layer */
      }
    }
    return null;
  }

  function collect(selectors) {
    const out = [];
    for (const sel of selectors) {
      try {
        out.push(...document.querySelectorAll(sel));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  // Keep only the outermost elements — drop any candidate contained by another.
  function outermost(elements) {
    const unique = Array.from(new Set(elements));
    return unique.filter(
      (el) => !unique.some((other) => other !== el && other.contains(el))
    );
  }

  // Read innerText but collapse LinkedIn's screen-reader duplication.
  function readText(el) {
    return stripDuplicatedHalf(el?.innerText || el?.textContent || "");
  }

  function firstTimestamp(el, labels) {
    for (const label of labels) {
      const parsed = parsePostTimestamp(label, Date.now());
      if (parsed) return parsed;
    }
    return "";
  }

  // <time datetime> / <abbr data-utime> are exact when present — always try first.
  function machineDate(el) {
    const timeEl = el.querySelector("time[datetime]");
    if (timeEl) {
      const parsed = new Date(timeEl.getAttribute("datetime"));
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    const abbr = el.querySelector("abbr[data-utime]");
    if (abbr) {
      const epoch = Number(abbr.getAttribute("data-utime"));
      if (epoch > 0) return new Date(epoch * 1000).toISOString();
    }
    return "";
  }

  /* ================= Facebook ================= */

  const facebook = {
    name: "facebook",

    postContainers() {
      // Comments render as articles nested inside the post article, so taking
      // the outermost articles both finds posts and excludes comments.
      return outermost(collect(['[role="article"]']));
    },

    isNested(el) {
      return Boolean(el.parentElement?.closest('[role="article"]'));
    },

    message(el) {
      const blocks = Array.from(el.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
      const seen = new Set();
      const candidates = [];

      for (const b of blocks) {
        // Skip container blocks that wrap other dir=auto blocks (avoids duplicates).
        if (b.querySelector('div[dir="auto"], span[dir="auto"]')) continue;
        // Skip text living inside a NESTED article (comments render as articles
        // inside the post article) — otherwise comment text pollutes the post.
        if (b.closest('[role="article"]') !== el) continue;

        const t = stripTrailingUi(readText(b));
        if (!looksLikeRealText(t)) continue;

        const key = t.slice(0, 80).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(t);
      }

      if (!candidates.length) return "";
      // Keep ALL genuine paragraphs in reading order — multi-paragraph posts
      // (requirements, deadlines, contact info) used to lose everything except
      // their single longest block, which crippled search quality.
      return candidates.join("\n").slice(0, MAX_POST_CHARS);
    },

    author(el) {
      const node = pick(el, ['h2 a', 'h3 a', 'h4 a', 'strong a', 'a[role="link"] strong']);
      const name = cleanText(readText(node));
      return name && name.length <= 60 && !UI_NOISE.test(name) ? name : "";
    },

    date(el) {
      const exact = machineDate(el);
      if (exact) return exact;

      // Short timestamp labels ("2d", "5 hrs", "Yesterday", "June 5", "২ দিন")
      // live on links in the post header.
      const links = Array.from(el.querySelectorAll('a[role="link"], a[href]')).slice(0, 30);
      const labels = [];
      for (const link of links) {
        const label = cleanText(link.getAttribute("aria-label") || readText(link));
        if (label && label.length <= 40) labels.push(label);
      }
      return firstTimestamp(el, labels);
    },

    permalink(el) {
      const links = el.querySelectorAll(
        'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="/groups/"]'
      );
      for (const link of links) {
        const href = link.href || "";
        if (href && !href.includes("#")) return href.split("?")[0];
      }
      return "";
    }
  };

  /* ================= LinkedIn ================= */

  // Anything that is a comment, reply, or nested reshare preview — never a post.
  const LI_NESTED = [
    ".comments-comment-item",
    ".comments-comment-entity",
    '[class*="comments-comment"]',
    '[class*="comments-reply"]'
  ].join(",");

  const linkedin = {
    name: "linkedin",

    postContainers() {
      // data-urn / data-id survive class renames, so they lead the fallback list.
      return outermost(
        collect([
          '[data-urn*="urn:li:activity"]',
          '[data-id*="urn:li:activity"]',
          '[data-urn*="urn:li:ugcPost"]',
          '[data-id*="urn:li:ugcPost"]',
          ".feed-shared-update-v2",
          '[class*="feed-shared-update-v2"]',
          ".fie-impression-container",
          '[class*="occludable-update"]'
        ])
        // A container that only wraps comments is not a post.
      ).filter((el) => !el.matches(LI_NESTED));
    },

    isNested(el) {
      return Boolean(el.closest(LI_NESTED));
    },

    message(el) {
      // The body is one dedicated block; "…see more" is CSS truncation, the
      // full text is already in the DOM, so we never need to click anything.
      // Comments reuse the SAME class names, so walk every match and take the
      // first that is not inside a comment entity.
      const selectors = [
        ".update-components-text",
        '[class*="update-components-text"]',
        ".feed-shared-inline-show-more-text",
        '[class*="inline-show-more-text"]',
        ".update-components-update-v2__commentary",
        '[class*="__commentary"]'
      ];
      for (const sel of selectors) {
        let nodes;
        try {
          nodes = el.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const node of nodes) {
          if (node.closest(LI_NESTED)) continue;
          const t = stripTrailingUi(readText(node));
          if (looksLikeRealText(t)) return t.slice(0, MAX_POST_CHARS);
        }
      }

      // Structural fallback: longest dir=ltr/auto block that is not a comment,
      // an actor header, or the social-action bar.
      const blocks = Array.from(
        el.querySelectorAll('div[dir="ltr"], span[dir="ltr"], div[dir="auto"], p')
      );
      let best = "";
      for (const b of blocks) {
        if (b.closest(LI_NESTED)) continue;
        if (b.closest('[class*="actor"], [class*="social-action"], [class*="social-details"]')) continue;
        if (b.querySelector('div[dir="ltr"], span[dir="ltr"], div[dir="auto"]')) continue;
        const t = stripTrailingUi(readText(b));
        if (looksLikeRealText(t) && t.length > best.length) best = t;
      }
      return best.slice(0, MAX_POST_CHARS);
    },

    author(el) {
      const node = pick(el, [
        ".update-components-actor__title",
        '[class*="actor__title"]',
        ".update-components-actor__name",
        '[class*="actor__name"]',
        ".feed-shared-actor__title"
      ]);
      // Actor titles are the worst offender for screen-reader duplication.
      const name = stripDuplicatedHalf(readText(node)).split("\n")[0].trim();
      return name && name.length <= 60 && !UI_NOISE.test(name) ? name : "";
    },

    date(el) {
      const exact = machineDate(el);
      if (exact) return exact;

      // "2d • Edited • Visible to anyone" — parsePostTimestamp keeps the age token.
      const node = pick(el, [
        ".update-components-actor__sub-description",
        '[class*="actor__sub-description"]',
        '[class*="sub-description"]'
      ]);

      const labels = [];
      if (node) labels.push(stripDuplicatedHalf(readText(node)));
      // Some layouts put the age in the post's permalink aria-label instead.
      for (const link of Array.from(el.querySelectorAll("a[aria-label]")).slice(0, 10)) {
        const label = cleanText(link.getAttribute("aria-label"));
        if (label && label.length <= 40) labels.push(label);
      }
      return firstTimestamp(el, labels.filter(Boolean));
    },

    permalink(el) {
      // The URN on the container is the canonical identity of a LinkedIn post.
      const urnAttr =
        el.getAttribute("data-urn") ||
        el.getAttribute("data-id") ||
        pick(el, ["[data-urn]", "[data-id]"])?.getAttribute("data-urn") ||
        pick(el, ["[data-urn]", "[data-id]"])?.getAttribute("data-id") ||
        "";
      const fromUrn = linkedInPermalinkFromUrn(urnAttr);
      if (fromUrn) return fromUrn;

      for (const link of el.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]')) {
        const href = link.href || "";
        if (href && !href.includes("#")) return href.split("?")[0];
      }
      return "";
    }
  };

  /* ---------------- detection ---------------- */

  function detect(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (host.includes("linkedin")) return linkedin;
    if (host.includes("facebook")) return facebook;
    return null;
  }

  const api = { facebook, linkedin, detect, outermost, MAX_POST_CHARS };
  root.FindEPlatforms = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
