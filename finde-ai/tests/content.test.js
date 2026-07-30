/**
 * End-to-end content-script tests: the real message bridge, the real visibility
 * filter, the real adapters — driven exactly as popup.js drives them.
 *
 * The headline regression: a LinkedIn capture must now come back with real
 * posts tagged platform:"linkedin". Before the platform adapters existed, the
 * popup ran a Facebook-only extractor that hardcoded platform:"facebook", so
 * LinkedIn produced zero posts under the wrong label.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadContentScript } from "./helpers/load-extension.js";

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
    <article class="comments-comment-entity">
      <div class="update-components-text">Great opportunity, I have shared this with my network already</div>
    </article>
  </div>
  <div class="feed-shared-update-v2" data-urn="urn:li:activity:7200000000000000002">
    <div class="update-components-text">
      <span class="break-words">Our team is opening two QA positions next month, details in the comments below.</span>
    </div>
  </div>
</body></html>`;

const FB_PAGE = `<!doctype html><html><head><title>(20) CSE Job Portal | Facebook</title></head><body>
  <div role="article">
    <h3><a href="/profile/1"><strong>Rafiul Islam</strong></a></h3>
    <a role="link" href="/groups/123/posts/456/"><span>2d</span></a>
    <div dir="auto">Looking for a frontend intern for our Dhaka office.</div>
    <div dir="auto">Stipend 15000 BDT. Apply before August 10 with your CV.</div>
  </div>
</body></html>`;

// Two posts whose bodies are byte-identical but which are different posts.
const LI_DUPLICATE_TEXT = `<!doctype html><html><head><title>Dhaka Devs | LinkedIn</title></head><body>
  <div class="feed-shared-update-v2" data-urn="urn:li:activity:111">
    <div class="update-components-text">We are hiring a junior backend engineer in Dhaka right now.</div>
  </div>
  <div class="feed-shared-update-v2" data-urn="urn:li:activity:222">
    <div class="update-components-text">We are hiring a junior backend engineer in Dhaka right now.</div>
  </div>
</body></html>`;

test("linkedin capture returns real posts tagged platform:linkedin", async () => {
  const { send } = loadContentScript(LI_PAGE, "https://www.linkedin.com/groups/456/");
  const res = await send("FINDE_EXTRACT_POSTS");

  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.ok(res.posts.every((p) => p.platform === "linkedin"));

  const [first] = res.posts;
  assert.match(first.text, /junior backend engineer in Dhaka/);
  assert.doesNotMatch(first.text, /shared this with my network/);
  assert.equal(first.authorDisplay, "Ayesha Rahman");
  assert.equal(first.url, "https://www.linkedin.com/feed/update/urn:li:activity:7200000000000000001/");
  assert.equal(first.groupName, "Dhaka Devs");
  assert.equal(first.dateSource, "post_timestamp");
  assert.ok(first.date, "expected a resolved post date");
});

test("facebook capture still works and is tagged platform:facebook", async () => {
  const { send } = loadContentScript(FB_PAGE, "https://www.facebook.com/groups/123");
  const res = await send("FINDE_EXTRACT_POSTS");

  assert.equal(res.count, 1);
  const [post] = res.posts;
  assert.equal(post.platform, "facebook");
  assert.equal(post.groupName, "CSE Job Portal");
  assert.equal(post.authorDisplay, "Rafiul Islam");
  assert.match(post.text, /Stipend 15000 BDT/);
});

test("posts with identical text but different permalinks are both kept", async () => {
  const { send } = loadContentScript(LI_DUPLICATE_TEXT, "https://www.linkedin.com/feed/");
  const res = await send("FINDE_EXTRACT_POSTS");
  // Text-only dedup used to collapse these into one, silently losing a post.
  assert.equal(res.count, 2);
  assert.equal(new Set(res.posts.map((p) => p.url)).size, 2);
});

test("ping reports the detected platform", async () => {
  const { send } = loadContentScript(LI_PAGE, "https://www.linkedin.com/groups/456/");
  // Objects cross the jsdom realm boundary, so compare fields, not identity.
  const res = await send("FINDE_PING");
  assert.equal(res.ok, true);
  assert.equal(res.platform, "linkedin");
});

test("extraction stats distinguish 'no containers' from 'no readable text'", async () => {
  const empty = loadContentScript(
    `<!doctype html><html><head><title>LinkedIn</title></head><body><div>nothing here</div></body></html>`,
    "https://www.linkedin.com/feed/"
  );
  const res = await empty.send("FINDE_EXTRACT_POSTS");
  assert.equal(res.count, 0);
  assert.equal(res.stats.platform, "linkedin");
  assert.equal(res.stats.containers, 0);

  const textless = loadContentScript(
    `<!doctype html><html><head><title>LinkedIn</title></head><body>
       <div class="feed-shared-update-v2" data-urn="urn:li:activity:9"></div>
     </body></html>`,
    "https://www.linkedin.com/feed/"
  );
  const res2 = await textless.send("FINDE_EXTRACT_POSTS");
  assert.equal(res2.count, 0);
  assert.equal(res2.stats.containers, 1, "container found, just no readable body");
});

test("live capture streams batches to the background worker and dedupes", async () => {
  const { send, sentToBackground } = loadContentScript(
    LI_PAGE,
    "https://www.linkedin.com/groups/456/"
  );

  const started = await send("FINDE_LIVE_START");
  assert.equal(started.active, true);
  assert.equal(started.captured, 2);

  // Stopping flushes whatever is buffered.
  const stopped = await send("FINDE_LIVE_STOP");
  assert.equal(stopped.active, false);

  const batches = sentToBackground.filter((m) => m.type === "FINDE_LIVE_BATCH");
  const posts = batches.flatMap((b) => b.posts);
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => p.platform === "linkedin"));
  assert.ok(posts.every((p) => p.captureMode === "user_scrolled_visible_posts"));
});

test("live capture does not re-send posts already seen this session", async () => {
  const { send, sentToBackground } = loadContentScript(
    LI_PAGE,
    "https://www.linkedin.com/groups/456/"
  );
  await send("FINDE_LIVE_START");
  await send("FINDE_LIVE_STOP");
  await send("FINDE_LIVE_START"); // same posts still on screen
  await send("FINDE_LIVE_STOP");

  const posts = sentToBackground
    .filter((m) => m.type === "FINDE_LIVE_BATCH")
    .flatMap((b) => b.posts);
  assert.equal(posts.length, 2, "the same two posts must not be uploaded twice");
});
