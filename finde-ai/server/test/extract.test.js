/**
 * Tests the extension's text-filter against REAL Facebook garbage captured from
 * a live "Internship & Job Opportunities" group (53.2K members). Proves the
 * filter keeps genuine posts (incl. Bengali/Arabic) and drops FB's DOM noise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.resolve(__dirname, "../../extension/extract-core.js");
const code = fs.readFileSync(corePath, "utf8");

// Load the browser IIFE into a sandbox (it attaches to the passed globalThis).
const sandbox = {};
// eslint-disable-next-line no-new-func
new Function("globalThis", "module", code)(sandbox, {});
const { looksLikeRealText } = sandbox.FindEExtract;

// Real junk seen in the user's live capture.
const JUNK = [
  "Facebook",
  "Facebook Facebook Facebook Facebook Facebook Facebook",
  "roendptoSs2ctg8630il9ftggu78i0at001ccl960h0ca09",
  "odetonSrspg21u3u18fua8930tth071f286",
  "Public group",
  "· Follow",
  "See more",
  "See translation",
  "53.2K members",
  "746",
  "AI info"
];

// Real posts seen in the same group (English + Bengali + Arabic).
const REAL = [
  "We're Hiring – Digital marketing Assistant / Executive #workfromhome apply now with your CV",
  "Sun Life Canada is looking for interns! Apply before the deadline to join the program.",
  "Brain Station 23 is hiring Software Engineer Interns. Batch starts October 2026. Apply with your CV.",
  "আমরা একজন সফটওয়্যার ইঞ্জিনিয়ার ইন্টার্ন নিচ্ছি। আবেদন করুন এখনই আপনার সিভি দিয়ে।",
  "🚀 فرصة قوية لحديثي التخرج في مجال المبيعات! تقدم الآن مع سيرتك الذاتية اليوم"
];

test("filter drops real Facebook DOM noise", () => {
  for (const junk of JUNK) {
    assert.equal(looksLikeRealText(junk), false, `should reject junk: "${junk}"`);
  }
});

test("filter keeps real posts including Bengali and Arabic", () => {
  for (const post of REAL) {
    assert.equal(looksLikeRealText(post), true, `should keep post: "${post.slice(0, 40)}…"`);
  }
});
