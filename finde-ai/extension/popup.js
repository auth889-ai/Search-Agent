/* FindE AI popup logic: search + index-visible-posts, talks to the backend. */

const DEFAULT_API = "http://localhost:8080";
let apiBase = DEFAULT_API;
let currentSource = "all";
let capturedPosts = [];

const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */
function fitColor(fit) {
  if (fit >= 70) return "#2eb872";
  if (fit >= 45) return "#e0a13a";
  return "#d75a5a";
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Allow only our own <mark> highlight tags through; escape everything else.
function safeSnippet(str) {
  return escapeHtml(str)
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

async function apiFetch(path, options) {
  const res = await fetch(`${apiBase}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  return data;
}

/* ---------- status ---------- */
async function checkStatus() {
  const dot = $("statusDot");
  const text = $("statusText");
  try {
    const data = await apiFetch("/api/health");
    const online = data?.elastic?.reachable;
    dot.className = `status-dot ${online ? "online" : "offline"}`;
    text.textContent = online
      ? `online · ${data.elastic.communityDocs + data.elastic.webDocs} docs`
      : "backend up, ES down";
  } catch {
    dot.className = "status-dot offline";
    text.textContent = "backend offline";
  }
}

/* ---------- search ---------- */
function renderResults(data) {
  const wrap = $("results");
  const meta = $("searchMeta");
  const empty = $("searchEmpty");
  wrap.innerHTML = "";
  empty.classList.add("hidden");

  meta.classList.remove("hidden");
  const modeLabel = data.searchMode === "advanced_rrf_mmr"
    ? "hybrid · RRF + rerank"
    : data.searchMode === "hybrid_semantic_keyword"
    ? "hybrid (semantic + keyword)"
    : "keyword";
  meta.innerHTML = `<span class="badge">${escapeHtml(data.intent)}</span> ${data.count} result(s) · ${modeLabel}`;

  if (!data.results.length) {
    wrap.innerHTML = `<div class="empty">No matches found. Try different words or index more posts.</div>`;
    return;
  }

  for (const r of data.results) {
    const fit = r.fitScore ?? 0;
    const color = fitColor(fit);
    const snippet =
      (r.matchedSnippets && r.matchedSnippets[0]) ||
      r.snippet ||
      (r.text || "").slice(0, 180);
    const source = r.groupName || r.siteName || r.domain || r.sourceType;

    const card = document.createElement("div");
    card.className = "result-card";
    card.innerHTML = `
      <div class="result-head">
        <div class="fit-ring" style="background: conic-gradient(${color} ${fit}%, #eeedea ${fit}%)">
          <span>${fit}%</span>
        </div>
        <div style="min-width:0">
          <div class="result-title">${escapeHtml(r.title)}</div>
          <div class="result-sub">${escapeHtml(source)}${r.date ? " · " + escapeHtml(String(r.date).slice(0, 10)) : ""}</div>
        </div>
      </div>
      <div class="result-snippet">${safeSnippet(snippet)}</div>
      ${r.whyRelevant ? `<div class="result-why">${escapeHtml(r.whyRelevant)}</div>` : ""}
      <div class="result-foot">
        <div class="score-pills">
          ${r.semanticFit != null ? `<span class="pill">meaning ${r.semanticFit}%</span>` : ""}
          <span class="pill">keyword ${r.keywordFit ?? 0}%</span>
          <span class="pill">trust ${r.confidence ?? 0}%</span>
        </div>
        ${r.url ? `<a class="result-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}
      </div>
    `;
    wrap.appendChild(card);
  }
}

async function runSearch() {
  const query = $("queryInput").value.trim();
  if (!query) return;
  const btn = $("searchBtn");
  const wrap = $("results");
  btn.disabled = true;
  $("searchEmpty").classList.add("hidden");
  $("searchMeta").classList.add("hidden");
  wrap.innerHTML = `<div class="loading">Searching…</div>`;

  try {
    const data = await apiFetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, sourceMode: currentSource, limit: 8 })
    });
    renderResults(data);
  } catch (error) {
    wrap.innerHTML = `<div class="error-box">${escapeHtml(error.message)}<br/>Is the backend running on ${escapeHtml(apiBase)}?</div>`;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- read visible posts (injected on-demand, no tab reload needed) ---------- */

// This function is serialized and executed INSIDE the Facebook page, so it must
// be fully self-contained (no external references). It scans every post-text
// block on the page (Facebook doesn't wrap every post in a clean article).
function pageExtractPosts() {
  const MAX_POSTS = 60;
  const UI_NOISE = new RegExp(
    "^(see more|see translation|see original|all reactions?|like|love|haha|wow|" +
      "comment|comments|share|shares|follow|following|reply|replies|active now|" +
      "write a comment|view more comments|most relevant|top fan|author|admin|" +
      "moderator|suggested for you|sponsored|· follow|public group|private group|" +
      "join|joined|members|facebook|see original|reels|shop now|learn more)$",
    "i"
  );
  // Group-recommendation cards (not real posts): "Public · 37K members · 70+ posts a day".
  const GROUP_CARD = /(\d[\d.,]*\s*(k|m)?\+?\s*members|posts a day|·\s*(public|private)\b|(public|private)\s*·)/i;
  const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();

  const real = (t) => {
    if (!t || t.length < 25) return false;
    if (UI_NOISE.test(t)) return false;
    const words = t.split(/\s+/).filter((w) => w.length > 1);
    if (words.length < 5) return false;
    const letters = (t.match(/\p{L}/gu) || []).length;
    if (letters / t.length < 0.4) return false;
    const uniq = new Set(words.map((w) => w.toLowerCase()));
    if (uniq.size <= 2 && words.length > 4) return false;
    return true;
  };

  const groupName = clean(document.title).replace(/\s*[|·].*$/i, "") || "Community";
  const blocks = Array.from(document.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
  const seen = new Set();
  const posts = [];

  for (const b of blocks) {
    if (posts.length >= MAX_POSTS) break;
    // Only leaf text blocks (skip wrappers that contain other dir=auto blocks).
    if (b.querySelector('div[dir="auto"], span[dir="auto"]')) continue;

    const t = clean(b.innerText || b.textContent).replace(/\s*See (more|translation|original)\s*$/i, "");
    if (!real(t)) continue;
    // Skip group cards / recommendations (not real posts).
    if (GROUP_CARD.test(t)) continue;

    const key = t.slice(0, 100).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let url = "";
    const scope = b.closest('[role="article"]') || b.parentElement?.parentElement || document;
    const link = scope.querySelector &&
      scope.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="/groups/"]');
    if (link) url = (link.href || "").split("?")[0];

    posts.push({ text: t, url, groupName, platform: "facebook", captureMode: "user_clicked_visible_posts" });
  }
  return { posts, articleCount: document.querySelectorAll('[role="article"]').length };
}

async function readVisiblePosts() {
  const preview = $("capturePreview");
  const indexBtn = $("indexBtn");
  const matchBox = $("matchBox");
  const result = $("indexResult");
  result.innerHTML = "";
  $("matchResults").innerHTML = "";
  preview.innerHTML = `<div class="loading">Reading visible posts…</div>`;
  indexBtn.classList.add("hidden");
  matchBox.classList.add("hidden");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/facebook\.com|linkedin\.com/.test(tab.url || "")) {
      preview.innerHTML = `<div class="error-box">Open a Facebook or LinkedIn group first, then try again.</div>`;
      return;
    }

    // Inject the extractor on demand — works even if the tab was already open.
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageExtractPosts
    });
    const out = injection?.result || { posts: [], articleCount: 0 };
    capturedPosts = out.posts || [];

    if (!capturedPosts.length) {
      preview.innerHTML = `<div class="empty">Found ${out.articleCount} post block(s) but no readable text yet. Scroll so full posts (with text) are on screen, then try again.</div>`;
      return;
    }

    preview.innerHTML = "";
    capturedPosts.slice(0, 4).forEach((p) => {
      const el = document.createElement("div");
      el.className = "capture-item";
      el.textContent = p.text.slice(0, 130) + (p.text.length > 130 ? "…" : "");
      preview.appendChild(el);
    });
    const count = document.createElement("div");
    count.className = "capture-count";
    count.textContent = `✅ Captured ${capturedPosts.length} post(s). Now ask what you want:`;
    preview.appendChild(count);

    matchBox.classList.remove("hidden");
    $("matchInput").focus();
    indexBtn.textContent = `Save ${capturedPosts.length} to memory`;
    indexBtn.classList.remove("hidden");
  } catch (error) {
    preview.innerHTML = `<div class="error-box">Could not read the page: ${escapeHtml(error.message)}.<br/>Make sure you're on a Facebook group tab and try again.</div>`;
  }
}

/* ---------- LLM match on captured posts (the core flow) ---------- */
async function matchInCaptured() {
  const query = $("matchInput").value.trim();
  if (!query || !capturedPosts.length) return;
  const wrap = $("matchResults");
  const btn = $("matchBtn");
  btn.disabled = true;
  wrap.innerHTML = `<div class="loading">Finding your post…</div>`;
  try {
    const data = await apiFetch("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, posts: capturedPosts, limit: 10 })
    });
    if (!data.results.length) {
      wrap.innerHTML = `<div class="empty">No matching post among the ${data.scanned} captured. Scroll for more posts and read again.</div>`;
      return;
    }
    wrap.innerHTML =
      `<div class="match-meta">${data.count} match(es) · ${data.mode === "llm" ? "AI ranked" : "semantic"}</div>` +
      data.results
        .map((r) => {
          const fit = r.fitScore ?? 0;
          const color = fitColor(fit);
          return `<div class="match-card">
            <div class="match-head">
              <span class="match-fit" style="background:${color}">${fit}%</span>
              <div class="match-text">${escapeHtml(r.text)}</div>
            </div>
            ${r.llmReason ? `<div class="match-reason">💡 ${escapeHtml(r.llmReason)}</div>` : ""}
            ${r.url ? `<a class="result-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Open post ↗</a>` : ""}
          </div>`;
        })
        .join("");
  } catch (error) {
    wrap.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function indexPosts() {
  const btn = $("indexBtn");
  const result = $("indexResult");
  btn.disabled = true;
  result.innerHTML = `<div class="loading">Indexing…</div>`;
  try {
    const data = await apiFetch("/api/posts/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: capturedPosts, source: "chrome_extension" })
    });
    result.innerHTML = `<div class="safety-note"><span>✅</span><div>Indexed ${data.accepted} post(s) (${data.rejected} skipped). Total community docs: ${data.totalCommunityDocs}. Now searchable in the Search tab.</div></div>`;
    btn.classList.add("hidden");
    checkStatus();
  } catch (error) {
    result.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- wiring ---------- */
function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`panel-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

function initSourceToggle() {
  $("sourceToggle").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    currentSource = chip.dataset.source;
  });
}

async function init() {
  const stored = await chrome.storage.local.get("apiBase");
  apiBase = stored.apiBase || DEFAULT_API;
  $("apiBaseInput").value = apiBase;

  initTabs();
  initSourceToggle();

  $("searchBtn").addEventListener("click", runSearch);
  $("queryInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  $("readBtn").addEventListener("click", readVisiblePosts);
  $("indexBtn").addEventListener("click", indexPosts);
  $("matchBtn").addEventListener("click", matchInCaptured);
  $("matchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") matchInCaptured();
  });
  $("apiBaseInput").addEventListener("change", async (e) => {
    apiBase = e.target.value.trim().replace(/\/$/, "") || DEFAULT_API;
    await chrome.storage.local.set({ apiBase });
    checkStatus();
  });

  checkStatus();
  $("queryInput").focus();
}

init();
