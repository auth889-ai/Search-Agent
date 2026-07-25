/**
 * LLM query understanding for FindE AI.
 *
 * The old pipeline expanded queries with hardcoded ENGLISH keyword lists, so a
 * Bengali (or any non-English) query got zero useful expansion and BM25 could
 * never match posts written in the other language. This service asks the LLM
 * (Groq/OpenRouter, already configured) to:
 *
 *   - translate the query to English AND Bengali (the two corpus languages),
 *   - rewrite it as a keyword-style search phrasing,
 *   - detect intent.
 *
 * Results are cached in-memory per query. Fully optional: with no LLM key or
 * on any error/timeout it returns null and retrieval falls back to the old
 * heuristic expansion, so search never breaks or gets slower than ~3.5s extra
 * on the FIRST time a query is seen.
 */
import { chat, llmEnabled } from "./llm.service.js";

const CACHE_MAX = 500;
const cache = new Map(); // normalized query -> understanding | null

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

const VALID_INTENTS = new Set([
  "internship",
  "job",
  "research_idea",
  "scholarship",
  "coding_help",
  "rent_local",
  "general_search"
]);

function sanitize(query, json) {
  if (!json || typeof json !== "object") return null;

  const clean = (v) =>
    String(v || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);

  const out = {
    intent: VALID_INTENTS.has(json.intent) ? json.intent : null,
    language: clean(json.language).slice(0, 8) || null,
    english: clean(json.english),
    bengali: clean(json.bengali),
    keywords: clean(json.keywords),
    // Compound queries ("scholarships in Germany AND how to write the SOP")
    // decompose into independently-retrievable sub-queries; each becomes its
    // own BM25+kNN retrieval leg in the fusion.
    subQueries: Array.isArray(json.subQueries)
      ? json.subQueries.map(clean).filter(Boolean).slice(0, 2)
      : []
  };

  // Drop variants that add nothing over the original query.
  const base = query.toLowerCase();
  for (const key of ["english", "bengali", "keywords"]) {
    if (out[key] && out[key].toLowerCase() === base) out[key] = "";
  }
  out.subQueries = out.subQueries.filter((s) => s.toLowerCase() !== base);

  if (!out.english && !out.bengali && !out.keywords && !out.intent && !out.subQueries.length) return null;
  return out;
}

/**
 * Understand a query: translation variants + keyword rewrite + intent.
 * Returns { intent, language, english, bengali, keywords } or null.
 */
export async function understandQuery(query) {
  const q = String(query || "").replace(/\s+/g, " ").trim();
  if (!q || !llmEnabled()) return null;

  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const messages = [
    {
      role: "system",
      content:
        'You are a multilingual search-query analyst for a community post search engine (posts are written mostly in English and Bengali/Banglish). Analyze the user query and return ONLY strict JSON, no prose:\n' +
        '{"language":"<ISO code of query language>","intent":"<one of: internship, job, research_idea, scholarship, coding_help, rent_local, general_search>","english":"<natural English translation of the query>","bengali":"<natural Bengali translation of the query>","keywords":"<5-10 space-separated search keywords in English capturing the core need, including obvious synonyms>","subQueries":["<ONLY if the query asks for two or more separable things: each independently searchable sub-question, in the query language; otherwise empty array>"]}'
    },
    { role: "user", content: q }
  ];

  let result = null;
  try {
    const res = await chat(messages, {
      temperature: 0,
      maxTokens: 300,
      timeoutMs: Number(process.env.QUERY_LLM_TIMEOUT_MS || 3500)
    });
    result = sanitize(q, extractJson(res?.text));
  } catch {
    result = null;
  }

  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, result);
  return result;
}
