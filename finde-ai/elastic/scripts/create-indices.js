import dotenv from "dotenv";
import { Client } from "@elastic/elasticsearch";

dotenv.config({ path: "../.env" });
dotenv.config({ path: "../.env.example" });

const ELASTICSEARCH_NODE = process.env.ELASTICSEARCH_NODE || "http://localhost:9200";

const COMMUNITY_POSTS_INDEX =
  process.env.COMMUNITY_POSTS_INDEX || "finde_community_posts";
const WEB_SOURCES_INDEX =
  process.env.WEB_SOURCES_INDEX || "finde_web_sources";
const USER_KNOWLEDGE_INDEX =
  process.env.USER_KNOWLEDGE_INDEX || "finde_user_knowledge";

const elastic = new Client({
  node: ELASTICSEARCH_NODE
});

const commonAnalysis = {
  analyzer: {
    finde_text_analyzer: {
      type: "custom",
      tokenizer: "standard",
      filter: ["lowercase", "asciifolding"]
    }
  }
};

const baseProperties = {
  docId: { type: "keyword" },
  sourceType: { type: "keyword" },
  title: {
    type: "text",
    analyzer: "finde_text_analyzer",
    fields: {
      keyword: { type: "keyword", ignore_above: 256 }
    }
  },
  text: {
    type: "text",
    analyzer: "finde_text_analyzer"
  },
  snippet: {
    type: "text",
    analyzer: "finde_text_analyzer"
  },
  url: { type: "keyword" },
  date: { type: "date", ignore_malformed: true },
  indexedAt: { type: "date" },
  language: { type: "keyword" },
  topics: { type: "keyword" },
  tags: { type: "keyword" },
  location: { type: "keyword" },
  deadline: { type: "date", ignore_malformed: true },
  confidence: { type: "float" },
  finalScore: { type: "float" },
  trustSignals: {
    properties: {
      sourceOfficial: { type: "boolean" },
      hasOfficialLink: { type: "boolean" },
      hasDeadline: { type: "boolean" },
      commentCount: { type: "integer" },
      reactionCount: { type: "integer" },
      freshnessScore: { type: "float" },
      trustScore: { type: "float" }
    }
  },
  embeddingText: {
    type: "text",
    analyzer: "finde_text_analyzer"
  }
};

const indexDefinitions = [
  {
    name: COMMUNITY_POSTS_INDEX,
    body: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: commonAnalysis
      },
      mappings: {
        dynamic: true,
        properties: {
          ...baseProperties,
          groupName: { type: "keyword" },
          authorDisplay: { type: "keyword" },
          comments: {
            type: "text",
            analyzer: "finde_text_analyzer"
          },
          platform: { type: "keyword" },
          visibleCaptureOnly: { type: "boolean" }
        }
      }
    }
  },
  {
    name: WEB_SOURCES_INDEX,
    body: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: commonAnalysis
      },
      mappings: {
        dynamic: true,
        properties: {
          ...baseProperties,
          siteName: { type: "keyword" },
          domain: { type: "keyword" },
          displayLink: { type: "keyword" },
          searchQuery: {
            type: "text",
            analyzer: "finde_text_analyzer"
          },
          sourceRank: { type: "integer" }
        }
      }
    }
  },
  {
    name: USER_KNOWLEDGE_INDEX,
    body: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: commonAnalysis
      },
      mappings: {
        dynamic: true,
        properties: {
          ...baseProperties,
          ownerKey: { type: "keyword" },
          savedType: { type: "keyword" },
          notes: {
            type: "text",
            analyzer: "finde_text_analyzer"
          }
        }
      }
    }
  }
];

async function createIndexIfMissing(indexDefinition) {
  const exists = await elastic.indices.exists({ index: indexDefinition.name });

  if (exists) {
    console.log(`Already exists: ${indexDefinition.name}`);
    return;
  }

  await elastic.indices.create({
    index: indexDefinition.name,
    ...indexDefinition.body
  });

  console.log(`Created: ${indexDefinition.name}`);
}

async function main() {
  console.log("FindE AI Elasticsearch setup starting...");
  console.log(`Elasticsearch node: ${ELASTICSEARCH_NODE}`);

  const info = await elastic.info();
  console.log(`Connected to Elasticsearch ${info.version?.number}`);

  for (const indexDefinition of indexDefinitions) {
    await createIndexIfMissing(indexDefinition);
  }

  const health = await elastic.cluster.health();
  console.log(`Cluster health: ${health.status}`);
  console.log("FindE AI indices are ready.");
}

main().catch((error) => {
  console.error("Failed to create FindE AI indices.");
  console.error(error);
  process.exit(1);
});
