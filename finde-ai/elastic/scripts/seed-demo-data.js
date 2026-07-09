import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Client } from "@elastic/elasticsearch";
import { attachEmbeddings } from "../../server/services/embedding.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.example") });

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const COMMUNITY_POSTS_INDEX = process.env.COMMUNITY_POSTS_INDEX || "finde_community_posts";
const WEB_SOURCES_INDEX = process.env.WEB_SOURCES_INDEX || "finde_web_sources";

const elastic = new Client({ node: ELASTICSEARCH_NODE });

function readSeedFile() {
  const seedPath = path.join(PROJECT_ROOT, "elastic", "seeds", "demo-documents.json");

  if (!fs.existsSync(seedPath)) {
    throw new Error(`Seed file missing: ${seedPath}`);
  }

  const raw = fs.readFileSync(seedPath, "utf8");
  return JSON.parse(raw);
}

function buildEmbeddingText(doc) {
  return [
    doc.title,
    doc.text,
    Array.isArray(doc.comments) ? doc.comments.join("\n") : "",
    Array.isArray(doc.topics) ? doc.topics.join(" ") : "",
    Array.isArray(doc.tags) ? doc.tags.join(" ") : "",
    doc.location,
    doc.groupName,
    doc.siteName
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeDoc(doc) {
  const trustScore = Number(doc.trustSignals?.trustScore ?? 0);
  const freshnessScore = Number(doc.trustSignals?.freshnessScore ?? 0);

  return {
    ...doc,
    indexedAt: new Date().toISOString(),
    embeddingText: buildEmbeddingText(doc),
    confidence: Number(doc.confidence ?? Math.round((trustScore + freshnessScore) * 50)),
    finalScore: Number(doc.finalScore ?? trustScore + freshnessScore)
  };
}

async function upsertMany(index, docs) {
  if (!Array.isArray(docs) || docs.length === 0) {
    console.log(`No docs for ${index}`);
    return;
  }

  const normalizedDocs = docs.map(normalizeDoc);

  // Add semantic vectors so seeded demo data is searchable by meaning.
  await attachEmbeddings(normalizedDocs);

  const operations = normalizedDocs.flatMap((normalized) => [
    {
      update: {
        _index: index,
        _id: normalized.docId
      }
    },
    {
      doc: normalized,
      doc_as_upsert: true
    }
  ]);

  const result = await elastic.bulk({
    refresh: true,
    operations
  });

  if (result.errors) {
    const failed = result.items.filter((item) => item.update?.error);
    console.error(JSON.stringify(failed.slice(0, 5), null, 2));
    throw new Error(`Failed to seed ${index}`);
  }

  console.log(`Upserted ${docs.length} docs into ${index}`);
}

async function count(index) {
  const result = await elastic.count({ index });
  return result.count;
}

async function main() {
  console.log("FindE AI seed starting...");
  console.log(`Elasticsearch node: ${ELASTICSEARCH_NODE}`);

  const info = await elastic.info();
  console.log(`Connected to Elasticsearch ${info.version?.number}`);

  const seed = readSeedFile();

  await upsertMany(COMMUNITY_POSTS_INDEX, seed.communityPosts || []);
  await upsertMany(WEB_SOURCES_INDEX, seed.webSources || []);

  console.log("Seed complete:");
  console.log({
    communityPosts: await count(COMMUNITY_POSTS_INDEX),
    webSources: await count(WEB_SOURCES_INDEX)
  });
}

main().catch((error) => {
  console.error("FindE AI seed failed.");
  console.error(error.message);
  process.exit(1);
});
