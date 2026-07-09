import crypto from "crypto";
import { Client } from "@elastic/elasticsearch";
import { attachEmbeddings } from "./embedding.service.js";

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

function computeTrustSignals({ text, comments, url, deadline }) {
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
    freshnessScore: 0.88,
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
  const date = parseDate(post.date || post.createdAt) || new Date().toISOString();
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
    deadline
  });

  const embeddingText = [
    title,
    text,
    comments.join("\n"),
    topics.join(" "),
    tags.join(" "),
    skills.join(" "),
    groupName,
    location
  ].filter(Boolean).join("\n");

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
    finalScore: trustSignals.trustScore + trustSignals.freshnessScore,
    embeddingText
  };
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

  if (accepted.length > 0) {
    // Add semantic vectors so posts are searchable by meaning, not just keywords.
    await attachEmbeddings(accepted);

    const operations = accepted.flatMap((doc) => [
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

  const count = await elastic.count({ index: COMMUNITY_POSTS_INDEX });

  return {
    ok: true,
    index: COMMUNITY_POSTS_INDEX,
    received: posts.length,
    accepted: accepted.length,
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
