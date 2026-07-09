/* FindE AI dashboard logic. Served same-origin from the backend at /app. */

const API = location.origin.includes("localhost") || location.origin.includes("127.0.0.1")
  ? location.origin
  : "http://localhost:8080";

let currentSource = "all";
const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */
function fitColor(fit) {
  if (fit >= 70) return "#2eb872";
  if (fit >= 45) return "#e0a13a";
  return "#d75a5a";
}
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function safeSnippet(s) {
  return esc(s).replace(/&lt;mark&gt;/g, "<mark>").replace(/&lt;\/mark&gt;/g, "</mark>");
}
function citeMarkup(text) {
  // Turn [1], [2] into styled chips.
  return esc(text).replace(/\[(\d+)\]/g, '<span class="cite">$1</span>');
}
function ring(el, pct, color, label) {
  el.style.background = `conic-gradient(${color} ${pct}%, #ecebe6 ${pct}%)`;
  el.querySelector("span").textContent = label != null ? label : `${pct}%`;
}

async function api(path, options) {
  const res = await fetch(`${API}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

/* ---------- status + capabilities ---------- */
async function loadStatus() {
  try {
    const h = await api("/api/health");
    const e = h.elastic || {};
    $("statCommunity").textContent = e.communityDocs ?? 0;
    $("statWeb").textContent = e.webDocs ?? 0;
    $("statSaved").textContent = e.savedDocs ?? 0;
    $("statTotal").textContent = (e.communityDocs || 0) + (e.webDocs || 0) + (e.savedDocs || 0);

    const cap = h.capabilities || {};
    setCap("capSemantic", true); // always on (local model)
    setCap("capLlm", cap.geminiConfigured || cap.llmConfigured || false);
    setCap("capRerank", cap.rerankConfigured || false);
    setCap("capWeb", cap.tavilyWebSearch || cap.googleWebSearchConfigured || false);

    const online = e.reachable;
    $("statusDot").className = `status-dot ${online ? "online" : "offline"}`;
    $("statusText").textContent = online ? "backend online" : "Elasticsearch offline";
  } catch {
    $("statusDot").className = "status-dot offline";
    $("statusText").textContent = "backend offline";
  }
}
function setCap(id, on) {
  $(id).className = `cap-dot ${on ? "on" : "off"}`;
}

/* ---------- render ---------- */
function resultCard(r) {
  const fit = r.fitScore ?? 0;
  const snippet = (r.matchedSnippets && r.matchedSnippets[0]) || r.snippet || (r.text || "").slice(0, 200);
  const source = r.groupName || r.siteName || r.domain || r.sourceType;
  return `
    <div class="result-card">
      <div class="result-top">
        <div class="fit-ring" style="background: conic-gradient(${fitColor(fit)} ${fit}%, #ecebe6 ${fit}%)"><span>${fit}%</span></div>
        <div style="min-width:0;flex:1">
          <div class="result-title">${esc(r.title)}</div>
          <div class="result-sub">${esc(source)}${r.date ? " · " + esc(String(r.date).slice(0, 10)) : ""}</div>
          <div class="result-snippet">${safeSnippet(snippet)}</div>
          ${r.whyRelevant ? `<div class="result-why">${esc(r.whyRelevant)}</div>` : ""}
          <div class="result-foot">
            <div class="pills">
              ${r.semanticFit != null ? `<span class="pill meaning">meaning ${r.semanticFit}%</span>` : ""}
              <span class="pill">keyword ${r.keywordFit ?? 0}%</span>
              <span class="pill">trust ${r.confidence ?? 0}%</span>
              ${r.rerankScore != null ? `<span class="pill rerank">rerank ${r.rerankScore}%</span>` : ""}
            </div>
            ${r.url ? `<a class="open-link" href="${esc(r.url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}
          </div>
        </div>
      </div>
    </div>`;
}

function renderResults(results) {
  $("resultsHead").classList.toggle("hidden", results.length === 0);
  $("results").innerHTML = results.map(resultCard).join("");
}

function renderAnswer(data) {
  const card = $("answerCard");
  card.classList.remove("hidden");
  const conf = data.confidence ?? 0;
  ring($("answerRing"), conf, fitColor(conf), `${conf}%`);
  $("answerKicker").textContent =
    data.answerMode === "llm_grounded" ? "Grounded answer · LLM" : "Grounded answer";
  $("answerIntent").textContent =
    `intent: ${data.intent} · ${data.neuralRerank ? "neural-reranked · " : ""}${data.tookMs}ms`;
  $("answerText").innerHTML = citeMarkup(data.answer);

  $("citations").innerHTML = (data.citations || [])
    .map(
      (c) => `<a class="citation" href="${esc(c.url) || "#"}" target="_blank" rel="noopener">
        <span class="num">${c.ref}</span>
        <span class="ctitle">${esc(c.title)}</span>
        <span style="color:var(--ink-3)">${c.fitScore}%</span>
      </a>`
    )
    .join("");

  $("nextActions").innerHTML = (data.nextActions || [])
    .map((a) => `<div class="next-action">${esc(a)}</div>`)
    .join("");

  $("traceList").innerHTML = (data.trace || [])
    .map(
      (t) => `<div class="trace-step"><span class="trace-agent">${esc(t.agent)}</span><span class="trace-detail">${esc(t.detail)}</span></div>`
    )
    .join("");
}

/* ---------- run ---------- */
async function run() {
  const query = $("queryInput").value.trim();
  if (!query) return;
  const useAgent = $("agentMode").checked;
  const useWeb = $("webMode").checked;

  $("emptyState").classList.add("hidden");
  $("answerCard").classList.add("hidden");
  $("searchBtn").disabled = true;
  $("mainTitle").textContent = useAgent ? "Agent" : "Search";
  $("resultsHead").classList.add("hidden");
  $("results").innerHTML = `<div class="skeleton">${'<div class="skel-card"></div>'.repeat(3)}</div>`;

  try {
    if (useAgent) {
      const data = await api("/api/agent/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, sourceMode: currentSource, useWeb, limit: 8 })
      });
      renderAnswer(data);
      renderResults(data.results || []);
      if (data.webAdded) loadStatus();
    } else {
      const data = await api("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, sourceMode: currentSource, limit: 10 })
      });
      renderResults(data.results || []);
      if (!data.results.length) {
        $("results").innerHTML = `<div class="empty-state"><h2>No matches</h2><p>Try different words, switch source, or index more posts.</p></div>`;
      }
    }
  } catch (error) {
    $("results").innerHTML = `<div class="error-box"><strong>${esc(error.message)}</strong><br/>Is the backend running at ${esc(API)}? Start it with <code>npm --prefix server start</code>.</div>`;
  } finally {
    $("searchBtn").disabled = false;
  }
}

/* ---------- wiring ---------- */
$("sourceList").addEventListener("click", (e) => {
  const item = e.target.closest(".source-item");
  if (!item) return;
  document.querySelectorAll(".source-item").forEach((i) => i.classList.remove("active"));
  item.classList.add("active");
  currentSource = item.dataset.source;
});
$("searchBtn").addEventListener("click", run);
$("queryInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});

loadStatus();
$("queryInput").focus();
