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

  const api = { MIN_POST_CHARS, UI_NOISE, cleanText, looksLikeRealText, stripTrailingUi };
  root.FindEExtract = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
