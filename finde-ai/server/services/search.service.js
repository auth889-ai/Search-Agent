import { Client } from "@elastic/elasticsearch";
import { cosineSimilarity } from "./embedding.service.js";
import { advancedRetrieve } from "./retrieval.service.js";

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const COMMUNITY_POSTS_INDEX = process.env.COMMUNITY_POSTS_INDEX || "finde_community_posts";
const WEB_SOURCES_INDEX = process.env.WEB_SOURCES_INDEX || "finde_web_sources";
const USER_KNOWLEDGE_INDEX = process.env.USER_KNOWLEDGE_INDEX || "finde_user_knowledge";

const elastic = new Client({
  node: ELASTICSEARCH_NODE
});

const SOURCE_INDEXES = {
  community: COMMUNITY_POSTS_INDEX,
  web: WEB_SOURCES_INDEX,
  saved: USER_KNOWLEDGE_INDEX
};

function normalizeQuery(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectIntent(query) {
  const q = query.toLowerCase();

  const rules = [
    {
      intent: "internship",
      keywords: ["internship", "intern", "career", "apply", "remote", "onsite", "paid internship"]
    },
    {
      intent: "research_idea",
      keywords: ["research", "thesis", "idea", "paper", "dataset", "final year", "fyp", "cybersecurity", "machine learning", "ai"]
    },
    {
      intent: "scholarship",
      keywords: ["scholarship", "funding", "masters", "phd", "tuition", "stipend", "eligibility"]
    },
    {
      intent: "coding_help",
      keywords: ["error", "bug", "fix", "mongodb", "node", "react", "api", "exception", "connection"]
    },
    {
      intent: "job",
      keywords: ["job", "hiring", "vacancy", "software engineer", "developer", "recruitment"]
    },
    {
      intent: "rent_local",
      keywords: ["rent", "room", "roommate", "sublet", "flat", "hostel"]
    }
  ];

  for (const rule of rules) {
    if (rule.keywords.some((keyword) => q.includes(keyword))) {
      return rule.intent;
    }
  }

  return "general_search";
}

function getIntentBoosts(intent) {
  const boosts = {
    internship: ["internship", "cse", "remote", "onsite", "paid", "deadline", "career", "react", "software"],
    research_idea: ["research", "ai", "cybersecurity", "machine-learning", "dataset", "intrusion-detection", "beginner"],
    scholarship: ["scholarship", "masters", "official-source", "deadline", "documents", "eligibility"],
    coding_help: ["coding-error", "mongodb", "atlas", "nodejs", "dotenv", "debugging"],
    job: ["job", "hiring", "career", "developer", "software"],
    rent_local: ["rent", "room", "roommate", "local"],
    general_search: []
  };

  return boosts[intent] || [];
}

function buildIndexList(sourceMode) {
  if (sourceMode === "community") return [COMMUNITY_POSTS_INDEX];
  if (sourceMode === "web") return [WEB_SOURCES_INDEX];
  if (sourceMode === "saved") return [USER_KNOWLEDGE_INDEX];

  return [COMMUNITY_POSTS_INDEX, WEB_SOURCES_INDEX, USER_KNOWLEDGE_INDEX];
}

function buildFilters({ topics, location, sourceType, dateFrom, dateTo }) {
  const filters = [];

  if (Array.isArray(topics) && topics.length > 0) {
    filters.push({
      terms: {
        topics
      }
    });
  }

  if (location) {
    filters.push({
      term: {
        location
      }
    });
  }

  if (sourceType) {
    filters.push({
      term: {
        sourceType
      }
    });
  }

  if (dateFrom || dateTo) {
    filters.push({
      range: {
        date: {
          ...(dateFrom ? { gte: dateFrom } : {}),
          ...(dateTo ? { lte: dateTo } : {})
        }
      }
    });
  }

  return filters;
}

function buildSearchBody({
  query,
  intent,
  size,
  filters,
  includeExpired = true
}) {
  const intentBoosts = getIntentBoosts(intent);

  const shouldBoosts = intentBoosts.flatMap((topic) => [
    {
      term: {
        topics: {
          value: topic,
          boost: 2.2
        }
      }
    },
    {
      term: {
        tags: {
          value: topic,
          boost: 1.7
        }
      }
    }
  ]);

  if (!includeExpired) {
    filters.push({
      bool: {
        should: [
          { bool: { must_not: { exists: { field: "deadline" } } } },
          { range: { deadline: { gte: "now/d" } } }
        ],
        minimum_should_match: 1
      }
    });
  }

  return {
    size,
    track_total_hits: true,
    query: {
      function_score: {
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query,
                  type: "best_fields",
                  fields: [
                    "title^5",
                    "topics^4",
                    "tags^3",
                    "text^2",
                    "comments^2",
                    "snippet^2",
                    "embeddingText^2",
                    "groupName^1.5",
                    "siteName^1.5",
                    "domain"
                  ],
                  fuzziness: "AUTO",
                  operator: "or"
                }
              }
            ],
            should: [
              ...shouldBoosts,
              {
                term: {
                  "trustSignals.sourceOfficial": {
                    value: true,
                    boost: 1.8
                  }
                }
              },
              {
                term: {
                  "trustSignals.hasDeadline": {
                    value: true,
                    boost: 1.2
                  }
                }
              },
              {
                range: {
                  "trustSignals.trustScore": {
                    gte: 0.75,
                    boost: 1.4
                  }
                }
              },
              {
                range: {
                  "trustSignals.freshnessScore": {
                    gte: 0.85,
                    boost: 1.2
                  }
                }
              }
            ],
            filter: filters
          }
        },
        functions: [
          {
            field_value_factor: {
              field: "trustSignals.trustScore",
              factor: 2,
              missing: 0.4
            }
          },
          {
            field_value_factor: {
              field: "trustSignals.freshnessScore",
              factor: 1.5,
              missing: 0.4
            }
          },
          {
            gauss: {
              date: {
                origin: "now",
                scale: "45d",
                decay: 0.6
              }
            },
            weight: 1.2
          }
        ],
        score_mode: "sum",
        boost_mode: "sum"
      }
    },
    highlight: {
      pre_tags: ["<mark>"],
      post_tags: ["</mark>"],
      fields: {
        title: {},
        text: {
          fragment_size: 180,
          number_of_fragments: 2
        },
        comments: {
          fragment_size: 140,
          number_of_fragments: 2
        },
        snippet: {
          fragment_size: 160,
          number_of_fragments: 1
        }
      }
    }
  };
}

function cleanHighlight(hit) {
  const highlight = hit.highlight || {};
  const values = [
    ...(highlight.title || []),
    ...(highlight.text || []),
    ...(highlight.comments || []),
    ...(highlight.snippet || [])
  ];

  return values.length > 0 ? values : [];
}

function computeConfidence(score, source) {
  const trustScore = Number(source.trustSignals?.trustScore || 0);
  const freshnessScore = Number(source.trustSignals?.freshnessScore || 0);
  const officialBoost = source.trustSignals?.sourceOfficial ? 8 : 0;
  const deadlineBoost = source.trustSignals?.hasDeadline ? 4 : 0;

  const raw = Math.min(
    98,
    Math.round(score * 8 + trustScore * 35 + freshnessScore * 25 + officialBoost + deadlineBoost)
  );

  return Math.max(35, raw);
}

const EXPLAIN_STOP = new Set([
  "the", "a", "an", "for", "and", "or", "to", "of", "in", "on", "with", "how",
  "what", "which", "is", "are", "my", "me", "can", "do", "does", "from", "at",
  "by", "as", "be", "this", "that", "it", "you", "your", "we", "just", "who"
]);

function queryTerms(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !EXPLAIN_STOP.has(t));
}

// Wrap query terms found in the text with <mark> for highlight attribution.
function highlightTerms(text, terms) {
  let out = String(text || "");
  const uniq = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const term of uniq) {
    const re = new RegExp(`\\b(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }
  return out;
}

// Build a rich, inspectable explanation for a single result.
function buildExplanation({ source, terms, semanticFit, keywordFit, fitScore, confidence, rerankScore, matchedBy }) {
  const haystack = `${source.title} ${source.text || source.snippet || ""} ${(source.topics || []).join(" ")}`.toLowerCase();
  const matchedTerms = [...new Set(terms)].filter((t) => haystack.includes(t));

  const ts = source.trustSignals || {};
  const signals = [];
  if (source.deadline) signals.push({ type: "deadline", label: `deadline ${String(source.deadline).slice(0, 10)}` });
  if (source.location && source.location !== "global") signals.push({ type: "location", label: source.location });
  if (Array.isArray(source.skills) && source.skills.length) signals.push({ type: "skills", label: source.skills.slice(0, 4).join(", ") });
  if (ts.sourceOfficial) signals.push({ type: "official", label: "official / trusted source" });
  if (ts.commentCount > 0) signals.push({ type: "discussion", label: `${ts.commentCount} community comments` });
  if (ts.freshnessScore >= 0.85) signals.push({ type: "fresh", label: "recent" });

  const scoreBreakdown = {
    semantic: semanticFit ?? 0,
    keyword: keywordFit ?? 0,
    trust: confidence ?? 0,
    rerank: rerankScore ?? null,
    overall: fitScore ?? 0
  };

  // Human-readable ranking rationale.
  const bits = [];
  if (semanticFit != null) {
    const s = semanticFit >= 55 ? "strong" : semanticFit >= 35 ? "moderate" : "weak";
    bits.push(`${s} meaning match (${semanticFit}%)`);
  }
  if (keywordFit >= 60) bits.push("high keyword overlap");
  else if (keywordFit > 0) bits.push("partial keyword overlap");
  if (matchedBy.length === 2) bits.push("found by both semantic and keyword search");
  if (rerankScore != null) bits.push(`cross-encoder reranked (${rerankScore}%)`);
  if (ts.sourceOfficial) bits.push("official source");
  if (source.deadline) bits.push("has an actionable deadline");
  const rankReason = bits.length ? bits.join("; ") + "." : "matched your query.";

  return { matchedTerms, signals, scoreBreakdown, rankReason };
}

// Map a fused/diversified candidate from the retrieval engine into a result.
function mapCandidate(cand, context) {
  const source = cand.source || {};
  const { queryVector, rrfMin = 0, rrfMax = 0, rankCap = 20 } = context;

  const embedding = source.embedding;
  const sem =
    queryVector && Array.isArray(embedding)
      ? Math.max(0, Math.min(1, cosineSimilarity(queryVector, embedding)))
      : typeof cand.relevance === "number"
      ? Math.max(0, cand.relevance)
      : null;
  const semanticFit = sem != null ? Math.round(sem * 100) : null;

  // Lexical strength from best BM25 rank (rank-based, no fragile score norm).
  const keywordFit =
    cand.bm25Rank != null
      ? Math.round((100 * (rankCap - Math.min(cand.bm25Rank, rankCap - 1))) / rankCap)
      : 0;

  // Overall fit = fused rank (RRF) blended with semantic meaning.
  const rrfNorm = rrfMax > rrfMin ? (cand.rrf - rrfMin) / (rrfMax - rrfMin) : 1;
  // Anchor fit on ABSOLUTE semantic similarity (this is a meaning search), then
  // let fusion rank modulate it +/-30%. This way a weak-meaning doc stays low
  // even if it is the best of a bad set (min-max rank would otherwise inflate it).
  const fitScore =
    sem != null
      ? Math.round(100 * sem * (0.7 + 0.3 * rrfNorm))
      : Math.round(55 * rrfNorm);

  const confidence = computeConfidence(0, source);
  // Only claim a "semantic" match when the cosine similarity is actually decent;
  // kNN always returns k docs, so mere presence isn't a real meaning match.
  const MIN_SEMANTIC = 0.3;
  const matchedBy = [];
  if (cand.knnRank != null && sem != null && sem >= MIN_SEMANTIC) matchedBy.push("semantic");
  if (cand.bm25Rank != null) matchedBy.push("keyword");

  const terms = context.queryTerms || [];
  const rerankScore = typeof cand.rerankScore === "number" ? cand.rerankScore : null;
  const explanation = buildExplanation({
    source,
    terms,
    semanticFit,
    keywordFit,
    fitScore,
    confidence,
    rerankScore,
    matchedBy
  });

  const rawSnippet = source.snippet || (source.text || "").slice(0, 260);
  const highlightedSnippet = highlightTerms(rawSnippet, terms);

  return {
    id: cand.id,
    index: cand.index,
    fitScore,
    semanticFit,
    keywordFit,
    rrfScore: Number((cand.rrf || 0).toFixed(5)),
    rerankScore,
    matchedBy,
    confidence,
    sourceType: source.sourceType || "unknown",
    title: source.title || "Untitled source",
    text: source.text || "",
    snippet: rawSnippet,
    highlightedSnippet,
    matchedSnippets: [highlightedSnippet],
    url: source.url || "",
    date: source.date || null,
    deadline: source.deadline || null,
    topics: source.topics || [],
    tags: source.tags || [],
    skills: source.skills || [],
    location: source.location || "",
    groupName: source.groupName || "",
    siteName: source.siteName || "",
    domain: source.domain || "",
    trustSignals: source.trustSignals || {},
    explanation,
    whyRelevant: buildWhyRelevant(source, confidence, matchedBy)
  };
}

function buildWhyRelevant(source, confidence, matchedBy = []) {
  const reasons = [];

  if (matchedBy.length) {
    reasons.push(`matched by ${matchedBy.join(" + ")}`);
  }

  if (Array.isArray(source.topics) && source.topics.length > 0) {
    reasons.push(`topics: ${source.topics.slice(0, 4).join(", ")}`);
  }

  if (source.trustSignals?.sourceOfficial) {
    reasons.push("official or trusted web source");
  }

  if (source.trustSignals?.hasDeadline) {
    reasons.push("contains deadline/application timing signal");
  }

  if (source.trustSignals?.commentCount > 0) {
    reasons.push(`community discussion has ${source.trustSignals.commentCount} useful comments`);
  }

  reasons.push(`confidence ${confidence}%`);

  return reasons.join("; ");
}

function groupResults(results) {
  return {
    communityPosts: results.filter((item) => item.index === COMMUNITY_POSTS_INDEX),
    webSources: results.filter((item) => item.index === WEB_SOURCES_INDEX),
    savedSources: results.filter((item) => item.index === USER_KNOWLEDGE_INDEX)
  };
}

function buildAnswerDraft({ query, intent, results }) {
  if (!results.length) {
    return {
      summary: `I could not find strong evidence for "${query}" yet.`,
      nextActions: [
        "Index more visible community posts.",
        "Turn on web search source.",
        "Try a more specific query with topic, location, or deadline."
      ]
    };
  }

  const top = results[0];
  const communityCount = results.filter((r) => r.index === COMMUNITY_POSTS_INDEX).length;
  const webCount = results.filter((r) => r.index === WEB_SOURCES_INDEX).length;

  return {
    summary: `Best match for "${query}" is "${top.title}" with ${top.fitScore}% fit (${top.confidence}% trust). Intent detected: ${intent}. Found ${communityCount} community result(s) and ${webCount} web result(s).`,
    nextActions: [
      top.url ? "Open the strongest source link." : "Review the strongest matched source.",
      "Check date/deadline before acting.",
      "Ask a follow-up question to narrow by location, skill, or source type."
    ]
  };
}

export async function searchFindE({
  query,
  sourceMode = "all",
  topics = [],
  location = "",
  sourceType = "",
  dateFrom = "",
  dateTo = "",
  includeExpired = true,
  limit = 10
}) {
  const normalizedQuery = normalizeQuery(query);

  if (!normalizedQuery) {
    const error = new Error("query is required");
    error.status = 400;
    throw error;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const intent = detectIntent(normalizedQuery);
  const indexes = buildIndexList(sourceMode);
  const filters = buildFilters({ topics, location, sourceType, dateFrom, dateTo });

  if (!includeExpired) {
    filters.push({
      bool: {
        should: [
          { bool: { must_not: { exists: { field: "deadline" } } } },
          { range: { deadline: { gte: "now/d" } } }
        ],
        minimum_should_match: 1
      }
    });
  }

  // Advanced retrieval: multi-query -> BM25 + kNN per query -> weighted RRF
  // fusion -> MMR diversification. See retrieval.service.js.
  const { queryVector, candidates, plan } = await advancedRetrieve({
    query: normalizedQuery,
    indexes,
    size: safeLimit,
    filters,
    intent
  });

  const context = {
    queryVector,
    queryTerms: queryTerms(normalizedQuery),
    rrfMin: plan.rrfMin,
    rrfMax: plan.rrfMax,
    rankCap: safeLimit * 2
  };

  const results = candidates
    .map((cand) => mapCandidate(cand, context))
    .sort((a, b) => b.fitScore - a.fitScore || b.confidence - a.confidence);
  const grouped = groupResults(results);
  const searchMode = queryVector ? "advanced_rrf_mmr" : "keyword_rrf";

  return {
    ok: true,
    query: normalizedQuery,
    intent,
    sourceMode,
    searchMode,
    total: results.length,
    count: results.length,
    queryPlan: {
      indexes,
      searchMode,
      retrieval: plan,
      intentBoosts: getIntentBoosts(intent),
      filters: {
        topics,
        location,
        sourceType,
        dateFrom,
        dateTo,
        includeExpired
      }
    },
    answerDraft: buildAnswerDraft({
      query: normalizedQuery,
      intent,
      results
    }),
    grouped,
    results
  };
}
