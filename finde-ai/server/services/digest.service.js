/**
 * Opportunity radar: the digest of what is closing soon.
 *
 * Search answers questions the user asks; the digest surfaces what they would
 * regret missing WITHOUT asking — every indexed post/page with a deadline in
 * the next N days, soonest first. This is the feature layer generic group
 * search never provides: the corpus becomes an alertable opportunity database.
 */
import { Client } from "@elastic/elasticsearch";

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";
const COMMUNITY_POSTS_INDEX = process.env.COMMUNITY_POSTS_INDEX || "finde_community_posts";
const WEB_SOURCES_INDEX = process.env.WEB_SOURCES_INDEX || "finde_web_sources";

const elastic = new Client({ node: ELASTICSEARCH_NODE });

export async function upcomingDeadlines({ days = 14, limit = 12 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 14, 1), 90);
  const safeLimit = Math.min(Math.max(Number(limit) || 12, 1), 50);

  const res = await elastic.search({
    index: [COMMUNITY_POSTS_INDEX, WEB_SOURCES_INDEX],
    size: safeLimit,
    sort: [{ deadline: "asc" }],
    query: {
      bool: {
        filter: [
          { range: { deadline: { gte: "now/d", lte: `now+${safeDays}d/d` } } },
          // Chunks share the parent's deadline; only list each post once.
          { bool: { must_not: { term: { isChunk: true } } } }
        ]
      }
    },
    _source: [
      "docId", "title", "url", "deadline", "date", "topics", "location",
      "sourceType", "groupName", "siteName", "trustSignals.sourceOfficial"
    ]
  });

  const now = Date.now();
  const items = (res.hits?.hits || []).map((h) => {
    const s = h._source || {};
    const daysLeft = Math.max(
      0,
      Math.ceil((Date.parse(s.deadline) - now) / (1000 * 60 * 60 * 24))
    );
    return {
      id: h._id,
      index: h._index,
      docId: s.docId,
      title: s.title || "Untitled",
      url: s.url || "",
      deadline: s.deadline,
      daysLeft,
      urgency: daysLeft <= 3 ? "critical" : daysLeft <= 7 ? "soon" : "upcoming",
      topics: s.topics || [],
      location: s.location || "",
      from: s.groupName || s.siteName || "",
      official: Boolean(s.trustSignals?.sourceOfficial)
    };
  });

  return { ok: true, days: safeDays, count: items.length, items };
}
