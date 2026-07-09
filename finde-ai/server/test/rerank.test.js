/**
 * Unit tests for the optional Cohere neural re-ranker.
 * Verifies it degrades gracefully (never throws, returns input) without a key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rerankResults, rerankerEnabled } from "../services/rerank.service.js";

const SAMPLE = [
  { title: "Remote frontend internship", snippet: "React JavaScript internship", topics: ["internship"] },
  { title: "MongoDB connection error", snippet: "Atlas IP allowlist fix", topics: ["coding"] }
];

test("rerankerEnabled reflects COHERE_API_KEY presence", () => {
  const prev = process.env.COHERE_API_KEY;
  delete process.env.COHERE_API_KEY;
  assert.equal(rerankerEnabled(), false);
  process.env.COHERE_API_KEY = "x";
  assert.equal(rerankerEnabled(), true);
  if (prev === undefined) delete process.env.COHERE_API_KEY;
  else process.env.COHERE_API_KEY = prev;
});

test("rerankResults is a safe no-op without a key", async () => {
  const prev = process.env.COHERE_API_KEY;
  delete process.env.COHERE_API_KEY;
  const { reranked, used } = await rerankResults("frontend internship", SAMPLE);
  assert.equal(used, false);
  assert.deepEqual(reranked, SAMPLE, "input returned unchanged");
  if (prev !== undefined) process.env.COHERE_API_KEY = prev;
});

test("rerankResults skips when fewer than 2 docs", async () => {
  const { reranked, used } = await rerankResults("q", [SAMPLE[0]]);
  assert.equal(used, false);
  assert.equal(reranked.length, 1);
});
