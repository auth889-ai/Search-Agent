/**
 * LLM structured extraction at ingest.
 *
 * The regex extractors only understand English ("deadline: July 30"), so
 * Bengali posts ("আবেদনের শেষ তারিখ ৩০ জুলাই") contributed nothing to filters
 * or trust signals. One cheap batched LLM call per ingest extracts structured
 * fields from posts in ANY language:
 *
 *   deadline, location, salary, isPaid, workMode, applyUrl, category
 *
 * These make "only paid, remote, deadline not passed" filters real. Fully
 * optional: without an LLM key (or on error/timeout) docs keep their
 * heuristic fields — ingestion never blocks on enrichment quality.
 */
import { chat, llmEnabled } from "./llm.service.js";

const BATCH_SIZE = 10;
const POST_CHARS = 800;

const CATEGORIES = new Set([
  "internship",
  "job",
  "scholarship",
  "research",
  "rent",
  "coding_help",
  "event",
  "admission",
  "visa",
  "other"
]);
const WORK_MODES = new Set(["remote", "onsite", "hybrid"]);

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

function cleanStr(value, max = 200) {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  return v && v.toLowerCase() !== "null" ? v.slice(0, max) : "";
}

function parseIsoDay(value) {
  const v = cleanStr(value, 40);
  if (!v) return null;
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function safeHttpUrl(value) {
  const v = cleanStr(value, 500);
  if (!v) return "";
  try {
    const parsed = new URL(v);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

async function extractBatch(docs, offset) {
  const numbered = docs
    .map((d, i) => `[${offset + i}] ${String(d.text || "").replace(/\s+/g, " ").slice(0, POST_CHARS)}`)
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content:
        'You are a precise information-extraction engine for community posts written in ANY language (English, Bengali, Banglish, ...). For EACH numbered post, extract ONLY facts explicitly stated in the post; use null when not stated or unsure. Convert relative or local-language dates to ISO YYYY-MM-DD. Return ONLY strict JSON, no prose:\n' +
        '{"results":[{"index":<int>,"deadline":"YYYY-MM-DD"|null,"location":"city or country, in English"|null,"salary":"amount as written"|null,"isPaid":true|false|null,"workMode":"remote"|"onsite"|"hybrid"|null,"applyUrl":"http..."|null,"category":"internship"|"job"|"scholarship"|"research"|"rent"|"coding_help"|"event"|"admission"|"visa"|"other"}]}'
    },
    {
      role: "user",
      content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nPOSTS:\n${numbered}`
    }
  ];

  const res = await chat(messages, {
    temperature: 0,
    maxTokens: 1200,
    timeoutMs: Number(process.env.ENRICH_LLM_TIMEOUT_MS || 9000)
  });
  const json = extractJson(res?.text);
  return Array.isArray(json?.results) ? json.results : null;
}

function applyExtraction(doc, ex) {
  const enriched = { fields: {}, tags: [] };

  const deadline = parseIsoDay(ex.deadline);
  if (deadline && !doc.deadline) enriched.fields.deadline = deadline;

  const location = cleanStr(ex.location, 60);
  if (location && !doc.location) enriched.fields.location = location;

  const salary = cleanStr(ex.salary, 80);
  if (salary) enriched.fields.salary = salary;

  if (typeof ex.isPaid === "boolean") {
    enriched.fields.isPaid = ex.isPaid;
    if (ex.isPaid) enriched.tags.push("paid");
  }

  const workMode = cleanStr(ex.workMode, 12).toLowerCase();
  if (WORK_MODES.has(workMode)) {
    enriched.fields.workMode = workMode;
    if (workMode === "remote") enriched.tags.push("remote");
  }

  const applyUrl = safeHttpUrl(ex.applyUrl);
  if (applyUrl) enriched.fields.applyUrl = applyUrl;

  const category = cleanStr(ex.category, 20).toLowerCase();
  if (CATEGORIES.has(category) && category !== "other") enriched.tags.push(category);

  return enriched;
}

/**
 * Enrich normalized docs IN PLACE with LLM-extracted structured fields.
 * Returns the number of docs that gained at least one field.
 */
export async function enrichDocs(docs = []) {
  if (!llmEnabled() || !docs.length) return 0;
  if (process.env.INGEST_ENRICH === "false") return 0;

  const batches = [];
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    batches.push({ offset: i, docs: docs.slice(i, i + BATCH_SIZE) });
  }

  const settled = await Promise.allSettled(
    batches.map((b) => extractBatch(b.docs, b.offset))
  );

  let enrichedCount = 0;
  settled.forEach((s) => {
    if (s.status !== "fulfilled" || !s.value) return;
    for (const ex of s.value) {
      const doc = docs[ex?.index];
      if (!doc) continue;
      const { fields, tags } = applyExtraction(doc, ex);
      if (!Object.keys(fields).length && !tags.length) continue;

      Object.assign(doc, fields);
      if (fields.deadline) {
        doc.trustSignals = doc.trustSignals || {};
        doc.trustSignals.hasDeadline = true;
        doc.trustSignals.trustScore = Math.min(
          0.98,
          Number(((doc.trustSignals.trustScore || 0.45) + 0.12).toFixed(2))
        );
        tags.push("deadline");
      }
      doc.tags = Array.from(new Set([...(doc.tags || []), ...tags]));
      doc.enrichedByLLM = true;
      enrichedCount += 1;
    }
  });

  return enrichedCount;
}
