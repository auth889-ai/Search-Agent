import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { Client } from "@elastic/elasticsearch";

dotenv.config({ path: "../.env" });
dotenv.config({ path: "../.env.example" });

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
    "Demo can use sample, owned, or approved datasets."
  ]
};

const elastic = new Client({
  node: ELASTICSEARCH_NODE
});

app.use(helmet());
app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    app: "FindE AI",
    description:
      "AI Community + Web Search Agent using Chrome Extension, Elasticsearch, Elastic MCP, and Gemini.",
    docs: {
      health: "/api/health",
      safety: "/api/safety",
      elastic: "/api/elastic/health"
    }
  });
});

app.get("/api/health", (_req, res) => {
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
    safety: {
      visiblePostIndexingOnly: safetyPolicy.allowVisiblePostIndexingOnly,
      autoScrollAllowed: safetyPolicy.allowAutoScroll,
      hiddenScrapingAllowed: safetyPolicy.allowHiddenScraping
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

    res.json({
      ok: true,
      elasticsearch: {
        node: ELASTICSEARCH_NODE,
        clusterName: info.cluster_name,
        version: info.version?.number,
        status: health.status,
        numberOfNodes: health.number_of_nodes
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

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: "Route not found.",
    path: req.path
  });
});

app.listen(PORT, () => {
  console.log(`FindE AI backend running on http://localhost:${PORT}`);
  console.log(`Elasticsearch node: ${ELASTICSEARCH_NODE}`);
});
