/**
 * Unit tests for the pure extraction helpers shared by both platform adapters.
 * These encode the real garbage Facebook and LinkedIn emit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadCore } from "./helpers/load-extension.js";

const core = loadCore();

/* ---------------- stripDuplicatedHalf (LinkedIn screen-reader duplication) ---------------- */

test("stripDuplicatedHalf collapses concatenated duplication", () => {
  assert.equal(core.stripDuplicatedHalf("Ayesha RahmanAyesha Rahman"), "Ayesha Rahman");
  assert.equal(core.stripDuplicatedHalf("2d •2d •"), "2d •");
});

test("stripDuplicatedHalf collapses consecutive duplicate lines", () => {
  assert.equal(core.stripDuplicatedHalf("Ayesha Rahman\nAyesha Rahman"), "Ayesha Rahman");
  assert.equal(core.stripDuplicatedHalf("Jane Doe\nJane Doe\n2d\n2d"), "Jane Doe\n2d");
});

test("stripDuplicatedHalf leaves genuinely repeated-looking text alone", () => {
  // Not a duplication — two different halves.
  assert.equal(core.stripDuplicatedHalf("Dhaka office"), "Dhaka office");
  // A real post that happens to repeat a word must survive intact.
  const real = "Hiring now. Hiring closes Friday.";
  assert.equal(core.stripDuplicatedHalf(real), real);
});

/* ---------------- looksLikeRealText ---------------- */

test("looksLikeRealText accepts a genuine multi-sentence post", () => {
  assert.equal(
    core.looksLikeRealText(
      "We are hiring a junior backend engineer in Dhaka. Remote friendly, apply before August 15."
    ),
    true
  );
});

test("looksLikeRealText accepts non-English posts", () => {
  // Bengali job post — must not be discarded by the letter-ratio heuristic.
  assert.equal(
    core.looksLikeRealText("আমরা একজন জুনিয়র ব্যাকএন্ড ইঞ্জিনিয়ার নিয়োগ দিচ্ছি ঢাকায় আবেদন করুন"),
    true
  );
});

test("looksLikeRealText rejects UI chrome from both platforms", () => {
  for (const noise of [
    "See more",
    "All reactions",
    "View 12 more comments",
    "Repost",
    "Promoted",
    "Be the first to comment"
  ]) {
    assert.equal(core.looksLikeRealText(noise), false, `should reject: ${noise}`);
  }
});

test("looksLikeRealText rejects entity/recommendation cards", () => {
  assert.equal(core.looksLikeRealText("Public · 37K members · 70+ posts a day"), false);
  assert.equal(core.looksLikeRealText("Acme Corp · 1,204 followers · Promoted post"), false);
});

test("looksLikeRealText rejects obfuscated alt-text runs", () => {
  assert.equal(core.looksLikeRealText("Facebook Facebook Facebook Facebook Facebook"), false);
});

test("looksLikeRealText rejects text that is too short", () => {
  assert.equal(core.looksLikeRealText("Nice one thanks"), false);
});

/* ---------------- stripTrailingUi ---------------- */

test("stripTrailingUi removes see-more affordances including the ellipsis form", () => {
  assert.equal(core.stripTrailingUi("Apply before Friday… see more"), "Apply before Friday");
  assert.equal(core.stripTrailingUi("Apply before Friday See more"), "Apply before Friday");
  assert.equal(core.stripTrailingUi("Apply before Friday See translation"), "Apply before Friday");
});

/* ---------------- parsePostTimestamp ---------------- */

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const daysAgo = (n) => new Date(NOW - n * 86400 * 1000).toISOString();

test("parsePostTimestamp handles relative ages", () => {
  assert.equal(core.parsePostTimestamp("2d", NOW), daysAgo(2));
  assert.equal(core.parsePostTimestamp("2 days ago", NOW), daysAgo(2));
  assert.equal(core.parsePostTimestamp("1w", NOW), daysAgo(7));
  assert.equal(core.parsePostTimestamp("just now", NOW), new Date(NOW).toISOString());
  assert.equal(core.parsePostTimestamp("Yesterday at 10:30", NOW), daysAgo(1));
});

test("parsePostTimestamp strips LinkedIn's metadata tail", () => {
  // The real sub-description string LinkedIn renders.
  assert.equal(core.parsePostTimestamp("2d • Edited • Visible to anyone", NOW), daysAgo(2));
  assert.equal(core.parsePostTimestamp("3w •", NOW), daysAgo(21));
});

test("parsePostTimestamp handles Bengali digits and units", () => {
  assert.equal(core.parsePostTimestamp("২ দিন", NOW), daysAgo(2));
});

test("parsePostTimestamp resolves a bare month/day that would land in the future to last year", () => {
  const parsed = core.parsePostTimestamp("December 5", NOW);
  assert.equal(new Date(parsed).getFullYear(), 2025);
});

test("parsePostTimestamp returns null for non-timestamps", () => {
  assert.equal(core.parsePostTimestamp("Senior Engineer at Acme", NOW), null);
  assert.equal(core.parsePostTimestamp("", NOW), null);
});

/* ---------------- dedupeKey ---------------- */

test("dedupeKey prefers the permalink so identical text from different posts stays distinct", () => {
  const a = { url: "https://www.linkedin.com/feed/update/urn:li:activity:1/", text: "Hiring now" };
  const b = { url: "https://www.linkedin.com/feed/update/urn:li:activity:2/", text: "Hiring now" };
  assert.notEqual(core.dedupeKey(a), core.dedupeKey(b));
});

test("dedupeKey falls back to text when there is no permalink", () => {
  const a = { text: "We are hiring a backend engineer" };
  const b = { text: "  We are hiring   a backend engineer  " };
  assert.equal(core.dedupeKey(a), core.dedupeKey(b));
});

/* ---------------- linkedInPermalinkFromUrn ---------------- */

test("linkedInPermalinkFromUrn builds a canonical URL from activity and ugcPost URNs", () => {
  assert.equal(
    core.linkedInPermalinkFromUrn("urn:li:activity:7200000000000000001"),
    "https://www.linkedin.com/feed/update/urn:li:activity:7200000000000000001/"
  );
  // LinkedIn also embeds the URN in a longer data-id string.
  assert.equal(
    core.linkedInPermalinkFromUrn("urn:li:fsd_update:(urn:li:ugcPost:12345,MAIN_FEED)"),
    "https://www.linkedin.com/feed/update/urn:li:ugcPost:12345/"
  );
  assert.equal(core.linkedInPermalinkFromUrn("not-a-urn"), null);
});

/* ---------------- deriveGroupName ---------------- */

test("deriveGroupName strips unread counts and the brand suffix", () => {
  assert.equal(core.deriveGroupName("(20) CSE Job Portal | Facebook"), "CSE Job Portal");
  assert.equal(core.deriveGroupName("(3+) Dhaka Devs | LinkedIn"), "Dhaka Devs");
  assert.equal(core.deriveGroupName("Bangladesh Tech Jobs"), "Bangladesh Tech Jobs");
  assert.equal(core.deriveGroupName(""), "Community");
});
