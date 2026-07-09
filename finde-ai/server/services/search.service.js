import { Client } from "@elastic/elasticsearch";
import { embedText, cosineSimilarity } from "./embedding.service.js";

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

function computeFit(hit, context) {
  const source = hit._source || {};
  const rawScore = hit._score || 0;
  const { qvec, scoreMin = 0, scoreMax = 0 } = context;

  const embedding = source.embedding;
  const semanticFit =
    qvec && Array.isArray(embedding)
      ? Math.round(
          Math.max(0, Math.min(1, cosineSimilarity(qvec, embedding))) * 100
        )
      : null;

  const keywordFit =
    scoreMax > scoreMin
      ? Math.round(((rawScore - scoreMin) / (scoreMax - scoreMin)) * 100)
      : rawScore > 0
      ? 100
      : 0;

  // Blend meaning (semantic) with lexical (keyword) match into one fit score.
  const fitScore =
    semanticFit != null
      ? Math.round(0.7 * semanticFit + 0.3 * keywordFit)
      : keywordFit;

  return { semanticFit, keywordFit, fitScore };
}

function mapHit(hit, context = {}) {
  const source = hit._source || {};
  const confidence = computeConfidence(hit._score || 0, source);
  const { semanticFit, keywordFit, fitScore } = computeFit(hit, context);

  return {
    id: hit._id,
    index: hit._index,
    score: hit._score,
    fitScore,
    semanticFit,
    keywordFit,
    confidence,
    sourceType: source.sourceType || "unknown",
    title: source.title || "Untitled source",
    text: source.text || "",
    snippet: source.snippet || "",
    matchedSnippets: cleanHighlight(hit),
    url: source.url || "",
    date: source.date || null,
    deadline: source.deadline || null,
    topics: source.topics || [],
    tags: source.tags || [],
    location: source.location || "",
    groupName: source.groupName || "",
    siteName: source.siteName || "",
    domain: source.domain || "",
    trustSignals: source.trustSignals || {},
    whyRelevant: buildWhyRelevant(source, confidence)
  };
}

function buildWhyRelevant(source, confidence) {
  const reasons = [];

  if (Array.isArray(source.topics) && source.topics.length > 0) {
    reasons.push(`matches topics: ${source.topics.slice(0, 4).join(", ")}`);
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

  const body = buildSearchBody({
    query: normalizedQuery,
    intent,
    size: safeLimit,
    filters,
    includeExpired
  });

  // Semantic layer: embed the query and add a kNN clause for meaning-based recall.
  // ES sums the BM25 (query) and kNN scores, giving hybrid ranking. If the model
  // is unavailable, qvec is null and we fall back to pure keyword search.
  const qvec = await embedText(normalizedQuery);
  const knn = qvec
    ? {
        field: "embedding",
        query_vector: qvec,
        k: safeLimit,
        num_candidates: Math.max(50, safeLimit * 10),
        boost: 4
      }
    : undefined;

  const response = await elastic.search({
    index: indexes,
    ...body,
    ...(knn ? { knn } : {})
  });

  const hits = response.hits?.hits || [];

  // Min/max of raw ES scores for normalizing the keyword component.
  const scores = hits.map((h) => h._score || 0);
  const scoreMin = scores.length ? Math.min(...scores) : 0;
  const scoreMax = scores.length ? Math.max(...scores) : 0;
  const context = { qvec, scoreMin, scoreMax };

  const results = hits
    .map((hit) => mapHit(hit, context))
    .sort((a, b) => b.fitScore - a.fitScore || b.confidence - a.confidence);
  const grouped = groupResults(results);
  const searchMode = qvec ? "hybrid_semantic_keyword" : "keyword_only";

  return {
    ok: true,
    query: normalizedQuery,
    intent,
    sourceMode,
    searchMode,
    total: response.hits?.total?.value ?? results.length,
    count: results.length,
    queryPlan: {
      indexes,
      searchMode,
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
