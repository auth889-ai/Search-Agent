/**
 * FindE AI end-to-end tests.
 *
 * Spawns the real backend, waits for health, then exercises the full stack:
 * hybrid semantic search, fit scoring, ingestion round-trip, and the agent
 * pipeline. Requires Elasticsearch running and seeded (npm run elastic:up + seed).
 *
 * Run:  npm test        (from the server/ folder)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const PORT = process.env.FINDE_TEST_PORT || 8090;
const BASE = `http://localhost:${PORT}`;

let child;

async function waitForHealth(timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const data = await res.json();
        if (data?.elastic?.reachable) return data;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Backend did not become healthy in time (is Elasticsearch up + seeded?)");
}

before(async () => {
  child = spawn("node", ["server.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore"
  });
  await waitForHealth();
});

after(() => {
  if (child) child.kill("SIGTERM");
});

test("health reports Elasticsearch reachable with seeded docs", async () => {
  const res = await fetch(`${BASE}/api/health`);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.elastic.reachable, true);
  assert.ok(data.elastic.communityDocs >= 1, "expected seeded community docs");
});

test("hybrid search returns semantic mode and fit scores", async () => {
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "remote internship for students", sourceMode: "community", limit: 5 })
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.searchMode, "hybrid_semantic_keyword");
  assert.ok(data.results.length > 0, "expected results");
  const top = data.results[0];
  assert.ok(typeof top.fitScore === "number", "fitScore present");
  assert.ok(typeof top.semanticFit === "number", "semanticFit present");
});

test("semantic match works with NO keyword overlap", async () => {
  // None of these words appear in the MongoDB post, but meaning matches.
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "my application cannot reach the cloud data store",
      sourceMode: "community",
      limit: 3
    })
  });
  const data = await res.json();
  assert.ok(/mongo|connection|database/i.test(data.results[0].title), `unexpected top match: ${data.results[0].title}`);
});

test("ingestion round-trip: index a post then find it", async () => {
  const unique = "quantum photonics lab assistantship stipend Dhaka";
  const ingest = await fetch(`${BASE}/api/posts/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "e2e_test",
      posts: [
        {
          groupName: "Test Group",
          text: `We offer a ${unique} for physics students. Apply with your CV before August.`,
          url: "https://facebook.com/groups/demo/posts/e2e-quantum",
          date: "2026-07-01"
        }
      ]
    })
  });
  const ingestData = await ingest.json();
  assert.equal(ingestData.ok, true);
  assert.ok(ingestData.accepted >= 1, "post should be accepted");

  const search = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "photonics research stipend for physics", sourceMode: "community", limit: 5 })
  });
  const searchData = await search.json();
  const found = searchData.results.some((r) => /photonics/i.test(r.title + r.text));
  assert.ok(found, "newly indexed post should be searchable");
});

test("agent pipeline returns a grounded answer with citations and a trace", async () => {
  const res = await fetch(`${BASE}/api/agent/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "beginner AI cybersecurity research idea", sourceMode: "all", limit: 5 })
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.answer && data.answer.length > 0, "answer text present");
  assert.ok(Array.isArray(data.citations) && data.citations.length > 0, "citations present");
  assert.ok(Array.isArray(data.trace) && data.trace.length >= 4, "expected planner->composer trace");
  const agents = data.trace.map((t) => t.agent);
  assert.ok(agents.includes("IntentPlanner"), "planner step present");
  assert.ok(agents.includes("AnswerComposer"), "composer step present");
});

test("empty query is rejected with 400", async () => {
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "  " })
  });
  assert.equal(res.status, 400);
});
