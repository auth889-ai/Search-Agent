/**
 * FindE AI extraction core — pure, DOM-free text filtering shared by both
 * platform adapters (Facebook + LinkedIn).
 *
 * Loaded as a content script before platforms.js / content.js (attaches to
 * globalThis), and also loadable in Node for unit tests. Keeping the
 * noise-filtering logic here, separate from DOM traversal, lets us test it
 * against real Facebook/LinkedIn garbage without a browser.
 */
(function (root) {
  const MIN_POST_CHARS = 25;

  // Chrome-visible UI chrome that is never post content. Facebook terms first,
  // LinkedIn terms second (repost/impressions/degree badges/promoted).
  const UI_NOISE = new RegExp(
    "^(see more|…see more|see translation|see original|all reactions?|like|love|haha|wow|" +
      "comment|comments|share|shares|follow|following|reply|replies|active now|" +
      "write a comment|view more comments|view \\d+ (more )?comments?|most relevant|" +
      "top fan|author|admin|moderator|suggested for you|sponsored|· follow|" +
      "public group|private group|join|joined|members|facebook|" +
      // LinkedIn
      "repost|reposts|send|save|saved|promoted|premium|linkedin|" +
      "\\d+(st|nd|rd|th)|• ?\\d+(st|nd|rd|th)|connection|1st|2nd|3rd|" +
      "\\d[\\d,.]*\\s*(impressions?|followers?|connections?|reactions?)|" +
      "show all|see all|load more|new post|feed post|celebrate|support|insightful|funny|" +
      "add a comment|be the first to comment|visible to anyone|edited)$",
    "i"
  );

  // Recommendation / entity cards that render like posts but are not posts:
  // "Public · 37K members · 70+ posts a day", "1,204 followers", "Promoted".
  const ENTITY_CARD =
    /(\d[\d.,]*\s*(k|m)?\+?\s*(members|followers)|posts a day|·\s*(public|private)\b|(public|private)\s*·|^promoted\b|^sponsored\b)/i;

  function cleanText(value) {
    return String(value || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  /**
   * LinkedIn renders the same string twice for screen readers:
   *   <span class="visually-hidden">Jane Doe</span><span aria-hidden="true">Jane Doe</span>
   * innerText keeps both, so names/timestamps arrive doubled. Collapse exact
   * repetition — both the "A\nA" line form and the "AA" concatenated form.
   */
  function stripDuplicatedHalf(text) {
    const t = cleanText(text);
    if (!t) return "";

    // Consecutive duplicate lines: "Jane Doe\nJane Doe\n2d\n2d"
    const lines = t.split("\n").map((s) => s.trim()).filter(Boolean);
    const deduped = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
    const joined = deduped.join("\n");

    // Whole string duplicated with no separator: "Jane DoeJane Doe"
    if (joined.length % 2 === 0) {
      const half = joined.length / 2;
      if (joined.slice(0, half) === joined.slice(half)) return joined.slice(0, half).trim();
    }
    return joined;
  }

  // Does a text block look like a real human-written post (not UI / obfuscated junk)?
  function looksLikeRealText(text) {
    if (!text || text.length < MIN_POST_CHARS) return false;
    if (UI_NOISE.test(text)) return false;
    if (ENTITY_CARD.test(text)) return false;

    const words = text.split(/\s+/).filter((w) => w.length > 1);
    if (words.length < 5) return false;

    // Reject obfuscated blobs (mostly no-space alphanumeric with digits mixed in).
    // Count letters of ANY script (Bengali, Arabic, Latin, ...) so non-English
    // posts are not wrongly discarded.
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters / text.length < 0.4) return false;

    // Reject the "Facebook Facebook Facebook" alt-text runs.
    const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
    if (uniqueWords.size <= 2 && words.length > 4) return false;

    return true;
  }

  function stripTrailingUi(text) {
    return cleanText(text)
      .replace(/\s*…?\s*See (more|translation|original)\s*$/i, "")
      .replace(/\s*…\s*$/, "")
      .trim();
  }

  /**
   * Post identity for deduplication. A permalink (Facebook story id, LinkedIn
   * activity URN) is the only trustworthy identity — two different people can
   * post byte-identical text, and the same post re-renders with slightly
   * different whitespace as the feed virtualizes. Text is the fallback.
   */
  function dedupeKey(post) {
    const url = cleanText(post?.url || "");
    if (url) return `url:${url.toLowerCase()}`;
    const text = cleanText(post?.text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 160);
    return `txt:${text}`;
  }

  /** "urn:li:activity:7123" -> canonical LinkedIn permalink. Null if not a URN. */
  function linkedInPermalinkFromUrn(urn) {
    const m = String(urn || "").match(/urn:li:(activity|ugcPost|share):[0-9]+/i);
    return m ? `https://www.linkedin.com/feed/update/${m[0]}/` : null;
  }

  /**
   * Group/page name from the tab title. Both platforms prefix an unread count
   * and suffix the brand: "(20) CSE Job Portal | Facebook".
   */
  function deriveGroupName(title) {
    const t = cleanText(title)
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/\s*[|·]\s*(facebook|linkedin).*$/i, "")
      .replace(/\s*[|·].*$/, "")
      .trim();
    return t || "Community";
  }

  /* ---------------- post timestamp parsing ----------------
   * Facebook/LinkedIn render post ages as short labels: "2d", "5 hrs", "Just
   * now", "Yesterday at 10:30", "June 5", "২ দিন" ... Turning these into real
   * dates is what makes freshness ranking REAL instead of "everything was
   * captured today". Pure + best-effort: returns an ISO string or null.
   */

  const BN_DIGITS = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };

  function normalizeDigits(value) {
    return String(value || "").replace(/[০-৯]/g, (d) => BN_DIGITS[d]);
  }

  const REL_UNITS = [
    { ms: 1000, re: /^(\d+)\s*(s|sec|secs|second|seconds)$/i },
    { ms: 60 * 1000, re: /^(\d+)\s*(m|min|mins|minute|minutes|মিনিট)$/i },
    { ms: 3600 * 1000, re: /^(\d+)\s*(h|hr|hrs|hour|hours|ঘণ্টা|ঘন্টা)$/i },
    { ms: 86400 * 1000, re: /^(\d+)\s*(d|day|days|দিন)$/i },
    { ms: 7 * 86400 * 1000, re: /^(\d+)\s*(w|wk|wks|week|weeks|সপ্তাহ)$/i },
    { ms: 30 * 86400 * 1000, re: /^(\d+)\s*(mo|mos|month|months|মাস)$/i },
    { ms: 365 * 86400 * 1000, re: /^(\d+)\s*(y|yr|yrs|year|years|বছর)$/i }
  ];

  function parsePostTimestamp(label, nowMs) {
    const now = Number(nowMs) || Date.now();
    // LinkedIn packs metadata into one string: "2d • Edited • Visible to anyone".
    // Keep only the leading age token.
    let t = cleanText(normalizeDigits(label))
      .replace(/\s*[·•].*$/, "")
      .replace(/\s*\(edited\)\s*$/i, "")
      .trim();
    if (!t || t.length > 40) return null;

    if (/^(just now|now|a few seconds ago|এইমাত্র)$/i.test(t)) {
      return new Date(now).toISOString();
    }
    if (/^(yesterday|গতকাল)( at .+)?$/i.test(t)) {
      return new Date(now - 86400 * 1000).toISOString();
    }

    // Relative ages: "2d", "5 hrs ago", "৩ দিন", "1w"
    const rel = t.replace(/\s+ago$/i, "");
    for (const unit of REL_UNITS) {
      const m = rel.match(unit.re);
      if (m) return new Date(now - Number(m[1]) * unit.ms).toISOString();
    }

    // Absolute dates: "June 5", "June 5 at 10:30 AM", "5 June 2025", "May 3, 2026"
    const abs = t.replace(/\bat\b/i, "").trim();
    const hasMonth =
      /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i.test(abs);
    if (hasMonth) {
      const hasYear = /\d{4}/.test(abs);
      const candidate = hasYear ? abs : `${abs} ${new Date(now).getFullYear()}`;
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) {
        // A month/day with no year that lands in the future means LAST year.
        if (!hasYear && parsed.getTime() > now + 86400 * 1000) {
          parsed.setFullYear(parsed.getFullYear() - 1);
        }
        return parsed.toISOString();
      }
    }

    return null;
  }

  const api = {
    MIN_POST_CHARS,
    UI_NOISE,
    ENTITY_CARD,
    cleanText,
    stripDuplicatedHalf,
    looksLikeRealText,
    stripTrailingUi,
    dedupeKey,
    linkedInPermalinkFromUrn,
    deriveGroupName,
    parsePostTimestamp,
    normalizeDigits
  };
  root.FindEExtract = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
