import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Client } from "@elastic/elasticsearch";

import searchRoutes from "./routes/search.routes.js";
import webRoutes from "./routes/web.routes.js";
import postsRoutes from "./routes/posts.routes.js";
import agentRoutes from "./routes/agent.routes.js";
import matchRoutes from "./routes/match.routes.js";
import { embedText } from "./services/embedding.service.js";

// Load env from the project root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env.example") });

const app = express();

const PORT = Number(process.env.PORT || 8080);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";

const COMMUNITY_POSTS_INDEX =
  process.env.COMMUNITY_POSTS_INDEX || "finde_community_posts";
const WEB_SOURCES_INDEX =
  process.env.WEB_SOURCES_INDEX || "finde_web_sources";
const USER_KNOWLEDGE_INDEX =
  process.env.USER_KNOWLEDGE_INDEX || "finde_user_knowledge";

const safetyPolicy = {
  allowVisiblePostIndexingOnly:
    process.env.ALLOW_VISIBLE_POST_INDEXING_ONLY !== "false",
  allowAutoScroll: process.env.ALLOW_AUTO_SCROLL === "true",
  allowHiddenScraping: process.env.ALLOW_HIDDEN_SCRAPING === "true",
  rules: [
    "Only index user-approved visible posts.",
    "Do not auto-scroll Facebook or community pages.",
    "Do not bypass login, privacy controls, or platform protections.",
    "Do not collect hidden/private data.",
    "Do not run background mass scraping.",
    "Demo can use sample, owned, or approved datasets."
  ]
};

const elastic = new Client({
  node: ELASTICSEARCH_NODE
});

app.use(helmet());
app.use(
  cors({
    // Allow the web dashboard, the Chrome extension, and local tools.
    origin(origin, callback) {
      const allowed =
        !origin ||
        origin === CLIENT_ORIGIN ||
        origin.startsWith("chrome-extension://") ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1");
      callback(null, allowed);
    },
    credentials: true
  })
);
app.use(express.json({ limit: "8mb" }));
app.use(morgan("dev"));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    app: "FindE AI",
    description:
      "AI Community + Web Search Agent using Chrome Extension, Tavily/web search, Elasticsearch, Elastic MCP, and Gemini.",
    docs: {
      health: "/api/health",
      safety: "/api/safety",
      elastic: "/api/elastic/health",
      search: "/api/search",
      demoSearch: "/api/search/demo",
      webSearch: "/api/web/search",
      demoWebSearch: "/api/web/search/demo",
      postsIndex: "/api/posts/index",
      postsDemoPayload: "/api/posts/demo-payload",
      postsDemoIngest: "/api/posts/demo-ingest"
    }
  });
});

app.get("/api/health", async (_req, res) => {
  let elasticStatus = {
    reachable: false,
    status: "unknown",
    communityDocs: null,
    webDocs: null,
    savedDocs: null
  };

  try {
    const health = await elastic.cluster.health();

    const [communityCount, webCount, savedCount] = await Promise.all([
      elastic.count({ index: COMMUNITY_POSTS_INDEX }).catch(() => ({ count: 0 })),
      elastic.count({ index: WEB_SOURCES_INDEX }).catch(() => ({ count: 0 })),
      elastic.count({ index: USER_KNOWLEDGE_INDEX }).catch(() => ({ count: 0 }))
    ]);

    elasticStatus = {
      reachable: true,
      status: health.status,
      communityDocs: communityCount.count,
      webDocs: webCount.count,
      savedDocs: savedCount.count
    };
  } catch {
    elasticStatus = {
      reachable: false,
      status: "unreachable",
      communityDocs: null,
      webDocs: null,
      savedDocs: null
    };
  }

  res.json({
    ok: true,
    service: "finde-ai-server",
    port: PORT,
    timestamp: new Date().toISOString(),
    indices: {
      communityPosts: COMMUNITY_POSTS_INDEX,
      webSources: WEB_SOURCES_INDEX,
      userKnowledge: USER_KNOWLEDGE_INDEX
    },
    capabilities: {
      elasticsearchSearch: elasticStatus.reachable,
      tavilyWebSearch: Boolean(process.env.TAVILY_API_KEY),
      selectedWebProvider: process.env.WEB_SEARCH_PROVIDER || "tavily",
      googleWebSearchConfigured: Boolean(
        process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_ENGINE_ID
      ),
      communityPostIngestion: true,
      visiblePostSafetyGate: true,
      elasticMcpEnabled: process.env.ELASTIC_MCP_ENABLED === "true",
      geminiConfigured: Boolean(
        process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
      ),
      semanticSearch: true,
      llmConfigured: Boolean(
        process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY
      ),
      rerankConfigured: Boolean(process.env.COHERE_API_KEY)
    },
    elastic: elasticStatus,
    safety: {
      visiblePostIndexingOnly: safetyPolicy.allowVisiblePostIndexingOnly,
      autoScrollAllowed: safetyPolicy.allowAutoScroll,
      hiddenScrapingAllowed: safetyPolicy.allowHiddenScraping,
      loginBypassAllowed: false
    }
  });
});

app.get("/api/safety", (_req, res) => {
  res.json({
    ok: true,
    project: "FindE AI",
    safetyPolicy
  });
});

app.get("/api/elastic/health", async (_req, res) => {
  try {
    const info = await elastic.info();
    const health = await elastic.cluster.health();

    const [communityCount, webCount, savedCount] = await Promise.all([
      elastic.count({ index: COMMUNITY_POSTS_INDEX }).catch(() => ({ count: 0 })),
      elastic.count({ index: WEB_SOURCES_INDEX }).catch(() => ({ count: 0 })),
      elastic.count({ index: USER_KNOWLEDGE_INDEX }).catch(() => ({ count: 0 }))
    ]);

    res.json({
      ok: true,
      elasticsearch: {
        node: ELASTICSEARCH_NODE,
        clusterName: info.cluster_name,
        version: info.version?.number,
        status: health.status,
        numberOfNodes: health.number_of_nodes,
        documents: {
          communityPosts: communityCount.count,
          webSources: webCount.count,
          userKnowledge: savedCount.count
        }
      }
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Elasticsearch is not reachable.",
      node: ELASTICSEARCH_NODE,
      error: error.message
    });
  }
});

// Serve the web dashboard (same-origin, so no CORS needed) at /app.
app.use("/app", express.static(path.join(PROJECT_ROOT, "web")));

app.use("/api", searchRoutes);
app.use("/api", webRoutes);
app.use("/api", postsRoutes);
app.use("/api", agentRoutes);
app.use("/api", matchRoutes);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: "Route not found.",
    path: req.path,
    availableRoutes: [
      "GET /api/health",
      "GET /api/safety",
      "GET /api/elastic/health",
      "GET /api/search/demo",
      "POST /api/search",
      "GET /api/web/search/demo",
      "POST /api/web/search",
      "POST /api/web/manual",
      "GET /api/posts/demo-payload",
      "POST /api/posts/demo-ingest",
      "POST /api/posts/index",
      "POST /api/posts/index-one"
    ]
  });
});

app.listen(PORT, () => {
  console.log(`FindE AI backend running on http://localhost:${PORT}`);
  console.log(`Elasticsearch node: ${ELASTICSEARCH_NODE}`);
  console.log(`Search endpoint: http://localhost:${PORT}/api/search`);
  console.log(`Web search endpoint: http://localhost:${PORT}/api/web/search`);
  console.log(`Posts ingestion endpoint: http://localhost:${PORT}/api/posts/index`);

  // Warm the embedding model so the first user query isn't slow (cold start).
  embedText("warmup")
    .then(() => console.log("Embedding model warmed and ready."))
    .catch(() => {});
});
