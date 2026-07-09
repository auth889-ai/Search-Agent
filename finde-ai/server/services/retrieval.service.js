/**
 * Advanced retrieval engine for FindE AI.
 *
 * Implements the pipeline that production hybrid-search systems use, instead of
 * naively adding BM25 and vector scores:
 *
 *   1. Multi-query expansion  — search several phrasings, not just one.
 *   2. Per-query BM25 + kNN    — two ranked lists per phrasing.
 *   3. Weighted RRF fusion     — Reciprocal Rank Fusion (rank-based, needs no
 *                                score normalization; k=60 per the original paper).
 *   4. MMR diversification     — Maximal Marginal Relevance (lambda=0.7) to drop
 *                                near-duplicates and broaden coverage.
 *
 * References: RRF (Cormack et al.), Azure AI Search / Elastic hybrid ranking,
 * ARAGOG advanced-RAG evaluation. A cross-encoder rerank (Cohere) runs after
 * this as the final precision pass in the agent.
 */
import { Client } from "@elastic/elasticsearch";
import { embedMany, cosineSimilarity } from "./embedding.service.js";

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const elastic = new Client({ node: ELASTICSEARCH_NODE });

const RRF_K = Number(process.env.RRF_K || 60);
const MMR_LAMBDA = Number(process.env.MMR_LAMBDA || 0.7);
// Vector lists weighted slightly above lexical (semantic recall matters here).
const WEIGHT_KNN = 1.1;
const WEIGHT_BM25 = 1.0;

const BM25_FIELDS = [
  "title^5",
  "topics^4",
  "tags^3",
  "text^2",
  "comments^2",
  "snippet^2",
  "embeddingText^2",
  "groupName^1.5",
  "siteName^1.5",
  "domain"
];

/* -------- 1. Multi-query expansion -------- */
const INTENT_TERMS = {
  internship: "internship apply deadline paid remote onsite eligibility",
  career: "job hiring vacancy role apply requirements",
  research: "research dataset methodology baseline paper beginner guide",
  scholarship: "scholarship funding eligibility deadline documents official",
  coding_help: "error fix solution official docs stackoverflow github steps",
  general_search: ""
};

export function buildQueryVariants(query, intent) {
  const base = String(query || "").trim();
  const variants = [{ text: base, kind: "original" }];

  const extra = INTENT_TERMS[intent] || "";
  if (extra) variants.push({ text: `${base} ${extra}`, kind: "intent_expanded" });

  // A lexical-focused variant: keep only the content words (helps BM25 recall).
  const content = base
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (content.length >= 3) {
    variants.push({ text: content.join(" "), kind: "keywords" });
  }

  return variants.slice(0, 3);
}

/* -------- 2. Per-query search bodies -------- */
function bm25Search(text, indexes, size, filters) {
  return elastic.search({
    index: indexes,
    size,
    _source: { excludes: [] },
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query: text,
              type: "best_fields",
              fields: BM25_FIELDS,
              fuzziness: "AUTO",
              operator: "or"
            }
          }
        ],
        filter: filters
      }
    }
  });
}

function knnSearch(vector, indexes, size, filters) {
  return elastic.search({
    index: indexes,
    size,
    _source: { excludes: [] },
    knn: {
      field: "embedding",
      query_vector: vector,
      k: size,
      num_candidates: Math.max(80, size * 12),
      ...(filters.length ? { filter: { bool: { filter: filters } } } : {})
    }
  });
}

/* -------- 3. Weighted Reciprocal Rank Fusion -------- */
function rrfFuse(lists) {
  const agg = new Map();
  for (const list of lists) {
    list.hits.forEach((hit, rank) => {
      const contribution = list.weight * (1 / (RRF_K + rank + 1));
      const cur =
        agg.get(hit.id) || {
          id: hit.id,
          index: hit.index,
          source: hit.source,
          rrf: 0,
          hitBy: new Set()
        };
      cur.rrf += contribution;
      cur.hitBy.add(list.kind);
      // Prefer a copy of the source that carries the embedding (for MMR).
      if (!Array.isArray(cur.source?.embedding) && Array.isArray(hit.source?.embedding)) {
        cur.source = hit.source;
      }
      agg.set(hit.id, cur);
    });
  }
  return [...agg.values()].sort((a, b) => b.rrf - a.rrf);
}

/* -------- 4. Maximal Marginal Relevance diversification -------- */
function mmr(candidates, queryVector, limit) {
  if (!queryVector || candidates.length <= 1) return candidates.slice(0, limit);

  const pool = candidates.slice(0, Math.max(limit * 2, 20));
  pool.forEach((d) => {
    d.relevance = Array.isArray(d.source?.embedding)
      ? cosineSimilarity(queryVector, d.source.embedding)
      : 0;
  });

  const selected = [];
  while (selected.length < limit && pool.length) {
    let best = null;
    let bestScore = -Infinity;
    let bestIdx = -1;
    pool.forEach((d, i) => {
      let maxSim = 0;
      for (const s of selected) {
        if (Array.isArray(d.source?.embedding) && Array.isArray(s.source?.embedding)) {
          maxSim = Math.max(maxSim, cosineSimilarity(d.source.embedding, s.source.embedding));
        }
      }
      const score = MMR_LAMBDA * d.relevance - (1 - MMR_LAMBDA) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        best = d;
        bestIdx = i;
      }
    });
    selected.push(best);
    pool.splice(bestIdx, 1);
  }
  return selected;
}

/* -------- Orchestrator -------- */
export async function advancedRetrieve({ query, indexes, size, filters = [], intent }) {
  const variants = buildQueryVariants(query, intent);
  const vectors = await embedMany(variants.map((v) => v.text));
  const queryVector = vectors[0];

  // Fire BM25 for every variant, kNN for every variant that embedded.
  const jobs = [];
  variants.forEach((v, i) => {
    jobs.push({ kind: `bm25:${v.kind}`, weight: WEIGHT_BM25, run: bm25Search(v.text, indexes, size * 2, filters) });
    if (vectors[i]) {
      jobs.push({ kind: `knn:${v.kind}`, weight: WEIGHT_KNN, run: knnSearch(vectors[i], indexes, size * 2, filters) });
    }
  });

  const settled = await Promise.allSettled(jobs.map((j) => j.run));
  const lists = settled
    .map((res, i) =>
      res.status === "fulfilled"
        ? {
            kind: jobs[i].kind,
            weight: jobs[i].weight,
            hits: (res.value.hits?.hits || []).map((h) => ({
              id: h._id,
              index: h._index,
              source: h._source
            }))
          }
        : null
    )
    .filter(Boolean);

  const fused = rrfFuse(lists);
  const rrfMax = fused.length ? fused[0].rrf : 0;
  const rrfMin = fused.length ? fused[fused.length - 1].rrf : 0;
  const diversified = mmr(fused, queryVector, size);

  return {
    queryVector,
    candidates: diversified,
    plan: {
      variants: variants.map((v) => v.kind),
      lists: lists.map((l) => l.kind),
      fusion: `weighted_rrf(k=${RRF_K})`,
      diversify: `mmr(lambda=${MMR_LAMBDA})`,
      rrfMin,
      rrfMax
    }
  };
}
