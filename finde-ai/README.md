# FindE AI — Community + Web Search Agent

A semantic search **agent** that finds the *exact meaning* match (not just keyword
match) across community posts (Facebook/LinkedIn groups) and the web, ranks every
result by a **fit score**, and returns a **grounded answer with citations**.

Built as a Chrome extension + Node/Express backend + Elasticsearch, with a
deterministic multi-agent pipeline (Planner → Router → Retriever → Verifier →
Composer). No paid API keys required — semantic embeddings run **locally**.

---

## Architecture (maps to the design diagram)

| Stage | Component | Tech |
|------|-----------|------|
| 1. UI | Chrome extension (`extension/`) | MV3 popup + content script |
| 2. Sources | Visible community posts, web search, saved sources | Facebook/LinkedIn (visible-only), Tavily |
| 3. Ingest | Clean → tag → **embed** → trust signals | `services/ingestion.service.js`, `embedding.service.js` |
| 4. Search & storage | **Hybrid semantic (kNN) + keyword (BM25)** | Elasticsearch `dense_vector` |
| 5. Agent team | Plan → retrieve → verify → compose | `services/agent.service.js` |
| 6. Output | Fit score, why-relevant, citations, next actions | JSON API + popup cards |

**Semantic engine:** `all-MiniLM-L6-v2` (384-dim) via `@xenova/transformers`,
running fully on-device — free, offline, deterministic. Cosine similarity in
Elasticsearch gives the *meaning* score; BM25 gives the *keyword* score; the two
are blended into the **fit score** (`0.7·semantic + 0.3·keyword`).

---

## Quick start

```bash
# 0. install (from finde-ai/)
npm run install:all       # or: npm install

# 1. start Elasticsearch (Docker Desktop must be running)
npm run elastic:up

# 2. create indices (with the dense_vector field) and seed demo data
npm run create-indices
npm run seed              # first run downloads the ~90MB embedding model once

# 3. run the backend
npm --prefix server start   # http://localhost:8080

# 4. test end-to-end
npm --prefix server test
```

### Load the Chrome extension
1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Make sure the backend is running (`http://localhost:8080`)
5. Click the FindE AI icon → **Search**, or open a Facebook/LinkedIn group and
   use **Index posts** to add the visible posts to your searchable memory.

---

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET  | `/api/health` | status + capabilities |
| POST | `/api/search` | hybrid semantic+keyword search with fit scores |
| POST | `/api/agent/ask` | full agent pipeline → grounded answer + citations + trace |
| POST | `/api/posts/index` | index visible community posts (bulk) |
| POST | `/api/web/search` | live web search (Tavily) + cache |

Example:
```bash
curl -X POST http://localhost:8080/api/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query":"remote internship for beginners","sourceMode":"all","useWeb":true}'
```

---

## Safety

- Indexes **only posts already visible** on screen when the user clicks.
- **No** auto-scroll, **no** hidden/private content, **no** login bypass, **no**
  background scraping. Flags in `.env` (`ALLOW_*`) enforce this.

## Configuration (`.env`)

Copy `.env.example` → `.env`. Keys are optional:
- `TAVILY_API_KEY` — enables live web search (otherwise community/saved only).
- Semantic search needs **no key** (local model).

> ⚠️ Never commit `.env` (it is git-ignored). Rotate any key that has been shared.
