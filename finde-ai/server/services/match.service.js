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
import { embedText, embedMany, cosineSimilarity } from "./embedding.service.js";

const MAX_POSTS = 40;

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

async function matchWithLLM(query, posts, limit) {
  if (!llmEnabled() || !posts.length) return null;

  const numbered = posts
    .map((p, i) => `[${i}] ${String(p.text || "").replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a precise search-relevance judge for social-media posts. The user describes the post they are looking for. Score EACH post from 0 to 100 for how well it matches the user's INTENT (meaning, not just keywords). Give a short reason written in the SAME LANGUAGE as the user's query. Return ONLY strict JSON, no prose: {\"results\":[{\"index\":<int>,\"fitScore\":<0-100>,\"reason\":\"...\"}]}. Sort by fitScore descending and omit posts scoring below 15."
    },
    {
      role: "user",
      content: `The user is looking for: ${query}\n\nPOSTS:\n${numbered}`
    }
  ];

  const res = await chat(messages, { temperature: 0, maxTokens: 1400 });
  const json = extractJson(res?.text);
  if (!json?.results || !Array.isArray(json.results)) return null;

  const ranked = json.results
    .filter((r) => posts[r.index])
    .map((r) => ({
      ...posts[r.index],
      fitScore: clampScore(r.fitScore),
      llmReason: String(r.reason || "").slice(0, 240),
      matchedBy: ["llm"]
    }))
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit);

  return { mode: "llm", provider: res.provider, model: res.model, results: ranked };
}

async function matchWithEmbeddings(query, posts, limit) {
  const qvec = await embedText(query);
  if (!qvec) {
    return { mode: "none", results: posts.slice(0, limit).map((p) => ({ ...p, fitScore: 0 })) };
  }
  const vecs = await embedMany(posts.map((p) => p.text));
  const ranked = posts
    .map((p, i) => {
      const sim = vecs[i] ? Math.max(0, cosineSimilarity(qvec, vecs[i])) : 0;
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
