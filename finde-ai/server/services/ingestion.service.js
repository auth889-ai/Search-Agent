import crypto from "crypto";
import { Client } from "@elastic/elasticsearch";
import { attachEmbeddings, cosineSimilarity } from "./embedding.service.js";
import { enrichDocs } from "./enrichment.service.js";

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const COMMUNITY_POSTS_INDEX = process.env.COMMUNITY_POSTS_INDEX || "finde_community_posts";

const elastic = new Client({ node: ELASTICSEARCH_NODE });

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeNoiseLines(text) {
  const noise = [
    /^like$/i,
    /^comment$/i,
    /^share$/i,
    /^see more$/i,
    /^reply$/i,
    /^view more comments$/i,
    /^\d+\s*(likes?|comments?|shares?)$/i
  ];

  return cleanText(text)
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => !noise.some((pattern) => pattern.test(line)))
    .join("\n");
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeUrl(value) {
  const raw = cleanText(value);
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function parseDate(value) {
  const raw = cleanText(value);
  if (!raw) return null;

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

function detectLanguage(text) {
  if (/[\u0980-\u09FF]/.test(text)) return "bn";
  if (/[a-zA-Z]/.test(text)) return "en";
  return "unknown";
}

function extractDeadline(text) {
  const source = cleanText(text);

  const patterns = [
    /\bdeadline[:\s-]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /\bdeadline[:\s-]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /\blast date[:\s-]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /\bapply by[:\s-]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      const parsed = parseDate(match[1]);
      if (parsed) return parsed;
    }
  }

  return null;
}

function detectLocation(text) {
  const q = text.toLowerCase();
  const locations = [
    "Bangladesh",
    "Dhaka",
    "Chittagong",
    "Sylhet",
    "Remote",
    "USA",
    "Canada",
    "UK",
    "Germany",
    "Australia"
  ];

  for (const location of locations) {
    if (q.includes(location.toLowerCase())) return location;
  }

  return "";
}

function detectTopics(text) {
  const q = text.toLowerCase();
  const topics = new Set();

  const map = {
    internship: ["internship", "intern", "career", "apply"],
    job: ["job", "hiring", "vacancy", "recruitment", "job circular"],
    research: ["research", "paper", "dataset", "thesis", "fyp", "final year project", "methodology"],
    scholarship: ["scholarship", "funding", "tuition", "stipend", "masters", "phd"],
    admission: ["admission", "university", "semester", "intake"],
    visa: ["visa", "interview", "embassy", "appointment"],
    rent: ["rent", "room", "roommate", "flat", "sublet", "hostel"],
    coding_error: ["error", "bug", "exception", "mongodb", "node", "react", "python", "api"],
    remote: ["remote", "work from home", "online"]
  };

  for (const [topic, keywords] of Object.entries(map)) {
    if (keywords.some((keyword) => q.includes(keyword))) topics.add(topic);
  }

  return Array.from(topics);
}

function extractSkills(text) {
  const q = text.toLowerCase();
  return [
    "react",
    "node",
    "javascript",
    "typescript",
    "python",
    "java",
    "c++",
    "mongodb",
    "sql",
    "docker",
    "aws",
    "gcp",
    "machine learning",
    "ai",
    "cybersecurity",
    "html",
    "css",
    "git"
  ].filter((skill) => q.includes(skill));
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return [];

  const seen = new Set();
  const cleaned = [];

  for (const comment of comments) {
    const value = removeNoiseLines(comment);
    const key = value.toLowerCase();

    if (value.length >= 3 && !seen.has(key)) {
      seen.add(key);
      cleaned.push(value);
    }
  }

  return cleaned.slice(0, 30);
}

// Exponential decay with a ~45-day half-feel: today ~1.0, 1 week ~0.87,
// 1 month ~0.56, 3 months ~0.22, floor 0.15. Only meaningful when the date is
// the REAL post date (extension timestamp), not the capture time.
function computeFreshness(dateIso, dateIsReal) {
  if (!dateIsReal) return 0.6; // unknown real age -> neutral, not "fresh"
  const ageMs = Date.now() - new Date(dateIso).getTime();
  if (Number.isNaN(ageMs)) return 0.6;
  const ageDays = Math.max(0, ageMs / 86400000);
  return Number((0.15 + 0.85 * Math.exp(-ageDays / 45)).toFixed(2));
}

function computeTrustSignals({ text, comments, url, deadline, date, dateIsReal }) {
  const q = text.toLowerCase();
  const commentCount = comments.length;

  const hasOfficialLink =
    Boolean(url) &&
    /(edu|gov|careers|jobs|scholarship|admission|docs|developer|github|stackoverflow)/i.test(url);

  const sourceOfficial =
    hasOfficialLink ||
    q.includes("official") ||
    q.includes("verified");

  const hasProofSnippet =
    q.includes("deadline") ||
    q.includes("apply") ||
    q.includes("eligibility") ||
    q.includes("requirements") ||
    q.includes("dataset") ||
    q.includes("solution") ||
    q.includes("experience");

  let trustScore = 0.45;
  if (sourceOfficial) trustScore += 0.18;
  if (hasOfficialLink) trustScore += 0.14;
  if (deadline) trustScore += 0.12;
  if (hasProofSnippet) trustScore += 0.08;
  if (commentCount > 0) trustScore += Math.min(0.12, commentCount * 0.03);
  if (q.length > 250) trustScore += 0.06;
  if (q.length < 40) trustScore -= 0.18;
  if (/fake|scam|spam/i.test(q)) trustScore -= 0.15;

  trustScore = Math.max(0.05, Math.min(0.98, trustScore));

  return {
    sourceOfficial,
    hasOfficialLink,
    hasDeadline: Boolean(deadline),
    commentCount,
    reactionCount: 0,
    freshnessScore: computeFreshness(date, dateIsReal),
    dateIsReal: Boolean(dateIsReal),
    trustScore: Number(trustScore.toFixed(2)),
    visibleCaptureOnly: true,
    hasProofSnippet
  };
}

function assertSafeVisibleCapture(post) {
  if (post.visibleCaptureOnly === false) {
    const error = new Error("Rejected: only user-approved visible post indexing is allowed.");
    error.status = 400;
    throw error;
  }

  if (post.autoScrolled === true || post.hiddenScrape === true || post.loginBypass === true) {
    const error = new Error("Rejected: auto-scroll, hidden scraping, or login bypass is not allowed.");
    error.status = 400;
    throw error;
  }
}

function buildTitle(text, fallback) {
  const firstLine = cleanText(text).split("\n")[0] || fallback;
  return firstLine.length <= 90 ? firstLine : `${firstLine.slice(0, 87)}...`;
}

function buildDocId(post) {
  if (post.docId) return cleanText(post.docId);

  const stable = [
    post.url,
    post.groupName,
    post.authorDisplay,
    post.date,
    post.text,
    Array.isArray(post.comments) ? post.comments.join(" ") : ""
  ].join("|");

  return `community_${hash(stable).slice(0, 32)}`;
}

export function normalizeCommunityPost(post = {}) {
  assertSafeVisibleCapture(post);

  const rawText = cleanText(post.text || post.body || post.content);
  const text = removeNoiseLines(rawText);
  const comments = normalizeComments(post.comments || []);
  const allText = [text, ...comments].join("\n");

  if (text.length < 10 && comments.length === 0) {
    const error = new Error("Rejected: post text is too short after cleaning.");
    error.status = 400;
    throw error;
  }

  const url = safeUrl(post.url || post.postUrl || "");
  const parsedDate = parseDate(post.date || post.createdAt);
  // A date is only "real" when it came from the post itself (extension
  // timestamp extraction or an explicit createdAt) — otherwise it is just the
  // capture time and must not count as freshness.
  const dateIsReal = Boolean(parsedDate);
  const date = parsedDate || new Date().toISOString();
  const deadline = parseDate(post.deadline) || extractDeadline(allText);
  const topics = Array.isArray(post.topics) && post.topics.length
    ? post.topics.map(cleanText).filter(Boolean)
    : detectTopics(allText);

  const location = cleanText(post.location) || detectLocation(allText);
  const skills = extractSkills(allText);
  const groupName = cleanText(post.groupName || post.communityName || "Community");
  const authorDisplay = cleanText(post.authorDisplay || post.author || "");
  const title = cleanText(post.title) || buildTitle(text, `${groupName} post`);

  const tags = Array.from(new Set([
    "community-visible-post",
    ...topics,
    ...(deadline ? ["deadline"] : []),
    ...(url ? ["has-link"] : []),
    ...(allText.toLowerCase().includes("paid") ? ["paid"] : []),
    ...(allText.toLowerCase().includes("beginner") ? ["beginner-friendly"] : [])
  ]));

  const trustSignals = computeTrustSignals({
    text: allText,
    comments,
    url,
    deadline,
    date,
    dateIsReal
  });

  return {
    docId: buildDocId({ ...post, text, comments, url, date, groupName }),
    sourceType: cleanText(post.sourceType || "facebook_group"),
    platform: cleanText(post.platform || "facebook"),
    groupName,
    authorDisplay,
    title,
    text,
    comments,
    url,
    date,
    indexedAt: new Date().toISOString(),
    language: detectLanguage(allText),
    topics,
    tags,
    skills,
    location,
    deadline,
    visibleCaptureOnly: true,
    sourceCapture: {
      captureMode: cleanText(post.captureMode || "user_clicked_visible_posts"),
      capturedBy: cleanText(post.capturedBy || "chrome_extension_or_manual_client"),
      pageUrl: safeUrl(post.pageUrl || ""),
      capturedAt: new Date().toISOString()
    },
    trustSignals,
    confidence: Math.round(trustSignals.trustScore * 100),
    finalScore: trustSignals.trustScore + trustSignals.freshnessScore
  };
}

// Semantic index text. Rebuilt after LLM enrichment so extracted tags,
// category and location are searchable too.
function buildEmbeddingText(doc) {
  return [
    doc.title,
    doc.text,
    (doc.comments || []).join("\n"),
    (doc.topics || []).join(" "),
    (doc.tags || []).join(" "),
    (doc.skills || []).join(" "),
    doc.groupName,
    doc.location
  ]
    .filter(Boolean)
    .join("\n");
}

/* ---------------- chunking ----------------
 * One vector per post dilutes long posts: mean-pooling averages a 3000-char
 * post into mush and the model truncates anyway. Long posts become several
 * chunk documents, each with its own embedding of title+chunk; retrieval
 * collapses chunks back to the parent post (see retrieval.service.js).
 */
const CHUNK_THRESHOLD = 1400;
const CHUNK_CHARS = 1100;
const CHUNK_OVERLAP = 150;

function splitIntoChunks(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    // Prefer breaking on a paragraph/sentence boundary near the end.
    if (end < text.length) {
      const slice = text.slice(start, end);
      const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
      if (breakAt > CHUNK_CHARS * 0.5) end = start + breakAt + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks.filter(Boolean);
}

function expandIntoChunkDocs(doc) {
  doc.parentDocId = doc.docId;
  doc.isChunk = false;
  const text = doc.text || "";
  if (text.length <= CHUNK_THRESHOLD) return [doc];

  const chunks = splitIntoChunks(text);
  // The parent doc's vector covers the opening; extra docs cover the rest.
  doc.embeddingText = [doc.title, chunks[0]].filter(Boolean).join("\n");
  const extras = chunks.slice(1).map((chunk, i) => ({
    ...doc,
    docId: `${doc.docId}::c${i + 1}`,
    parentDocId: doc.docId,
    isChunk: true,
    embeddingText: [doc.title, chunk].filter(Boolean).join("\n")
  }));
  return [doc, ...extras];
}

/* ---------------- near-duplicate (repost) detection ----------------
 * Exact-hash dedup misses reposts with slightly different wording, so the
 * same internship would pile up as several documents and crowd the top-5.
 * At ingest we kNN-check each new post against the index; a raw cosine at or
 * above NEAR_DUP_THRESHOLD means "same content reworded" -> merge into the
 * existing doc (count the repost, refresh its date/freshness if the repost is
 * newer) instead of inserting a twin.
 */
const NEAR_DUP_THRESHOLD = Number(process.env.NEAR_DUP_THRESHOLD || 0.95);

async function findNearDuplicate(doc) {
  if (!Array.isArray(doc.embedding)) return null;
  try {
    const res = await elastic.search({
      index: COMMUNITY_POSTS_INDEX,
      size: 3,
      _source: ["docId", "parentDocId", "title", "date"],
      knn: {
        field: "embedding",
        query_vector: doc.embedding,
        k: 3,
        num_candidates: 60
      }
    });
    for (const hit of res.hits?.hits || []) {
      const parentKey = hit._source?.parentDocId || hit._id;
      // The same doc re-captured verbatim is an upsert, not a duplicate.
      if (parentKey === doc.docId) continue;
      const cosine = 2 * (hit._score ?? 0) - 1; // ES cosine score = (1+cos)/2
      if (cosine < NEAR_DUP_THRESHOLD) return null;
      return { id: parentKey, title: hit._source?.title || "", cosine };
    }
    return null;
  } catch {
    return null; // index missing / kNN unavailable -> keep normal insert
  }
}

async function mergeRepost(existingId, doc) {
  const newDate = doc.trustSignals?.dateIsReal ? doc.date : null;
  await elastic.update({
    index: COMMUNITY_POSTS_INDEX,
    id: existingId,
    script: {
      source: `
        ctx._source.repostCount = ctx._source.repostCount == null ? 1 : ctx._source.repostCount + 1;
        ctx._source.lastRepostAt = params.now;
        if (params.date != null && (ctx._source.date == null || params.date.compareTo(ctx._source.date.toString()) > 0)) {
          ctx._source.date = params.date;
          if (ctx._source.trustSignals != null) {
            ctx._source.trustSignals.freshnessScore = params.freshness;
            ctx._source.trustSignals.dateIsReal = true;
          }
        }
      `,
      params: {
        now: new Date().toISOString(),
        date: newDate,
        freshness: newDate ? computeFreshness(newDate, true) : null
      }
    }
  });
}

// Drop near-duplicates and merge reposts. Mutates nothing; returns the docs
// to actually index plus a record of what was merged where.
async function dedupeNearDuplicates(docs) {
  const parents = docs.filter((d) => !d.isChunk);
  const mergedInto = new Map(); // parentDocId -> {into, similarity, reason}

  // 1. Within the incoming batch itself (same post captured twice this scroll).
  for (let i = 0; i < parents.length; i += 1) {
    if (mergedInto.has(parents[i].docId)) continue;
    for (let j = i + 1; j < parents.length; j += 1) {
      if (mergedInto.has(parents[j].docId)) continue;
      const a = parents[i].embedding;
      const b = parents[j].embedding;
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const cos = cosineSimilarity(a, b);
      if (cos >= NEAR_DUP_THRESHOLD) {
        mergedInto.set(parents[j].docId, {
          into: parents[i].docId,
          similarity: Number(cos.toFixed(3)),
          reason: "duplicate_in_batch"
        });
      }
    }
  }

  // 2. Against what is already in the index (reworded reposts).
  for (const parent of parents) {
    if (mergedInto.has(parent.docId)) continue;
    // eslint-disable-next-line no-await-in-loop
    const dup = await findNearDuplicate(parent);
    if (dup) {
      // eslint-disable-next-line no-await-in-loop
      await mergeRepost(dup.id, parent).catch(() => {});
      mergedInto.set(parent.docId, {
        into: dup.id,
        similarity: Number(dup.cosine.toFixed(3)),
        reason: "repost_of_indexed_post"
      });
    }
  }

  const keep = docs.filter((d) => !mergedInto.has(d.parentDocId));
  const merged = [...mergedInto.entries()].map(([docId, m]) => ({
    docId,
    mergedInto: m.into,
    similarity: m.similarity,
    reason: m.reason
  }));
  return { keep, merged };
}

export async function ingestCommunityPosts({ posts = [], source = "api_client" }) {
  if (!Array.isArray(posts) || posts.length === 0) {
    const error = new Error("posts array is required.");
    error.status = 400;
    throw error;
  }

  const accepted = [];
  const rejected = [];

  for (const post of posts.slice(0, 100)) {
    try {
      accepted.push(normalizeCommunityPost({
        ...post,
        capturedBy: post.capturedBy || source
      }));
    } catch (error) {
      rejected.push({
        reason: error.message,
        preview: cleanText(post?.text || post?.title || "").slice(0, 140)
      });
    }
  }

  let merged = [];
  let enriched = 0;
  if (accepted.length > 0) {
    // LLM structured extraction (deadline/salary/location/isPaid/workMode/
    // applyUrl in ANY language). No-op without an LLM key.
    enriched = await enrichDocs(accepted).catch(() => 0);
    accepted.forEach((doc) => {
      doc.embeddingText = buildEmbeddingText(doc);
    });

    // Long posts become several chunk docs (own vector each); short posts
    // stay single. Retrieval collapses chunks back to the parent post.
    const docs = accepted.flatMap(expandIntoChunkDocs);
    // Add semantic vectors so posts are searchable by meaning, not just keywords.
    await attachEmbeddings(docs);

    // Reworded reposts merge into the existing doc instead of duplicating.
    const deduped = await dedupeNearDuplicates(docs);
    merged = deduped.merged;

    if (deduped.keep.length > 0) {
      const operations = deduped.keep.flatMap((doc) => [
        { update: { _index: COMMUNITY_POSTS_INDEX, _id: doc.docId } },
        { doc, doc_as_upsert: true }
      ]);

      const result = await elastic.bulk({
        refresh: true,
        operations
      });

      if (result.errors) {
        const failed = result.items.filter((item) => item.update?.error);
        console.error(JSON.stringify(failed.slice(0, 5), null, 2));
        throw new Error("Elasticsearch bulk ingestion failed.");
      }
    }
  }

  const count = await elastic.count({ index: COMMUNITY_POSTS_INDEX });

  return {
    ok: true,
    index: COMMUNITY_POSTS_INDEX,
    received: posts.length,
    accepted: accepted.length,
    enriched,
    merged: merged.length,
    mergedItems: merged,
    rejected: rejected.length,
    rejectedItems: rejected,
    totalCommunityDocs: count.count,
    safety: {
      visibleOnly: true,
      autoScrollAllowed: false,
      hiddenScrapingAllowed: false,
      loginBypassAllowed: false
    },
    acceptedDocs: accepted.map((doc) => ({
      docId: doc.docId,
      title: doc.title,
      topics: doc.topics,
      tags: doc.tags,
      confidence: doc.confidence,
      url: doc.url,
      date: doc.date,
      groupName: doc.groupName
    }))
  };
}

export async function ingestSingleCommunityPost(post, source = "manual") {
  return ingestCommunityPosts({
    posts: [post],
    source
  });
}
