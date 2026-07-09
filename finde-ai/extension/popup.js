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

/* ---------- index visible posts ---------- */
async function readVisiblePosts() {
  const preview = $("capturePreview");
  const indexBtn = $("indexBtn");
  const result = $("indexResult");
  result.innerHTML = "";
  preview.innerHTML = `<div class="loading">Reading visible posts…</div>`;
  indexBtn.classList.add("hidden");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/facebook\.com|linkedin\.com/.test(tab.url || "")) {
      preview.innerHTML = `<div class="error-box">Open a Facebook or LinkedIn page first, then try again.</div>`;
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "FINDE_EXTRACT_POSTS"
    });

    capturedPosts = response?.posts || [];
    if (!capturedPosts.length) {
      preview.innerHTML = `<div class="empty">No visible posts found. Scroll so posts are on screen, then try again.</div>`;
      return;
    }

    preview.innerHTML = "";
    capturedPosts.slice(0, 5).forEach((p) => {
      const el = document.createElement("div");
      el.className = "capture-item";
      el.textContent = p.text.slice(0, 130) + (p.text.length > 130 ? "…" : "");
      preview.appendChild(el);
    });
    const count = document.createElement("div");
    count.className = "capture-count";
    count.textContent = `${capturedPosts.length} visible post(s) ready to index`;
    preview.appendChild(count);

    indexBtn.textContent = `Index ${capturedPosts.length} post(s)`;
    indexBtn.classList.remove("hidden");
  } catch (error) {
    preview.innerHTML = `<div class="error-box">Could not read the page: ${escapeHtml(error.message)}. Reload the Facebook tab and retry.</div>`;
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
  $("apiBaseInput").addEventListener("change", async (e) => {
    apiBase = e.target.value.trim().replace(/\/$/, "") || DEFAULT_API;
    await chrome.storage.local.set({ apiBase });
    checkStatus();
  });

  checkStatus();
  $("queryInput").focus();
}

init();
