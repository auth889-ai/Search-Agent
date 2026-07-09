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
import { chat, llmEnabled } from "./llm.service.js";

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
  const seenSentences = new Set();
  for (const s of scored) {
    if (picked.length >= 3) break;
    // Skip near-duplicate sentences (e.g. title == first line of text).
    const norm = s.sentence.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seenSentences.has(norm)) continue;
    // Prefer covering different sources.
    if (usedDocs.has(s.docIdx) && picked.length < scored.length - 1) continue;
    seenSentences.add(norm);
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
    date: r.date,
    snippet: (r.snippet || r.text || "").slice(0, 220)
  }));

  const avgFit = Math.round(
    ranked.slice(0, 3).reduce((s, r) => s + (r.fitScore || 0), 0) /
      Math.min(3, ranked.length)
  );

  return { text: picked.join(" "), citations, confidence: avgFit };
}

/* -------- 4b. Optional LLM composer (grounded in retrieved sources) -------- */
async function composeWithLLM(query, ranked) {
  const sources = ranked
    .slice(0, 5)
    .map((r, i) => {
      const body = (r.snippet || r.text || "").slice(0, 400);
      const where = r.groupName || r.siteName || r.domain || r.sourceType;
      return `[${i + 1}] ${r.title}\n${body}\n(source: ${where}${r.date ? ", " + String(r.date).slice(0, 10) : ""})`;
    })
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content:
        "You are FindE AI, a careful research assistant. Answer the user's question using ONLY the numbered SOURCES provided. Cite every claim with [n] matching the source number. Do not invent facts, links, or dates. If the sources do not answer the question, say so plainly. Keep it 2-4 sentences, concrete and neutral."
    },
    {
      role: "user",
      content: `Question: ${query}\n\nSOURCES:\n${sources}\n\nWrite the grounded answer with [n] citations.`
    }
  ];

  return chat(messages, { temperature: 0.2, maxTokens: 500 });
}

// Extract 2-3 key points (salient sentences) with the citation they came from.
function buildKeyPoints(query, ranked) {
  const qTokens = new Set(tokenize(query));
  const scored = [];
  ranked.slice(0, 5).forEach((doc, idx) => {
    for (const sentence of splitSentences(`${doc.text || doc.snippet}`)) {
      const overlap = tokenize(sentence).filter((t) => qTokens.has(t)).length;
      if (overlap > 0) scored.push({ text: sentence, ref: idx + 1, score: overlap + (doc.fitScore || 0) / 100 });
    }
  });
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const points = [];
  for (const s of scored) {
    const key = s.text.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ text: s.text, ref: s.ref });
    if (points.length >= 3) break;
  }
  return points;
}

// Suggest Perplexity-style follow-up questions from intent + retrieved signals.
function buildFollowUps(intent, ranked) {
  const byIntent = {
    career: ["What are the application requirements?", "Is it paid or unpaid?", "What is the deadline?"],
    research: ["What dataset should I start with?", "What baseline models are recommended?", "How do I make it novel?"],
    scholarship: ["Am I eligible?", "What documents are required?", "When is the deadline?"],
    coding_help: ["What is the exact fix?", "What version does this affect?", "How do I reproduce it?"],
    general_search: ["Show only official sources", "Any beginner-friendly options?", "What are the deadlines?"]
  };
  const base = byIntent[intent] || byIntent.general_search;

  const dynamic = [];
  const hasDeadline = ranked.some((r) => r.deadline);
  const hasOfficial = ranked.some((r) => r.trustSignals?.sourceOfficial);
  if (hasDeadline && !base.some((q) => /deadline/i.test(q))) dynamic.push("Which ones have the nearest deadline?");
  if (hasOfficial) dynamic.push("Compare the official vs community sources");

  return [...base, ...dynamic].slice(0, 4);
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

  // 3b. When the cross-encoder ran, it is the most accurate relevance signal —
  // let it drive fitScore, ordering, and filtering out irrelevant results.
  const RELEVANCE_FLOOR = 6; // raw cross-encoder score below this = true junk
  const CONFIDENCE_FLOOR = 18; // blended top score below this = low-confidence
  if (neuralRerank) {
    // Cross-encoder scores are compressed; blend with absolute semantic so a
    // genuine-but-loose match still reads as helpful, while junk (low on BOTH)
    // stays low. Ordering/filtering still respects the cross-encoder.
    ranked.forEach((r) => {
      if (typeof r.rerankScore === "number") {
        const blended = Math.round(0.6 * r.rerankScore + 0.4 * (r.semanticFit ?? 0));
        r.fitScore = blended;
        if (r.explanation?.scoreBreakdown) {
          r.explanation.scoreBreakdown.rerank = r.rerankScore;
          r.explanation.scoreBreakdown.overall = blended;
        }
      }
    });
    ranked.sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0));
    const before = ranked.length;
    const filtered = ranked.filter((r) => (r.rerankScore ?? 0) >= RELEVANCE_FLOOR);
    ranked = filtered.length ? filtered : ranked.slice(0, 1);
    if (before !== ranked.length) {
      trace.push({
        agent: "EvidenceVerifier",
        action: "relevance_filter",
        detail: `Dropped ${before - ranked.length} result(s) below ${RELEVANCE_FLOOR}% cross-encoder relevance.`
      });
    }
  }

  const topFit = ranked[0]?.fitScore ?? 0;
  const topSem = ranked[0]?.semanticFit ?? 0;
  // Trust the cross-encoder when present; otherwise also require a real semantic
  // match so keyword-only noise can't masquerade as a confident answer.
  const lowConfidence = neuralRerank
    ? topFit < CONFIDENCE_FLOOR
    : topFit < CONFIDENCE_FLOOR || topSem < 20;

  // 4. COMPOSE grounded answer. If nothing is confidently relevant, say so
  // instead of stitching a misleading answer from weak matches.
  const answer = composeAnswer(normalized, ranked);
  let answerMode = "extractive";
  if (lowConfidence) {
    answer.text = `I couldn't find a confident match for "${normalized}" in the indexed sources (best fit ${topFit}%). The closest items are listed below, but they may not answer your question. Try indexing more relevant posts, switching the source, or turning on Web.`;
    answer.confidence = topFit;
    answerMode = "low_confidence";
    trace.push({
      agent: "AnswerComposer",
      action: "low_confidence",
      detail: `Top relevance ${topFit}% < ${CONFIDENCE_FLOOR}% — returned an honest "no confident match" answer.`
    });
  } else if (llmEnabled() && ranked.length) {
    const llm = await composeWithLLM(normalized, ranked);
    if (llm?.text) {
      answer.text = llm.text;
      answerMode = "llm_grounded";
      trace.push({
        agent: "AnswerComposer",
        action: "llm_compose",
        detail: `Grounded LLM answer via ${llm.provider} (${llm.model}).`
      });
    }
  }
  if (answerMode !== "low_confidence") {
    trace.push({
      agent: "AnswerComposer",
      action: "compose",
      detail: `${answerMode} answer from ${answer.citations.length} citation(s), ${answer.confidence}% confidence.`
    });
  }

  return {
    ok: true,
    query: normalized,
    intent: plan.intent,
    plan,
    answer: answer.text,
    answerMode,
    lowConfidence,
    confidence: answer.confidence,
    keyPoints: lowConfidence ? [] : buildKeyPoints(normalized, ranked),
    followUps: buildFollowUps(plan.intent, ranked),
    citations: answer.citations,
    nextActions: nextActions(plan.intent, ranked[0]),
    results: ranked,
    webAdded,
    neuralRerank,
    trace,
    tookMs: Date.now() - t0
  };
}
