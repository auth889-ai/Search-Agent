/**
 * FindE AI extraction core — pure, DOM-free text filtering for Facebook posts.
 *
 * Loaded as a content script before content.js (attaches to globalThis), and
 * also loadable in Node for unit tests. Keeping the noise-filtering logic here,
 * separate from DOM traversal, lets us test it against real Facebook garbage.
 */
(function (root) {
  const MIN_POST_CHARS = 25;

  const UI_NOISE = new RegExp(
    "^(see more|see translation|see original|all reactions?|like|love|haha|wow|" +
      "comment|comments|share|shares|follow|following|reply|replies|active now|" +
      "write a comment|view more comments|view \\d+ (more )?comments?|most relevant|" +
      "top fan|author|admin|moderator|suggested for you|sponsored|· follow|" +
      "public group|private group|join|joined|members|facebook)$",
    "i"
  );

  function cleanText(value) {
    return String(value || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  // Does a text block look like a real human-written post (not UI / obfuscated junk)?
  function looksLikeRealText(text) {
    if (!text || text.length < MIN_POST_CHARS) return false;
    if (UI_NOISE.test(text)) return false;

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
    return cleanText(text).replace(/\s*See (more|translation|original)\s*$/i, "").trim();
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
    { ms: 60 * 1000, re: /^(\d+)\s*(m|min|mins|minute|minutes|মিনিট)$/i },
    { ms: 3600 * 1000, re: /^(\d+)\s*(h|hr|hrs|hour|hours|ঘণ্টা|ঘন্টা)$/i },
    { ms: 86400 * 1000, re: /^(\d+)\s*(d|day|days|দিন)$/i },
    { ms: 7 * 86400 * 1000, re: /^(\d+)\s*(w|wk|wks|week|weeks|সপ্তাহ)$/i },
    { ms: 30 * 86400 * 1000, re: /^(\d+)\s*(mo|month|months|মাস)$/i },
    { ms: 365 * 86400 * 1000, re: /^(\d+)\s*(y|yr|yrs|year|years|বছর)$/i }
  ];

  function parsePostTimestamp(label, nowMs) {
    const now = Number(nowMs) || Date.now();
    let t = cleanText(normalizeDigits(label)).replace(/\s*·.*$/, "");
    if (!t || t.length > 40) return null;

    if (/^(just now|now|a few seconds ago|এইমাত্র)$/i.test(t)) {
      return new Date(now).toISOString();
    }
    if (/^(yesterday|গতকাল)( at .+)?$/i.test(t)) {
      return new Date(now - 86400 * 1000).toISOString();
    }

    // Relative ages: "2d", "5 hrs ago", "৩ দিন"
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
    cleanText,
    looksLikeRealText,
    stripTrailingUi,
    parsePostTimestamp,
    normalizeDigits
  };
  root.FindEExtract = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
