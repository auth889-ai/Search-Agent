/**
 * Neural re-ranking via Cohere Rerank (cross-encoder).
 *
 * A bi-encoder (our local embedding kNN) is great for recall; a cross-encoder
 * re-scores the shortlist by reading query + document together, which orders
 * the top results much more accurately.
 *
 * Node-native (REST) — no pip/Python, no SDK dependency. Fully optional:
 * without COHERE_API_KEY it is a no-op that returns the input unchanged, so the
 * agent keeps working on the free local ranking.
 */
const COHERE_URL = "https://api.cohere.com/v2/rerank";

export function rerankerEnabled() {
  return Boolean(process.env.COHERE_API_KEY);
}

function docToText(doc) {
  return [
    doc.title,
    doc.snippet || (doc.text || "").slice(0, 500),
    Array.isArray(doc.topics) ? doc.topics.join(" ") : ""
  ]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 1200);
}

/**
 * Re-rank docs against the query. Returns { reranked, used, error }.
 * `reranked` docs gain a `rerankScore` (0-100) when Cohere is used.
 */
export async function rerankResults(query, docs, { topN } = {}) {
  const key = process.env.COHERE_API_KEY;
  if (!key || !Array.isArray(docs) || docs.length < 2) {
    return { reranked: docs, used: false };
  }

  const model = process.env.COHERE_RERANK_MODEL || "rerank-v3.5";
  const documents = docs.map(docToText);

  try {
    const res = await fetch(COHERE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        top_n: Math.min(topN || docs.length, docs.length)
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Cohere rerank ${res.status}: ${body.slice(0, 160)}`);
    }

    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return { reranked: docs, used: false };

    const reranked = results
      .filter((r) => docs[r.index])
      .map((r) => ({
        ...docs[r.index],
        rerankScore: Math.round((r.relevance_score ?? 0) * 100)
      }));

    return { reranked, used: true };
  } catch (error) {
    // Never break search because a re-rank call failed — degrade to input order.
    return { reranked: docs, used: false, error: error.message };
  }
}
