/**
 * FindE AI agent orchestrator.
 *
 * Implements the "Agent Team" from the architecture: a deterministic, tool-using
 * pipeline that plans a query, routes to sources, retrieves evidence with hybrid
 * semantic+keyword search, verifies/re-ranks it, and composes a grounded answer
 * with citations — every step recorded as a visible trace.
 *
 * It is intentionally LLM-free so it is free, fast, private and deterministic.
 * The `compose` step is extractive (pulls the best evidence sentences). A hosted
 * LLM (Gemini/Groq/OpenRouter) can be dropped into composeAnswer() later without
 * changing the pipeline shape.
 */
import { searchFindE } from "./search.service.js";
import { searchWebWithProvider } from "./webProviders.service.js";
import { rerankResults, rerankerEnabled } from "./rerank.service.js";

const STOPWORDS = new Set([
  "the", "a", "an", "for", "and", "or", "to", "of", "in", "on", "with", "how",
  "what", "which", "is", "are", "my", "i", "me", "can", "do", "does", "from",
  "at", "by", "as", "be", "this", "that", "it", "you", "your", "we"
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/* -------- 1. PLANNER: understand the ask and expand it -------- */
function planQuery(query, sourceMode) {
  const tokens = tokenize(query);
  const q = query.toLowerCase();

  let intent = "general_search";
  if (/(internship|intern|hiring|vacancy|job|career)/.test(q)) intent = "career";
  else if (/(research|thesis|fyp|dataset|paper|idea)/.test(q)) intent = "research";
  else if (/(scholarship|funding|masters|phd|stipend)/.test(q)) intent = "scholarship";
  else if (/(error|bug|fix|connection|exception|api|install)/.test(q)) intent = "coding_help";

  return {
    intent,
    keyTerms: tokens.slice(0, 8),
    plannedSources:
      sourceMode === "all" ? ["community", "web", "saved"] : [sourceMode],
    note: `Detected intent "${intent}". Will retrieve with hybrid semantic + keyword ranking.`
  };
}

/* -------- 3. VERIFIER: dedupe, drop weak evidence, re-rank -------- */
function verifyAndRerank(results, minFit) {
  const seen = new Set();
  const kept = [];
  for (const r of results) {
    const key = (r.url || r.title || "").toLowerCase().slice(0, 120);
    if (key && seen.has(key)) continue;
    seen.add(key);
    if ((r.fitScore ?? 0) < minFit) continue;
    kept.push(r);
  }
  // Re-rank: fit first, then trust, then official/deadline signals.
  return kept.sort((a, b) => {
    const fa = a.fitScore * 0.7 + (a.confidence || 0) * 0.3;
    const fb = b.fitScore * 0.7 + (b.confidence || 0) * 0.3;
    return fb - fa;
  });
}

/* -------- 4. COMPOSER: extractive grounded answer with citations -------- */
function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
}

function composeAnswer(query, ranked) {
  if (!ranked.length) {
    return {
      text: `No confident evidence found for "${query}". Try indexing more visible posts or enabling web search.`,
      citations: [],
      confidence: 0
    };
  }

  const qTokens = new Set(tokenize(query));
  const scored = [];
  ranked.slice(0, 5).forEach((doc, docIdx) => {
    const sentences = splitSentences(`${doc.title}. ${doc.text || doc.snippet}`);
    for (const sentence of sentences) {
      const sTokens = tokenize(sentence);
      const overlap = sTokens.filter((t) => qTokens.has(t)).length;
      const score = overlap * 2 + (doc.fitScore || 0) / 100;
      if (overlap > 0) scored.push({ sentence, score, docIdx });
    }
  });

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  const usedDocs = new Set();
  for (const s of scored) {
    if (picked.length >= 3) break;
    // Prefer covering different sources.
    if (usedDocs.has(s.docIdx) && picked.length < scored.length - 1) continue;
    usedDocs.add(s.docIdx);
    picked.push(`${s.sentence} [${s.docIdx + 1}]`);
  }
  if (!picked.length) picked.push(`${ranked[0].title} [1]`);

  const citations = ranked.slice(0, 5).map((r, i) => ({
    ref: i + 1,
    title: r.title,
    url: r.url || "",
    source: r.groupName || r.siteName || r.domain || r.sourceType,
    fitScore: r.fitScore,
    date: r.date
  }));

  const avgFit = Math.round(
    ranked.slice(0, 3).reduce((s, r) => s + (r.fitScore || 0), 0) /
      Math.min(3, ranked.length)
  );

  return { text: picked.join(" "), citations, confidence: avgFit };
}

function nextActions(intent, top) {
  const actions = [];
  if (top?.url) actions.push("Open the top-cited source and verify details.");
  if (top?.deadline) actions.push(`Note the deadline: ${String(top.deadline).slice(0, 10)}.`);
  const byIntent = {
    career: "Prepare your CV / portfolio before applying.",
    research: "Check the dataset licence and reproduce a baseline first.",
    scholarship: "Confirm eligibility and required documents on the official site.",
    coding_help: "Reproduce the error locally and check the exact version.",
    general_search: "Refine the query with a location, date, or skill to narrow results."
  };
  actions.push(byIntent[intent] || byIntent.general_search);
  return actions;
}

/* -------- ORCHESTRATOR -------- */
export async function runAgent({
  query,
  sourceMode = "all",
  limit = 8,
  useWeb = false,
  minFit = 20
}) {
  const normalized = String(query || "").trim();
  if (!normalized) {
    const error = new Error("query is required");
    error.status = 400;
    throw error;
  }

  const trace = [];
  const t0 = Date.now();

  // 1. PLAN
  const plan = planQuery(normalized, sourceMode);
  trace.push({ agent: "IntentPlanner", action: "plan", detail: plan.note });

  // 2. RETRIEVE (hybrid semantic + keyword over Elasticsearch)
  const searchResult = await searchFindE({
    query: normalized,
    sourceMode,
    limit: Math.max(limit, 8)
  });
  trace.push({
    agent: "RetrievalAgent",
    action: "hybrid_search",
    detail: `${searchResult.count} candidate(s) via ${searchResult.searchMode}`
  });

  // 2b. Optional live web expansion when community evidence is thin.
  let webAdded = 0;
  const strongEnough = searchResult.results.filter((r) => (r.fitScore ?? 0) >= 45);
  if (useWeb && strongEnough.length < 3) {
    try {
      const web = await searchWebWithProvider({
        query: normalized,
        limit: 5,
        cache: true
      });
      webAdded = web.count || 0;
      trace.push({
        agent: "SourceRouter",
        action: "web_expand",
        detail: `Fetched ${webAdded} fresh web source(s) via ${web.provider} and cached them.`
      });
      // Re-run search so freshly cached web docs are included + embedded-ranked.
      if (webAdded > 0) {
        const rerun = await searchFindE({ query: normalized, sourceMode, limit: Math.max(limit, 8) });
        searchResult.results = rerun.results;
        searchResult.count = rerun.count;
      }
    } catch (error) {
      trace.push({ agent: "SourceRouter", action: "web_expand_failed", detail: error.message });
    }
  }

  // 3. VERIFY + RE-RANK (local heuristic first, then optional neural rerank)
  let ranked = verifyAndRerank(searchResult.results, minFit).slice(0, limit);
  trace.push({
    agent: "EvidenceVerifier",
    action: "rerank",
    detail: `Kept ${ranked.length} verified result(s) (fit >= ${minFit}).`
  });

  let neuralRerank = false;
  if (rerankerEnabled() && ranked.length >= 2) {
    const { reranked, used, error } = await rerankResults(normalized, ranked, { topN: limit });
    if (used) {
      ranked = reranked;
      neuralRerank = true;
      trace.push({
        agent: "EvidenceVerifier",
        action: "neural_rerank",
        detail: `Cohere cross-encoder reordered the top ${ranked.length} result(s).`
      });
    } else if (error) {
      trace.push({ agent: "EvidenceVerifier", action: "neural_rerank_skipped", detail: error });
    }
  }

  // 4. COMPOSE grounded answer
  const answer = composeAnswer(normalized, ranked);
  trace.push({
    agent: "AnswerComposer",
    action: "compose",
    detail: `Grounded answer from ${answer.citations.length} citation(s), ${answer.confidence}% confidence.`
  });

  return {
    ok: true,
    query: normalized,
    intent: plan.intent,
    plan,
    answer: answer.text,
    confidence: answer.confidence,
    citations: answer.citations,
    nextActions: nextActions(plan.intent, ranked[0]),
    results: ranked,
    webAdded,
    neuralRerank,
    trace,
    tookMs: Date.now() - t0
  };
}
