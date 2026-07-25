/**
 * Re-embed every document in place with the current embedding model.
 * Run this after changing EMBEDDING_MODEL so stored vectors match new queries.
 *
 *   node scripts/reembed.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Client } from "@elastic/elasticsearch";
import { embedMany, EMBEDDING_MODEL } from "../../server/services/embedding.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.example") });

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const INDEXES = [
  process.env.COMMUNITY_POSTS_INDEX || "finde_community_posts",
  process.env.WEB_SOURCES_INDEX || "finde_web_sources",
  process.env.USER_KNOWLEDGE_INDEX || "finde_user_knowledge"
];

const elastic = new Client({ node: ELASTICSEARCH_NODE });

function embeddingSource(doc) {
  return (
    doc.embeddingText ||
    [doc.title, doc.text, doc.snippet].filter(Boolean).join("\n")
  );
}

const PAGE_SIZE = 200;

async function reembedBatch(index, hits) {
  const vectors = await embedMany(
    hits.map((h) => embeddingSource(h._source)),
    "passage"
  );
  const operations = [];
  hits.forEach((h, i) => {
    if (!vectors[i]) return;
    operations.push({ update: { _index: index, _id: h._id } });
    operations.push({ doc: { embedding: vectors[i] } });
  });
  if (!operations.length) return 0;

  const result = await elastic.bulk({ refresh: false, operations });
  if (result.errors) {
    const failed = result.items.filter((it) => it.update?.error);
    console.error(JSON.stringify(failed.slice(0, 3), null, 2));
    throw new Error(`re-embed failed for ${index}`);
  }
  return operations.length / 2;
}

async function reembedIndex(index) {
  const exists = await elastic.indices.exists({ index });
  if (!exists) {
    console.log(`skip (missing): ${index}`);
    return;
  }

  // Paginate with search_after so EVERY doc gets a fresh vector — a fixed
  // size:1000 fetch would silently leave older docs with stale embeddings
  // once the corpus grows, quietly breaking kNN for them.
  let total = 0;
  let searchAfter = null;
  for (;;) {
    const res = await elastic.search({
      index,
      size: PAGE_SIZE,
      _source: { excludes: ["embedding"] },
      query: { match_all: {} },
      sort: [{ _doc: "asc" }],
      ...(searchAfter ? { search_after: searchAfter } : {})
    });
    const hits = res.hits?.hits || [];
    if (!hits.length) break;

    total += await reembedBatch(index, hits);
    process.stdout.write(`\r${index}: re-embedded ${total} docs...`);
    searchAfter = hits[hits.length - 1].sort;
    if (hits.length < PAGE_SIZE) break;
  }

  await elastic.indices.refresh({ index });
  console.log(`\r${index}: re-embedded ${total} docs      `);
}

async function main() {
  console.log(`Re-embedding with model: ${EMBEDDING_MODEL}`);
  for (const index of INDEXES) {
    // eslint-disable-next-line no-await-in-loop
    await reembedIndex(index);
  }
  console.log("Re-embed complete.");
}

main().catch((error) => {
  console.error("Re-embed failed:", error.message);
  process.exit(1);
});
