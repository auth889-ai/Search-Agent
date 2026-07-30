# FindE AI — Community + Web Search Agent

A semantic search **agent** that finds the *exact meaning* match (not just keyword
match) across community posts (Facebook/LinkedIn groups) and the web — in
**English and Bengali** — ranks every result by a **fit score**, and returns a
**grounded answer with citations**.

**Positioning:** Facebook's own group search is per-group, English-optimized and
engagement-ranked. FindE is the opposite — *your* cross-group corpus, bilingual
bn+en retrieval, answer-my-question ranking, deadline-aware. It's not a search
box; it's a **personal opportunity radar** for the Bangladeshi student community,
and (as of 2026) no shipped product occupies this niche.

Built as a Chrome extension + Node/Express backend + Elasticsearch, with a
deterministic multi-agent pipeline (Planner → Router → Retriever → Verifier →
Composer). No paid API keys required — semantic embeddings run **locally**.

![FindE AI architecture](docs/architecture.png)

---

## 📊 Results (measured, not vibes)

Retrieval quality on the golden eval set (`server/eval/golden.json` — bilingual
EN/BN queries incl. cross-language, paraphrase, and buried-detail cases), run
through the **real production pipeline**:

| Pipeline | hit@1 | hit@5 | MRR | recall@10 | nDCG@10 | avg latency |
|---|---|---|---|---|---|---|
| Pure local (`--no-llm`, zero API keys) | 93% | **100%** | 0.964 | 100% | 0.978 | **~90ms** |
| Full (LLM understanding + rerank) | **100%** | 100% | 1.000 | 100% | 1.000 | ~1–2s |

The full pipeline puts the correct post at **rank 1 for every query** —
including Bengali→English (`q2_bn_to_en`), English→Bengali (`q3_en_to_bn`,
`q11_rent_en_to_bn_area`) and details buried deep inside long posts (`q12`,
`q13`). The zero-key local pipeline gets 13/14 at rank 1 (the one miss is a
cross-language query at rank 2 — exactly the case the LLM translation layer
exists for) at ~90ms per query.

Reproduce it yourself (Elasticsearch must be running):

```bash
cd server
node eval/eval.js --no-llm          # pure local pipeline
node eval/eval.js                   # with LLM query understanding
node eval/eval.js --save-baseline   # store as regression baseline
```

Every later run auto-compares against the saved baseline and exits non-zero on
regression — run it after **every** ranking change.

### Screenshots

Real captures from the running app (`/app` dashboard):

**Hybrid search** — ranked results with fit ring, meaning/keyword/trust breakdown
and "why this ranks here":

![Search results](docs/screenshots/search-results.png)

**Agent mode** — grounded LLM answer with inline citations, key points,
follow-up chips and a full reasoning trace:

![Agent answer](docs/screenshots/agent-answer.png)

> Tip: results pages are now shareable links — `/app/?q=your+query&agent=1`
> auto-runs the search on load.

---

## How the ranking works

```
query ──┬─ LLM query understanding (Groq, optional) ──> EN/BN translations + keywords
        │        runs IN PARALLEL with ↓ (never blocks retrieval)
        ├─ local embedding (multilingual-e5-small, 384-dim, on-device ONNX)
        │
        ├─ wave 1: BM25 + kNN on the original query        (fires immediately)
        ├─ wave 2: BM25 + kNN per LLM variant (≤4 total)   (cross-language recall)
        │
        ├─ weighted RRF fusion (k=60) — chunk hits collapse to parent post,
        │    best-matching CHUNK is remembered for scoring & snippets
        ├─ MMR diversification (λ=0.7)
        ├─ fit score = semantic similarity × fusion rank × trust/freshness nudge
        └─ cross-encoder rerank (Cohere rerank-v3.5, optional) on EVERY search
```

Key properties:

- **Dynamic, not hardcoded** — the LLM (not regex rules) detects intent,
  translates the query both ways, and **decomposes compound questions into
  sub-queries** that each get their own retrieval leg in the fusion.
- **Reflect & retry** — if the agent's first retrieval comes back weak, it asks
  the LLM to reformulate the query from a different angle and retrieves again,
  merging both result sets (visible in the reasoning trace as `reflect_retry`).
- **Chunk-aware scoring** — a query matching paragraph 5 of a long post is
  scored against *that paragraph's* vector and shows *that passage* as the
  snippet, not the post's opening.
- **Bilingual BM25** — every text field is indexed three ways: exact
  (`standard`+asciifolding), `.en` (English analyzer, porter stemming) and
  `.bn` (built-in Bengali analyzer: indic normalization + Bengali stemmer), so
  `internships` matches `internship` and Bengali morphology actually tokenizes.
- **Trust & freshness live in the ranking** (±~10% nudge) — official sources
  and recent posts win ties; meaning still dominates.
- **Honest metadata** — web results keep their *real* publish date (or none);
  unknown dates get neutral freshness instead of pretending to be new.
- **Graceful degradation everywhere** — no Groq key? no Cohere key? offline?
  Every stage no-ops safely and search keeps working on the free local stack.
- **Data flywheel** — every result click/save is logged (`POST /api/feedback`,
  its own ES index) and feeds a **personal profile vector** (weighted centroid
  of what you clicked/saved) that nudges ranking toward your demonstrated
  interests (capped ±4%; relevance always dominates). The same log becomes the
  training set for learning-to-rank (native in Elasticsearch since 8.13) once
  enough interactions accumulate.
- **Opportunity radar** — `GET /api/digest` returns everything in your corpus
  with a deadline in the next N days, urgency-tagged (`critical`/`soon`/
  `upcoming`), soonest first. Search answers what you ask; the digest surfaces
  what you'd regret missing without asking.

**Semantic engine:** `Xenova/multilingual-e5-small` (100+ languages, 384-dim,
asymmetric `query:`/`passage:` prefixes) via `@xenova/transformers`, running
fully on-device — free, offline, deterministic.

---

## Architecture (maps to the design diagram)

| Stage | Component | Tech |
|------|-----------|------|
| 1. UI | Chrome extension (`extension/`) | MV3 popup + content script |
| 2. Sources | Visible community posts, web search, saved sources | Facebook/LinkedIn (visible-only), Tavily |
| 3. Ingest | Clean → tag → chunk → **embed (batched)** → dedupe/repost-merge → trust signals | `services/ingestion.service.js`, `embedding.service.js` |
| 4. Search & storage | **Hybrid semantic (kNN) + bilingual BM25 → RRF → MMR → rerank** | Elasticsearch `dense_vector` + `bengali`/`english` analyzers |
| 5. Agent team | Plan → retrieve → web-expand → verify → compose | `services/agent.service.js` |
| 6. Output | Fit score, why-relevant, citations, next actions | JSON API + popup cards |

---

## Quick start

```bash
# 0. install (from finde-ai/)
npm run install:all       # or: npm install

# 1. start Elasticsearch (Docker Desktop must be running)
npm run elastic:up

# 2. create indices (dense_vector + bilingual analyzers) and seed demo data
npm run create-indices
npm run seed              # first run downloads the ~120MB embedding model once

# 3. run the backend
npm --prefix server start   # http://localhost:8080

# 4. test + evaluate
npm test                  # extension: extraction core + FB/LinkedIn adapters (jsdom)
npm --prefix server test
node server/eval/eval.js --no-llm
```

> Upgrading an existing install? Recreate the indices (or add the `.bn`/`.en`
> subfields) and re-run `elastic/scripts/reembed.js` to activate the bilingual
> mapping on old data.

### Load the Chrome extension
1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Make sure the backend is running (`http://localhost:8080`)
5. Click the FindE AI icon → **Search**, or open a Facebook/LinkedIn group and
   use **Read visible posts** to add the visible posts to your searchable memory.
6. For bulk collection, hit **Start live capture** and just scroll — every post
   that crosses your screen is extracted, deduped and indexed in the background.

#### Platform extraction

Facebook and LinkedIn ship completely different markup, so each has its own
adapter in `extension/platforms.js` behind one shared interface; `content.js`
stays platform-blind and `extract-core.js` holds the pure text filtering.

| | Facebook | LinkedIn |
|---|---|---|
| Post container | `[role="article"]` (outermost) | `[data-urn*="urn:li:activity"]`, `.feed-shared-update-v2` |
| Body | many `div[dir="auto"]` leaf blocks, joined in reading order | `.update-components-text` |
| Comments excluded | nested `[role="article"]` | `.comments-comment-*` entities |
| Identity | story/permalink URL | `urn:li:activity` / `urn:li:ugcPost` URN |
| Quirk handled | obfuscated classes, alt-text runs | every label rendered twice (visually-hidden + aria-hidden) |

Both sites rewrite their DOM often, so every lookup is a layered fallback
(exact class → class-substring → structural guess): a rename degrades one field
instead of returning zero posts. Post identity is the permalink when available
and text only as a fallback, so two different posts with identical wording are
never collapsed into one.

`npm test` runs these adapters against jsdom fixtures shaped like the real
markup, including the comment-pollution and duplicate-label cases.

---

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET  | `/api/health` | status + capabilities |
| POST | `/api/search` | hybrid search with fit scores + optional rerank |
| POST | `/api/agent/ask` | full agent pipeline → grounded answer + citations + trace |
| POST | `/api/match` | LLM-judge match of live-captured posts |
| POST | `/api/posts/index` | index visible community posts (bulk) |
| POST | `/api/web/search` | live web search (Tavily) + cache |

Example:
```bash
curl -X POST http://localhost:8080/api/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query":"remote internship for beginners","sourceMode":"all","useWeb":true}'
```

---

## Roadmap (researched, prioritized)

1. **Grow the golden set to 100+ queries** via LLM-judge labeling with pooled
   candidates (BM25-only / dense-only / hybrid), human spot-check ~50 labels.
2. **Local cross-encoder fallback** — `onnx-community/bge-reranker-v2-m3-ONNX`
   (Apache-2.0, Bengali-capable, q8) reranking top 10–15 when no Cohere key.
3. **Embedding upgrade** — `EmbeddingGemma-300m` @ 512-dim (Matryoshka),
   validated against the eval baseline before reindexing.
4. **SSE streaming** so answers render token-by-token instead of one blob.
5. **Native ES retrievers** — server-side RRF (`rrf` retriever) once on ES ≥8.16
   (current compose file pins 8.15.3).

## Safety

- Indexes **only posts already visible** on screen when the user clicks.
- **No** auto-scroll, **no** hidden/private content, **no** login bypass, **no**
  background scraping. Flags in `.env` (`ALLOW_*`) enforce this server-side.

## Configuration (`.env`)

Copy `.env.example` → `.env`. All keys are optional:
- `GROQ_API_KEY` — LLM query understanding (cross-language variants) + answers.
- `COHERE_API_KEY` — cross-encoder reranking on every search.
- `TAVILY_API_KEY` — live web search (otherwise community/saved only).
- Semantic search itself needs **no key** (local model).

> ⚠️ Never commit `.env` (it is git-ignored). Rotate any key that has been shared.
