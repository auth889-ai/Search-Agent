/**
 * Local semantic embedding engine for FindE AI.
 *
 * Uses the all-MiniLM-L6-v2 sentence-transformer running fully on-device via
 * @xenova/transformers (ONNX). No API key, no network cost, deterministic output.
 * Produces 384-dim L2-normalized vectors, so cosine similarity == dot product.
 *
 * Everything degrades gracefully: if the model cannot load (e.g. offline first
 * run), embedText() returns null and the caller falls back to keyword search.
 */
import { pipeline, env } from "@xenova/transformers";

// Allow downloading the model from the Hugging Face hub on first run, then cache.
env.allowLocalModels = true;
env.useBrowserCache = false;

// Multilingual sentence-transformer (50+ languages incl. Bengali, Arabic, Hindi,
// Urdu, French...). Lets people search in ANY language and match posts written
// in another. Local, free, no API key. 384-dim (same ES mapping).
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIMS = 384;
export const MAX_EMBED_CHARS = 4000;

let extractorPromise = null;

function cleanForEmbedding(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EMBED_CHARS);
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", EMBEDDING_MODEL).catch(
      (error) => {
        // Reset so a later call can retry (e.g. network came back).
        extractorPromise = null;
        throw error;
      }
    );
  }
  return extractorPromise;
}

/**
 * Embed a single string into a 384-dim normalized vector.
 * Returns null on empty input or if the model is unavailable.
 */
export async function embedText(text) {
  const clean = cleanForEmbedding(text);
  if (!clean) return null;

  try {
    const extractor = await getExtractor();
    const output = await extractor(clean, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  } catch (error) {
    console.error(`[embedding] embedText failed: ${error.message}`);
    return null;
  }
}

/**
 * Embed many strings in a SINGLE batched model pass (much faster than looping).
 * Returns an array aligned with input (null where the text was empty/failed).
 */
export async function embedMany(texts = []) {
  const out = new Array(texts.length).fill(null);
  const keepIdx = [];
  const toEmbed = [];
  texts.forEach((t, i) => {
    const c = cleanForEmbedding(t);
    if (c) {
      keepIdx.push(i);
      toEmbed.push(c);
    }
  });
  if (!toEmbed.length) return out;

  try {
    const extractor = await getExtractor();
    const output = await extractor(toEmbed, { pooling: "mean", normalize: true });
    // Batched output is a [n, dims] tensor; tolist() -> array of vectors.
    const rows =
      typeof output.tolist === "function"
        ? output.tolist()
        : chunk(Array.from(output.data), EMBEDDING_DIMS);
    keepIdx.forEach((origIndex, k) => {
      if (rows[k]) out[origIndex] = rows[k];
    });
    return out;
  } catch (error) {
    console.error(`[embedding] embedMany failed: ${error.message}`);
    return out;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Attach an `embedding` field to a doc based on its embeddingText/title/text.
 * Mutates and returns the doc. Leaves embedding undefined if it cannot embed.
 */
export async function attachEmbedding(doc = {}) {
  const source =
    doc.embeddingText ||
    [doc.title, doc.text, doc.snippet].filter(Boolean).join("\n");

  const vector = await embedText(source);
  if (vector) doc.embedding = vector;
  return doc;
}

export async function attachEmbeddings(docs = []) {
  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    await attachEmbedding(doc);
  }
  return docs;
}

/** Cosine similarity for L2-normalized vectors (== dot product). */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

/** Warm the model and report whether embeddings are available. */
export async function embeddingsReady() {
  try {
    await getExtractor();
    return true;
  } catch {
    return false;
  }
}
