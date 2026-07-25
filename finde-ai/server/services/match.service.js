/**
 * Direct "match captured posts to what the user wants" service.
 *
 * This powers the extension flow: instead of infinite scrolling, the extension
 * captures the visible posts and sends them here with the user's query. An LLM
 * judges each post's fit (0-100) in ANY language and explains why. If no LLM key
 * is set, it falls back to local multilingual embedding similarity — so it always
 * works, just less nuanced.
 */
import { chat, llmEnabled } from "./llm.service.js";
import {
  embedText,
  embedMany,
  cosineSimilarity,
  normalizeSimilarity
} from "./embedding.service.js";

// The whole point is "no infinite scrolling": let the judge see MANY captured
// posts, not one screenful. Batched LLM calls keep each request small, so a
// large cap costs latency only, not correctness.
const MAX_POSTS = 150;
// Judge posts in batches: one giant call for 40 posts overflows maxTokens and
// the truncated JSON used to silently fall back to embeddings-only matching.
const LLM_BATCH_SIZE = 15;
const POST_SLICE_CHARS = 700;

function clampScore(n) {
  const v = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(100, v));
}

// Pull the first JSON object out of an LLM response (handles code fences / prose).
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function judgeBatch(query, posts, offset) {
  const numbered = posts
    .map(
      (p, i) =>
        `[${offset + i}] ${String(p.text || "").replace(/\s+/g, " ").slice(0, POST_SLICE_CHARS)}`
    )
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a precise search-relevance judge for social-media posts. The user describes the post they are looking for. Score EACH post from 0 to 100 for how well it matches the user's INTENT (meaning, not just keywords — posts and query may be in different languages). Give a short reason written in the SAME LANGUAGE as the user's query. Return ONLY strict JSON, no prose: {\"results\":[{\"index\":<int>,\"fitScore\":<0-100>,\"reason\":\"...\"}]}. Use the exact index shown in brackets. Omit posts scoring below 15."
    },
    {
      role: "user",
      content: `The user is looking for: ${query}\n\nPOSTS:\n${numbered}`
    }
  ];

  const res = await chat(messages, { temperature: 0, maxTokens: 1400 });
  const json = extractJson(res?.text);
  if (!json?.results || !Array.isArray(json.results)) return null;
  return { results: json.results, provider: res.provider, model: res.model };
}

async function matchWithLLM(query, posts, limit) {
  if (!llmEnabled() || !posts.length) return null;

  // Judge in parallel batches, then merge — resilient: if one batch fails or
  // returns bad JSON, we keep the others instead of losing everything.
  const batches = [];
  for (let i = 0; i < posts.length; i += LLM_BATCH_SIZE) {
    batches.push({ offset: i, posts: posts.slice(i, i + LLM_BATCH_SIZE) });
  }

  const settled = await Promise.allSettled(
    batches.map((b) => judgeBatch(query, b.posts, b.offset))
  );
  const ok = settled
    .filter((s) => s.status === "fulfilled" && s.value)
    .map((s) => s.value);
  if (!ok.length) return null;

  const merged = ok.flatMap((b) => b.results);
  const ranked = merged
    .filter((r) => posts[r.index])
    .map((r) => ({
      ...posts[r.index],
      fitScore: clampScore(r.fitScore),
      llmReason: String(r.reason || "").slice(0, 240),
      matchedBy: ["llm"]
    }))
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit);

  return {
    mode: "llm",
    provider: ok[0].provider,
    model: ok[0].model,
    results: ranked
  };
}

async function matchWithEmbeddings(query, posts, limit) {
  const qvec = await embedText(query, "query");
  if (!qvec) {
    return { mode: "none", results: posts.slice(0, limit).map((p) => ({ ...p, fitScore: 0 })) };
  }
  const vecs = await embedMany(posts.map((p) => p.text), "passage");
  const ranked = posts
    .map((p, i) => {
      const sim = vecs[i] ? normalizeSimilarity(cosineSimilarity(qvec, vecs[i])) : 0;
      return { ...p, fitScore: Math.round(sim * 100), semanticFit: Math.round(sim * 100), matchedBy: ["semantic"] };
    })
    .filter((p) => p.fitScore >= 15)
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit);
  return { mode: "embedding", results: ranked };
}

export async function matchCapturedPosts({ query, posts = [], limit = 10 }) {
  const q = String(query || "").trim();
  if (!q) {
    const error = new Error("query is required");
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(posts) || posts.length === 0) {
    const error = new Error("posts array is required");
    error.status = 400;
    throw error;
  }

  const safe = posts.slice(0, MAX_POSTS);
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), MAX_POSTS);

  // LLM judge first (best, multilingual); fall back to embeddings.
  const llm = await matchWithLLM(q, safe, safeLimit).catch(() => null);
  const result = llm || (await matchWithEmbeddings(q, safe, safeLimit));

  return {
    ok: true,
    query: q,
    mode: result.mode,
    provider: result.provider || null,
    model: result.model || null,
    count: result.results.length,
    scanned: safe.length,
    results: result.results
  };
}
