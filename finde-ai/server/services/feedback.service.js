/**
 * Interaction logging + lightweight personalization for FindE AI.
 *
 * Every click / save / dismiss is logged to its own ES index. This is the data
 * flywheel: the log is (a) the training set for future learning-to-rank,
 * (b) the source of the user profile vector used for personalization today,
 * (c) honest online metrics (CTR@k) later.
 *
 * Personalization (the "Glean trick", minimum viable version): the profile is
 * the weighted centroid of the embeddings of docs the user clicked (w=1) or
 * saved (w=2). At query time results semantically close to the profile get a
 * small fit nudge (max +/-4%) — taste breaks ties, relevance still decides.
 *
 * Everything degrades gracefully: no events yet / ES hiccup => null profile,
 * search behaves exactly as before.
 */
import { Client } from "@elastic/elasticsearch";
import { cosineSimilarity } from "./embedding.service.js";

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const elastic = new Client({ node: ELASTICSEARCH_NODE });

export const FEEDBACK_INDEX = process.env.FEEDBACK_INDEX || "finde_feedback";

const VALID_ACTIONS = new Set(["click", "save", "dismiss"]);
const ACTION_WEIGHT = { save: 2, click: 1 }; // dismiss logged but not in profile

let indexReady = false;

async function ensureIndex() {
  if (indexReady) return;
  const exists = await elastic.indices.exists({ index: FEEDBACK_INDEX });
  if (!exists) {
    await elastic.indices.create({
      index: FEEDBACK_INDEX,
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          action: { type: "keyword" },
          docId: { type: "keyword" },
          docIndex: { type: "keyword" },
          query: {
            type: "text",
            fields: { keyword: { type: "keyword", ignore_above: 256 } }
          },
          position: { type: "integer" },
          fitScore: { type: "integer" },
          ts: { type: "date" }
        }
      }
    });
  }
  indexReady = true;
}

/** Log one interaction event. Throws 400 on bad input. */
export async function logFeedback({ action, docId, docIndex, query, position, fitScore }) {
  const a = String(action || "").toLowerCase();
  if (!VALID_ACTIONS.has(a) || !docId) {
    const error = new Error("action (click|save|dismiss) and docId are required");
    error.status = 400;
    throw error;
  }
  await ensureIndex();
  await elastic.index({
    index: FEEDBACK_INDEX,
    document: {
      action: a,
      docId: String(docId),
      docIndex: String(docIndex || ""),
      query: String(query || "").slice(0, 300),
      position: Number.isFinite(Number(position)) ? Number(position) : null,
      fitScore: Number.isFinite(Number(fitScore)) ? Number(fitScore) : null,
      ts: new Date().toISOString()
    }
  });
  profileCache = { at: 0, vector: null }; // new signal -> recompute lazily
  return { ok: true };
}

/* -------- profile vector (cached) -------- */
const PROFILE_TTL_MS = 5 * 60 * 1000;
const MIN_EVENTS = 3;
let profileCache = { at: 0, vector: null };

/**
 * Weighted centroid of embeddings of recently clicked/saved docs.
 * Returns a normalized vector, or null (too little signal / any failure).
 */
export async function getProfileVector() {
  if (Date.now() - profileCache.at < PROFILE_TTL_MS) return profileCache.vector;

  let vector = null;
  try {
    await ensureIndex();
    const events = await elastic.search({
      index: FEEDBACK_INDEX,
      size: 200,
      sort: [{ ts: "desc" }],
      query: { terms: { action: ["click", "save"] } },
      _source: ["action", "docId", "docIndex"]
    });
    const hits = events.hits?.hits || [];
    if (hits.length >= MIN_EVENTS) {
      // Latest action per doc wins; fetch each doc's stored embedding.
      const byDoc = new Map();
      for (const h of hits) {
        const s = h._source;
        if (!byDoc.has(s.docId)) byDoc.set(s.docId, s);
      }
      const docs = [...byDoc.values()].slice(0, 60);
      const lookups = await Promise.allSettled(
        docs.map((d) =>
          elastic.search({
            index: d.docIndex || "finde_*",
            size: 1,
            query: { term: { docId: d.docId } },
            _source: ["embedding"]
          })
        )
      );
      let sum = null;
      let total = 0;
      lookups.forEach((res, i) => {
        if (res.status !== "fulfilled") return;
        const emb = res.value.hits?.hits?.[0]?._source?.embedding;
        if (!Array.isArray(emb)) return;
        const w = ACTION_WEIGHT[docs[i].action] || 1;
        if (!sum) sum = new Array(emb.length).fill(0);
        for (let k = 0; k < emb.length; k += 1) sum[k] += w * emb[k];
        total += w;
      });
      if (sum && total > 0) {
        let norm = 0;
        for (let k = 0; k < sum.length; k += 1) norm += sum[k] * sum[k];
        norm = Math.sqrt(norm) || 1;
        vector = sum.map((x) => x / norm);
      }
    }
  } catch {
    vector = null;
  }

  profileCache = { at: Date.now(), vector };
  return vector;
}

/**
 * Personal affinity of one result (0..1 around 0.5-neutral), or null.
 * Cosine of doc embedding vs profile, squashed so the nudge stays subtle.
 */
export function personalAffinity(profileVector, docEmbedding) {
  if (!Array.isArray(profileVector) || !Array.isArray(docEmbedding)) return null;
  const sim = cosineSimilarity(profileVector, docEmbedding);
  // E5-family cosines live around 0.72-0.92; center roughly mid-range.
  return Math.max(0, Math.min(1, (sim - 0.7) / 0.2));
}

/** Quick stats for /api/health-style introspection. */
export async function feedbackStats() {
  try {
    await ensureIndex();
    const res = await elastic.search({
      index: FEEDBACK_INDEX,
      size: 0,
      aggs: { byAction: { terms: { field: "action" } } }
    });
    const buckets = res.aggregations?.byAction?.buckets || [];
    return Object.fromEntries(buckets.map((b) => [b.key, b.doc_count]));
  } catch {
    return {};
  }
}
