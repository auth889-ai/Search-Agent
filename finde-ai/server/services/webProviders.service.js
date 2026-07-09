import { Client } from "@elastic/elasticsearch";
import { attachEmbeddings } from "./embedding.service.js";

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const WEB_SOURCES_INDEX = process.env.WEB_SOURCES_INDEX || "finde_web_sources";

const elastic = new Client({ node: ELASTICSEARCH_NODE });

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function requireQuery(query) {
  const normalized = cleanText(query);
  if (!normalized) {
    const error = new Error("query is required");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function getProvider() {
  return cleanText(process.env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase();
}

function detectIntent(query) {
  const q = query.toLowerCase();

  if (/(internship|intern|career|apply|job circular|hiring|vacancy)/i.test(q)) {
    return "career_or_internship";
  }

  if (/(research|paper|dataset|thesis|fyp|methodology|idea)/i.test(q)) {
    return "research";
  }

  if (/(scholarship|funding|masters|phd|tuition|stipend|eligibility)/i.test(q)) {
    return "scholarship";
  }

  if (/(error|bug|stack|github|docs|mongodb|react|node|python|api)/i.test(q)) {
    return "coding_help";
  }

  if (/(visa|interview|embassy|admission|rent|roommate|flat)/i.test(q)) {
    return "community_life";
  }

  return "general";
}

function buildSmartQuery(query, intent) {
  const base = requireQuery(query);

  const suffixByIntent = {
    career_or_internship: "official application deadline requirements",
    research: "research paper dataset methodology beginner guide",
    scholarship: "official scholarship eligibility deadline documents",
    coding_help: "official docs github stackoverflow solution",
    community_life: "experience guide requirements official source",
    general: ""
  };

  const suffix = suffixByIntent[intent] || "";
  return cleanText(`${base} ${suffix}`);
}

function getDomainTrust(url = "") {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, "").toLowerCase();

    const officialLike =
      domain.endsWith(".edu") ||
      domain.endsWith(".ac.bd") ||
      domain.endsWith(".gov") ||
      domain.includes("careers") ||
      domain.includes("scholarship") ||
      domain.includes("docs.") ||
      domain.includes("developer.") ||
      domain.includes("github.com") ||
      domain.includes("stackoverflow.com") ||
      domain.includes("linkedin.com") ||
      domain.includes("devpost.com");

    return {
      domain,
      sourceOfficial: officialLike,
      trustScore: officialLike ? 0.9 : 0.74
    };
  } catch {
    return {
      domain: "",
      sourceOfficial: false,
      trustScore: 0.65
    };
  }
}

function detectTopics(query, title, content) {
  const text = `${query} ${title} ${content}`.toLowerCase();
  const topics = new Set();

  const map = {
    internship: ["internship", "intern", "career", "apply"],
    job: ["job", "hiring", "vacancy", "job circular"],
    research: ["research", "paper", "dataset", "methodology", "thesis", "fyp"],
    scholarship: ["scholarship", "funding", "masters", "phd", "eligibility"],
    coding: ["error", "bug", "github", "stackoverflow", "docs", "mongodb", "react", "node"],
    visa: ["visa", "interview", "embassy"],
    rent: ["rent", "roommate", "flat", "sublet"],
    official: ["official", "deadline", "eligibility", "application", "requirements"]
  };

  for (const [topic, keywords] of Object.entries(map)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      topics.add(topic);
    }
  }

  return Array.from(topics);
}

function normalizeWebResult({ provider, query, item, index }) {
  const title = cleanText(item.title);
  const url = cleanText(item.url);
  const content = cleanText(item.content || item.snippet || item.description);
  const domainTrust = getDomainTrust(url);
  const topics = detectTopics(query, title, content);
  const now = new Date().toISOString();

  const hasDeadline = /deadline|apply by|last date|application closes|due date/i.test(
    `${title} ${content}`
  );

  return {
    docId: `web_${provider}_${Buffer.from(url || `${title}-${index}`).toString("base64url").slice(0, 40)}`,
    sourceType: domainTrust.sourceOfficial ? "official_web" : "trusted_web",
    siteName: domainTrust.domain || provider,
    domain: domainTrust.domain,
    displayLink: domainTrust.domain,
    title: title || "Untitled web result",
    text: content,
    snippet: content.slice(0, 500),
    url,
    date: now,
    indexedAt: now,
    topics,
    tags: [provider, "web-search", domainTrust.sourceOfficial ? "official-like" : "web-result"],
    location: "global",
    deadline: null,
    sourceRank: index + 1,
    searchQuery: query,
    embeddingText: `${title}\n${content}\n${url}\n${topics.join(" ")}`,
    trustSignals: {
      sourceOfficial: domainTrust.sourceOfficial,
      hasOfficialLink: Boolean(url),
      hasDeadline,
      commentCount: 0,
      reactionCount: 0,
      freshnessScore: 0.84,
      trustScore: domainTrust.trustScore
    },
    confidence: Math.min(98, Math.round((domainTrust.trustScore + 0.84) * 50)),
    finalScore: domainTrust.trustScore + 0.84
  };
}

async function cacheWebResults(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return;

  // Add semantic vectors so cached web sources support meaning-based search.
  await attachEmbeddings(docs);

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

  const result = await elastic.bulk({
    refresh: true,
    operations
  });

  if (result.errors) {
    const failed = result.items.filter((item) => item.update?.error);
    console.error(JSON.stringify(failed.slice(0, 3), null, 2));
    throw new Error("Failed to cache web results into Elasticsearch.");
  }
}

async function searchWithTavily({ query, limit, cache }) {
  const apiKey = cleanText(process.env.TAVILY_API_KEY);

  if (!apiKey) {
    const error = new Error("Tavily is not configured. Add TAVILY_API_KEY to .env and restart backend.");
    error.status = 503;
    throw error;
  }

  const intent = detectIntent(query);
  const smartQuery = buildSmartQuery(query, intent);
  const maxResults = Math.min(Math.max(Number(limit) || 5, 1), 10);

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query: smartQuery,
      search_depth: "advanced",
      include_answer: true,
      include_raw_content: false,
      max_results: maxResults
    })
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Tavily search failed: ${response.status} ${body}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const rawResults = Array.isArray(data.results) ? data.results : [];

  const results = rawResults.map((item, index) =>
    normalizeWebResult({
      provider: "tavily",
      query,
      item: {
        title: item.title,
        url: item.url,
        content: item.content
      },
      index
    })
  );

  if (cache && results.length > 0) {
    await cacheWebResults(results);
  }

  return {
    ok: true,
    provider: "tavily",
    query,
    intent,
    smartQuery,
    answer: data.answer || "",
    count: results.length,
    cachedToElastic: Boolean(cache),
    index: WEB_SOURCES_INDEX,
    results
  };
}

async function searchWithManual({ query, urls = [], cache }) {
  const normalizedQuery = requireQuery(query);

  if (!Array.isArray(urls) || urls.length === 0) {
    const error = new Error("manual provider requires urls array.");
    error.status = 400;
    throw error;
  }

  const results = urls.slice(0, 10).map((url, index) =>
    normalizeWebResult({
      provider: "manual",
      query: normalizedQuery,
      item: {
        title: `Manual source ${index + 1}`,
        url,
        content: `User-provided source for query: ${normalizedQuery}`
      },
      index
    })
  );

  if (cache && results.length > 0) {
    await cacheWebResults(results);
  }

  return {
    ok: true,
    provider: "manual",
    query: normalizedQuery,
    intent: detectIntent(normalizedQuery),
    smartQuery: normalizedQuery,
    answer: "",
    count: results.length,
    cachedToElastic: Boolean(cache),
    index: WEB_SOURCES_INDEX,
    results
  };
}

export async function searchWebWithProvider({
  query,
  limit = 5,
  cache = true,
  provider = "",
  urls = []
}) {
  const normalizedQuery = requireQuery(query);
  const selectedProvider = cleanText(provider || getProvider());

  if (selectedProvider === "tavily") {
    return searchWithTavily({
      query: normalizedQuery,
      limit,
      cache
    });
  }

  if (selectedProvider === "manual") {
    return searchWithManual({
      query: normalizedQuery,
      urls,
      cache
    });
  }

  const error = new Error(
    `Unsupported WEB_SEARCH_PROVIDER "${selectedProvider}". Supported now: tavily, manual.`
  );
  error.status = 400;
  throw error;
}
