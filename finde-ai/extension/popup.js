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

/* ---------- read visible posts ---------- */

/**
 * Ask the content script for the posts on screen.
 *
 * There is exactly ONE extractor (content.js + platforms.js). The popup used to
 * carry a second, weaker inline copy that hardcoded platform:"facebook" — so
 * LinkedIn captures were mislabelled and got none of the per-platform logic.
 * Now the popup only messages the content script, injecting it on demand if the
 * tab was opened before the extension loaded.
 */
async function requestPostsFromTab(tabId) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: "FINDE_EXTRACT_POSTS" });

  try {
    return await ask();
  } catch {
    // Not injected yet (tab predates the extension, or was just reloaded).
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["extract-core.js", "platforms.js", "content.js"]
    });
    return await ask();
  }
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

    const out = (await requestPostsFromTab(tab.id)) || { posts: [], stats: {} };
    capturedPosts = out.posts || [];

    if (!capturedPosts.length) {
      const stats = out.stats || {};
      const where = stats.platform === "linkedin" ? "LinkedIn" : "Facebook";
      // Distinguish "found nothing at all" (wrong page / stale selectors) from
      // "found posts but none had readable text yet" (user needs to scroll).
      preview.innerHTML = stats.containers
        ? `<div class="empty">Found ${stats.containers} ${where} post block(s) but no readable text yet. Scroll so full posts (with text) are on screen, then try again.</div>`
        : `<div class="empty">No ${where} posts detected on screen. Open a group or feed and scroll until posts are visible, then try again.</div>`;
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

/* ---------- live capture (user turns on, user scrolls) ---------- */

// Send a live-capture command, injecting the content script if the tab predates
// the extension. Mirrors requestPostsFromTab's inject-then-retry.
async function liveCommand(tabId, type) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["extract-core.js", "platforms.js", "content.js"]
    });
    return await chrome.tabs.sendMessage(tabId, { type });
  }
}

function renderLive(state) {
  const btn = $("liveBtn");
  const status = $("liveStatus");
  if (!state) {
    btn.textContent = "▶︎ Start live capture";
    status.textContent = "Open a Facebook or LinkedIn tab to use live capture.";
    return;
  }
  btn.textContent = state.active ? "⏸ Stop live capture" : "▶︎ Start live capture";
  btn.classList.toggle("active", Boolean(state.active));
  const indexed = state.indexed ? ` · ${state.indexed} indexed` : "";
  status.textContent = state.active
    ? `● Capturing — scroll normally. ${state.captured || 0} post(s) seen${indexed}.`
    : state.captured
      ? `Off — ${state.captured} post(s) captured this session${indexed}.`
      : "Off — turn on, then scroll normally. Every post you actually see gets saved and indexed in the background.";
}

async function currentSocialTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /facebook\.com|linkedin\.com/.test(tab.url || "") ? tab : null;
}

async function refreshLiveStatus() {
  const tab = await currentSocialTab();
  if (!tab) return renderLive(null);
  try {
    const state = await liveCommand(tab.id, "FINDE_LIVE_STATUS");
    const { liveStats } = await chrome.storage.local.get("liveStats");
    renderLive({ ...state, indexed: liveStats?.indexed || 0 });
  } catch {
    renderLive(null);
  }
}

async function toggleLive() {
  const tab = await currentSocialTab();
  if (!tab) return renderLive(null);
  const btn = $("liveBtn");
  btn.disabled = true;
  try {
    const current = await liveCommand(tab.id, "FINDE_LIVE_STATUS");
    const next = current?.active ? "FINDE_LIVE_STOP" : "FINDE_LIVE_START";
    const state = await liveCommand(tab.id, next);
    const { liveStats } = await chrome.storage.local.get("liveStats");
    renderLive({ ...state, indexed: liveStats?.indexed || 0 });
  } catch (error) {
    $("liveStatus").textContent = `Could not toggle live capture: ${error.message}`;
  } finally {
    btn.disabled = false;
  }
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
  $("liveBtn").addEventListener("click", toggleLive);
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
  refreshLiveStatus();
  $("queryInput").focus();
}

init();
