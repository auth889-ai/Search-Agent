/**
 * FindE AI retrieval evaluation harness.
 *
 * "Elite" search is a NUMBER, not a feeling. This script ingests a
 * self-contained golden corpus (eval/golden.json) into separate eval indices,
 * runs every golden query through the REAL production pipeline (LLM query
 * understanding -> hybrid BM25+kNN -> RRF -> MMR), and reports:
 *
 *   hit@1     — the right post is the FIRST result
 *   hit@5     — the right post is in the top five
 *   MRR       — mean reciprocal rank of the first relevant result
 *   recall@5  — fraction of ALL relevant posts retrieved in the top 5
 *   recall@10 — same for top 10
 *   nDCG@10   — rank-discounted gain: rewards putting relevant posts HIGH,
 *               not just somewhere in the list
 *   latency   — average and p95 across queries
 *
 * Usage (from finde-ai/server):
 *   node eval/eval.js                  # full pipeline (uses LLM keys if set)
 *   node eval/eval.js --no-llm         # pure local pipeline (no query understanding)
 *   node eval/eval.js --keep           # keep the eval indices for inspection
 *   node eval/eval.js --save-baseline  # store this run as eval/baseline.json
 *
 * Run it after EVERY ranking change. If it prints red deltas vs the saved
 * baseline, the change hurt.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.example") });

// Point every service at throwaway eval indices BEFORE importing them.
process.env.COMMUNITY_POSTS_INDEX = "finde_eval_community";
process.env.WEB_SOURCES_INDEX = "finde_eval_web";
process.env.USER_KNOWLEDGE_INDEX = "finde_eval_saved";

const args = new Set(process.argv.slice(2));
if (args.has("--no-llm")) {
  // Pure LOCAL pipeline: no LLM query understanding AND no Cohere rerank, so
  // the run is deterministic (no external API variance in the baseline).
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.COHERE_API_KEY;
}

const { Client } = await import("@elastic/elasticsearch");
const { ingestCommunityPosts } = await import("../services/ingestion.service.js");
const { searchFindE } = await import("../services/search.service.js");

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const elastic = new Client({ node: ELASTICSEARCH_NODE });
const EVAL_INDEX = process.env.COMMUNITY_POSTS_INDEX;

// Same mapping as production community index (see elastic/scripts/create-indices.js).
const EVAL_MAPPING = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        finde_text_analyzer: {
          type: "custom",
          tokenizer: "standard",
          filter: ["lowercase", "asciifolding"]
        }
      }
    }
  },
  mappings: {
    dynamic: true,
    properties: {
      docId: { type: "keyword" },
      parentDocId: { type: "keyword" },
      isChunk: { type: "boolean" },
      sourceType: { type: "keyword" },
      title: {
        type: "text",
        analyzer: "finde_text_analyzer",
        fields: {
          keyword: { type: "keyword", ignore_above: 256 },
          bn: { type: "text", analyzer: "bengali" },
          en: { type: "text", analyzer: "english" }
        }
      },
      text: {
        type: "text",
        analyzer: "finde_text_analyzer",
        fields: {
          bn: { type: "text", analyzer: "bengali" },
          en: { type: "text", analyzer: "english" }
        }
      },
      snippet: { type: "text", analyzer: "finde_text_analyzer" },
      comments: { type: "text", analyzer: "finde_text_analyzer" },
      embeddingText: {
        type: "text",
        analyzer: "finde_text_analyzer",
        fields: {
          bn: { type: "text", analyzer: "bengali" },
          en: { type: "text", analyzer: "english" }
        }
      },
      url: { type: "keyword" },
      date: { type: "date", ignore_malformed: true },
      indexedAt: { type: "date" },
      language: { type: "keyword" },
      topics: { type: "keyword" },
      tags: { type: "keyword" },
      location: { type: "keyword" },
      groupName: { type: "keyword" },
      authorDisplay: { type: "keyword" },
      platform: { type: "keyword" },
      visibleCaptureOnly: { type: "boolean" },
      deadline: { type: "date", ignore_malformed: true },
      confidence: { type: "float" },
      finalScore: { type: "float" },
      trustSignals: {
        properties: {
          sourceOfficial: { type: "boolean" },
          hasOfficialLink: { type: "boolean" },
          hasDeadline: { type: "boolean" },
          commentCount: { type: "integer" },
          reactionCount: { type: "integer" },
          freshnessScore: { type: "float" },
          trustScore: { type: "float" }
        }
      },
      embedding: {
        type: "dense_vector",
        dims: 384,
        index: true,
        similarity: "cosine"
      }
    }
  }
};

async function setupIndex() {
  const exists = await elastic.indices.exists({ index: EVAL_INDEX });
  if (exists) await elastic.indices.delete({ index: EVAL_INDEX });
  await elastic.indices.create({ index: EVAL_INDEX, ...EVAL_MAPPING });
}

async function cleanup() {
  if (args.has("--keep")) {
    console.log(`\nKept eval index: ${EVAL_INDEX}`);
    return;
  }
  await elastic.indices.delete({ index: EVAL_INDEX }).catch(() => {});
}

function fmtPct(x) {
  return `${Math.round(x * 100)}%`;
}

/** Binary-relevance nDCG@k: gain 1 for each expected id, discounted by rank. */
function ndcgAtK(rankedIds, expectedIds, k) {
  const expected = new Set(expectedIds);
  let dcg = 0;
  rankedIds.slice(0, k).forEach((id, i) => {
    if (expected.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(expected.size, k); i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

function recallAtK(rankedIds, expectedIds, k) {
  if (!expectedIds.length) return 0;
  const top = new Set(rankedIds.slice(0, k));
  const found = expectedIds.filter((id) => top.has(id)).length;
  return found / expectedIds.length;
}

const BASELINE_PATH = path.join(__dirname, "baseline.json");

function compareToBaseline(metrics) {
  if (args.has("--save-baseline")) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(metrics, null, 2));
    console.log(`\nBaseline saved to eval/baseline.json`);
    return;
  }
  if (!fs.existsSync(BASELINE_PATH)) {
    console.log(`\nNo baseline yet — run with --save-baseline to store one.`);
    return;
  }
  const base = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  console.log("\nvs baseline:");
  let regressed = false;
  for (const key of ["hit1", "hit5", "mrr", "recall5", "recall10", "ndcg10"]) {
    if (typeof base[key] !== "number") continue;
    const delta = metrics[key] - base[key];
    const mark = delta < -0.001 ? "▼ REGRESSION" : delta > 0.001 ? "▲" : "=";
    if (delta < -0.001) regressed = true;
    console.log(`  ${key.padEnd(9)} ${base[key].toFixed(3)} -> ${metrics[key].toFixed(3)}  ${mark}`);
  }
  if (regressed) process.exitCode = 2;
}

async function main() {
  const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, "golden.json"), "utf8")
  );

  console.log(`Eval corpus: ${golden.posts.length} posts, ${golden.queries.length} queries`);
  console.log(`LLM query understanding: ${args.has("--no-llm") ? "OFF" : process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY ? "ON" : "OFF (no key)"}`);

  await setupIndex();
  const ingest = await ingestCommunityPosts({ posts: golden.posts, source: "eval_harness" });
  console.log(`Ingested: ${ingest.accepted} accepted, ${ingest.rejected} rejected, ${ingest.totalCommunityDocs} docs in index (incl. chunks)\n`);
  if (ingest.rejected > 0) console.log(ingest.rejectedItems);

  let hit1 = 0;
  let hit5 = 0;
  let mrrSum = 0;
  let recall5Sum = 0;
  let recall10Sum = 0;
  let ndcg10Sum = 0;
  const latencies = [];
  const rows = [];

  for (const q of golden.queries) {
    const t0 = Date.now();
    const res = await searchFindE({ query: q.query, sourceMode: "community", limit: 10 });
    const tookMs = Date.now() - t0;
    latencies.push(tookMs);

    const ids = res.results.map((r) => r.id);
    const firstRelevant = ids.findIndex((id) => q.expect.includes(id));
    const rank = firstRelevant === -1 ? null : firstRelevant + 1;

    if (rank === 1) hit1 += 1;
    if (rank !== null && rank <= 5) hit5 += 1;
    mrrSum += rank ? 1 / rank : 0;
    recall5Sum += recallAtK(ids, q.expect, 5);
    recall10Sum += recallAtK(ids, q.expect, 10);
    ndcg10Sum += ndcgAtK(ids, q.expect, 10);

    rows.push({
      id: q.id,
      rank: rank ?? "MISS",
      top: res.results[0] ? `${res.results[0].id} (${res.results[0].fitScore}%)` : "-",
      tookMs
    });
  }

  console.log("query                          rank   top result                              ms");
  console.log("-".repeat(88));
  for (const r of rows) {
    const flag = r.rank === 1 ? "  " : r.rank === "MISS" ? "✗ " : "~ ";
    console.log(
      `${flag}${r.id.padEnd(29)} ${String(r.rank).padEnd(6)} ${String(r.top).padEnd(39)} ${r.tookMs}`
    );
  }

  const n = golden.queries.length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const avgMs = Math.round(latencies.reduce((s, x) => s + x, 0) / n);
  const p95Ms = sorted[Math.min(n - 1, Math.floor(n * 0.95))];

  const metrics = {
    hit1: hit1 / n,
    hit5: hit5 / n,
    mrr: mrrSum / n,
    recall5: recall5Sum / n,
    recall10: recall10Sum / n,
    ndcg10: ndcg10Sum / n,
    avgMs,
    p95Ms,
    n
  };

  console.log("-".repeat(88));
  console.log(
    `hit@1: ${fmtPct(metrics.hit1)}   hit@5: ${fmtPct(metrics.hit5)}   MRR: ${metrics.mrr.toFixed(3)}   ` +
      `recall@5: ${fmtPct(metrics.recall5)}   recall@10: ${fmtPct(metrics.recall10)}   nDCG@10: ${metrics.ndcg10.toFixed(3)}`
  );
  console.log(`latency: avg ${avgMs}ms, p95 ${p95Ms}ms   (n=${n})`);

  compareToBaseline(metrics);

  await cleanup();
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("Eval failed:", error.message);
    await cleanup();
    process.exit(1);
  });
