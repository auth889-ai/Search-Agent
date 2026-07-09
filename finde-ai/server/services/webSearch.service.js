import { Client } from "@elastic/elasticsearch";

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const WEB_SOURCES_INDEX = process.env.WEB_SOURCES_INDEX || "finde_web_sources";

const elastic = new Client({
  node: ELASTICSEARCH_NODE
});

function getGoogleSearchConfig() {
  const apiKey = process.env.GOOGLE_CSE_API_KEY || "";
  const engineId = process.env.GOOGLE_CSE_ENGINE_ID || "";

  return {
    apiKey: apiKey.trim(),
    engineId: engineId.trim()
  };
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuery(query) {
  const normalized = cleanText(query);

  if (!normalized) {
    const error = new Error("query is required");
    error.status = 400;
    throw error;
  }

  return normalized;
}

function detectWebIntent(query) {
  const q = query.toLowerCase();

  if (q.includes("internship") || q.includes("intern") || q.includes("career")) {
    return "internship";
  }

  if (
    q.includes("research") ||
    q.includes("paper") ||
    q.includes("dataset") ||
    q.includes("thesis") ||
    q.includes("fyp")
  ) {
    return "research";
  }

  if (
    q.includes("scholarship") ||
    q.includes("funding") ||
    q.includes("masters") ||
    q.includes("phd")
  ) {
    return "scholarship";
  }

  if (
    q.includes("error") ||
    q.includes("bug") ||
    q.includes("docs") ||
    q.includes("github") ||
    q.includes("stackoverflow") ||
    q.includes("mongodb") ||
    q.includes("react") ||
    q.includes("node")
  ) {
    return "coding_help";
  }

  if (q.includes("job") || q.includes("hiring") || q.includes("vacancy")) {
    return "job";
  }

  return "general";
}

function buildSmartWebQuery(query, intent) {
  const base = normalizeQuery(query);

  const intentBoosts = {
    internship: `${base} internship official career apply deadline`,
    research: `${base} research paper dataset university github methodology`,
    scholarship: `${base} scholarship official eligibility deadline university`,
    coding_help: `${base} official docs github stackoverflow solution`,
    job: `${base} job hiring official career apply`,
    general: base
  };

  return intentBoosts[intent] || base;
}

function getDomainTrust(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

    const officialLike =
      host.endsWith(".edu") ||
      host.endsWith(".ac.bd") ||
      host.endsWith(".gov") ||
      host.includes("careers") ||
      host.includes("scholarship") ||
      host.includes("docs.") ||
      host.includes("developer.") ||
      host.includes("github.com") ||
      host.includes("stackoverflow.com");

    return {
      domain: host,
      sourceOfficial: officialLike,
      trustScore: officialLike ? 0.9 : 0.72
    };
  } catch {
    return {
      domain: "",
      sourceOfficial: false,
      trustScore: 0.65
    };
  }
}

function detectTopics(query, item) {
  const text = `${query} ${item.title || ""} ${item.snippet || ""}`.toLowerCase();
  const topics = new Set();

  const topicMap = {
    internship: ["internship", "intern", "career", "apply"],
    research: ["research", "paper", "dataset", "thesis", "methodology", "fyp"],
    scholarship: ["scholarship", "funding", "masters", "phd", "eligibility"],
    coding: ["error", "bug", "docs", "github", "stackoverflow", "mongodb", "react", "node"],
    job: ["job", "hiring", "vacancy", "developer"],
    official: ["official", "deadline", "eligibility", "application"]
  };

  for (const [topic, keywords] of Object.entries(topicMap)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      topics.add(topic);
    }
  }

  return Array.from(topics);
}

function normalizeGoogleItem(item, query, index) {
  const link = cleanText(item.link);
  const title = cleanText(item.title);
  const snippet = cleanText(item.snippet);
  const displayLink = cleanText(item.displayLink);
  const domainTrust = getDomainTrust(link);
  const topics = detectTopics(query, { title, snippet });

  const hasDeadline = /deadline|apply by|last date|application closes|due date/i.test(
    `${title} ${snippet}`
  );

  const now = new Date().toISOString();

  return {
    docId: `web_google_${Buffer.from(link || `${title}-${index}`).toString("base64url").slice(0, 32)}`,
    sourceType: domainTrust.sourceOfficial ? "official_web" : "trusted_web",
    siteName: displayLink || domainTrust.domain || "web source",
    domain: domainTrust.domain,
    displayLink,
    title,
    text: snippet,
    snippet,
    url: link,
    date: now,
    indexedAt: now,
    topics,
    tags: [
      "google-custom-search",
      domainTrust.sourceOfficial ? "official-like" : "web-result"
    ],
    location: "global",
    deadline: null,
    sourceRank: index + 1,
    searchQuery: query,
    embeddingText: `${title}\n${snippet}\n${link}\n${topics.join(" ")}`,
    trustSignals: {
      sourceOfficial: domainTrust.sourceOfficial,
      hasOfficialLink: Boolean(link),
      hasDeadline,
      commentCount: 0,
      reactionCount: 0,
      freshnessScore: 0.82,
      trustScore: domainTrust.trustScore
    },
    confidence: Math.round((domainTrust.trustScore + 0.82) * 50),
    finalScore: domainTrust.trustScore + 0.82
  };
}

async function cacheWebResults(docs) {
  if (!docs.length) return;

  const operations = docs.flatMap((doc) => [
    {
      update: {
        _index: WEB_SOURCES_INDEX,
        _id: doc.docId
      }
    },
    {
      doc,
      doc_as_upsert: true
    }
  ]);

  const response = await elastic.bulk({
    refresh: true,
    operations
  });

  if (response.errors) {
    const failed = response.items.filter((item) => item.update?.error);
    console.error(JSON.stringify(failed.slice(0, 3), null, 2));
    throw new Error("Failed to cache web search results into Elasticsearch.");
  }
}

export async function searchGoogleWeb({
  query,
  limit = 5,
  safe = "active",
  cache = true
}) {
  const normalizedQuery = normalizeQuery(query);
  const { apiKey, engineId } = getGoogleSearchConfig();

  if (!apiKey || !engineId) {
    const error = new Error(
      "Google Custom Search is not configured. Add GOOGLE_CSE_API_KEY and GOOGLE_CSE_ENGINE_ID to .env, then restart backend."
    );
    error.status = 503;
    throw error;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const intent = detectWebIntent(normalizedQuery);
  const smartQuery = buildSmartWebQuery(normalizedQuery, intent);

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", engineId);
  url.searchParams.set("q", smartQuery);
  url.searchParams.set("num", String(safeLimit));
  url.searchParams.set("safe", safe);

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Google Custom Search failed: ${response.status} ${body}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];
  const results = items.map((item, index) => normalizeGoogleItem(item, normalizedQuery, index));

  if (cache && results.length > 0) {
    await cacheWebResults(results);
  }

  return {
    ok: true,
    query: normalizedQuery,
    intent,
    smartQuery,
    count: results.length,
    cachedToElastic: Boolean(cache),
    index: WEB_SOURCES_INDEX,
    results
  };
}
