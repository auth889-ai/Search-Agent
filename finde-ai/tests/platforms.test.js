/**
 * Platform adapter tests — the Facebook and LinkedIn extractors running against
 * real DOM fixtures shaped like the markup each site actually ships.
 *
 * The regression these lock in: LinkedIn used to be a *label only*. The feed was
 * scanned with Facebook's selectors ([role="article"] + div[dir="auto"]), which
 * match nothing on LinkedIn, so every LinkedIn capture returned zero posts while
 * still reporting platform:"linkedin".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "./helpers/load-extension.js";

/* ---------------- fixtures ---------------- */

const FB_PAGE = `<!doctype html><html><head><title>(20) CSE Job Portal | Facebook</title></head><body>
  <div role="article" aria-label="Post">
    <h3><a href="/profile/1"><strong>Rafiul Islam</strong></a></h3>
    <a role="link" href="/groups/123/posts/456/"><span>2d</span></a>
    <div dir="auto">Looking for a frontend intern for our Dhaka office.</div>
    <div dir="auto">Stipend 15000 BDT. Apply before August 10 with your CV.</div>
    <div role="article">
      <div dir="auto">This is only a comment and must never land in the post body</div>
    </div>
  </div>
  <div role="article" aria-label="Post">
    <h3><a href="/profile/2"><strong>Nusrat Jahan</strong></a></h3>
    <div dir="auto">Sharing a scholarship deadline for masters applicants this fall.</div>
  </div>
</body></html>`;

const LI_PAGE = `<!doctype html><html><head><title>(3) Dhaka Devs | LinkedIn</title></head><body>
  <div class="feed-shared-update-v2" data-urn="urn:li:activity:7200000000000000001">
    <div class="update-components-actor">
      <span class="update-components-actor__title">
        <span aria-hidden="true">Ayesha Rahman</span><span class="visually-hidden">Ayesha Rahman</span>
      </span>
      <span class="update-components-actor__sub-description">
        <span aria-hidden="true">2d • Edited</span><span class="visually-hidden">2d • Edited</span>
      </span>
    </div>
    <div class="update-components-text">
      <span class="break-words">We are hiring a junior backend engineer in Dhaka. Remote friendly, apply before August 15.</span>
    </div>
    <div class="social-details-social-counts">12 reactions</div>
    <article class="comments-comment-entity">
      <div class="update-components-text">Great opportunity, I have shared this with my network already</div>
    </article>
  </div>
  <div class="feed-shared-update-v2" data-id="urn:li:fsd_update:(urn:li:ugcPost:98765,MAIN_FEED)">
    <div class="update-components-actor">
      <span class="update-components-actor__title"><span aria-hidden="true">Tanvir Ahmed</span></span>
    </div>
    <div class="update-components-text">
      <span class="break-words">Our team is opening two QA positions next month, details in the comments below.</span>
    </div>
  </div>
</body></html>`;

function fb() {
  const win = loadExtension(FB_PAGE, "https://www.facebook.com/groups/123");
  return { win, adapter: win.FindEPlatforms.detect(win.location.hostname) };
}

function li() {
  const win = loadExtension(LI_PAGE, "https://www.linkedin.com/groups/456/");
  return { win, adapter: win.FindEPlatforms.detect(win.location.hostname) };
}

/* ---------------- detection ---------------- */

test("detect picks the right adapter per host", () => {
  const win = loadExtension();
  const { detect } = win.FindEPlatforms;
  assert.equal(detect("www.facebook.com").name, "facebook");
  assert.equal(detect("m.facebook.com").name, "facebook");
  assert.equal(detect("www.linkedin.com").name, "linkedin");
  assert.equal(detect("example.com"), null);
});

/* ---------------- Facebook ---------------- */

test("facebook: finds top-level posts and excludes nested comment articles", () => {
  const { adapter } = fb();
  const posts = adapter.postContainers().filter((el) => !adapter.isNested(el));
  assert.equal(posts.length, 2);
});

test("facebook: keeps every paragraph of a multi-block post and drops comment text", () => {
  const { adapter } = fb();
  const post = adapter.postContainers()[0];
  const text = adapter.message(post);
  assert.match(text, /frontend intern/);
  assert.match(text, /Stipend 15000 BDT/);
  assert.doesNotMatch(text, /only a comment/);
});

test("facebook: extracts author, permalink and relative date", () => {
  const { adapter } = fb();
  const post = adapter.postContainers()[0];
  assert.equal(adapter.author(post), "Rafiul Islam");
  assert.equal(adapter.permalink(post), "https://www.facebook.com/groups/123/posts/456/");
  // "2d" sits on a link alongside a non-timestamp profile link; the profile
  // link must be skipped rather than aborting the search.
  const date = adapter.date(post);
  assert.ok(date, "expected a parsed date");
  const ageDays = (Date.now() - Date.parse(date)) / 86400000;
  assert.ok(ageDays > 1.9 && ageDays < 2.1, `expected ~2 days, got ${ageDays}`);
});

/* ---------------- LinkedIn ---------------- */

test("linkedin: finds feed posts (the bug: Facebook selectors found none)", () => {
  const { win, adapter } = li();
  assert.equal(adapter.name, "linkedin");

  const posts = adapter.postContainers().filter((el) => !adapter.isNested(el));
  assert.equal(posts.length, 2);

  // Proof of the original defect: the Facebook adapter sees nothing here.
  assert.equal(win.FindEPlatforms.facebook.postContainers().length, 0);
});

test("linkedin: extracts the post body and never a comment body", () => {
  const { adapter } = li();
  const post = adapter.postContainers()[0];
  const text = adapter.message(post);
  assert.match(text, /junior backend engineer in Dhaka/);
  // The comment reuses the SAME .update-components-text class as the post.
  assert.doesNotMatch(text, /shared this with my network/);
});

test("linkedin: de-duplicates the screen-reader copy of the author name", () => {
  const { adapter } = li();
  const post = adapter.postContainers()[0];
  // Rendered twice in the DOM; must not come back as "Ayesha RahmanAyesha Rahman".
  assert.equal(adapter.author(post), "Ayesha Rahman");
});

test("linkedin: parses the age out of the sub-description metadata string", () => {
  const { adapter } = li();
  const post = adapter.postContainers()[0];
  const date = adapter.date(post);
  assert.ok(date, "expected a parsed date from '2d • Edited'");
  const ageDays = (Date.now() - Date.parse(date)) / 86400000;
  assert.ok(ageDays > 1.9 && ageDays < 2.1, `expected ~2 days, got ${ageDays}`);
});

test("linkedin: builds permalinks from both data-urn and data-id", () => {
  const { adapter } = li();
  const [first, second] = adapter.postContainers();
  assert.equal(
    adapter.permalink(first),
    "https://www.linkedin.com/feed/update/urn:li:activity:7200000000000000001/"
  );
  // The second post carries the URN nested inside a data-id wrapper string.
  assert.equal(
    adapter.permalink(second),
    "https://www.linkedin.com/feed/update/urn:li:ugcPost:98765/"
  );
});

test("linkedin: a comment entity is reported as nested, never as a post", () => {
  const { win, adapter } = li();
  const comment = win.document.querySelector(".comments-comment-entity");
  assert.ok(comment);
  assert.equal(adapter.isNested(comment), true);
  assert.equal(adapter.postContainers().includes(comment), false);
});

/* ---------------- shared ---------------- */

test("outermost collapses a container matched by several selector layers", () => {
  const { win, adapter } = li();
  // .feed-shared-update-v2 also matches [class*="feed-shared-update-v2"] and
  // [data-urn*=...]; each post must still appear exactly once.
  const containers = adapter.postContainers();
  assert.equal(new win.Set(containers).size, containers.length);
});
