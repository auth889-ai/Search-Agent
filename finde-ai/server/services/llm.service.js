/**
 * Optional LLM layer for FindE AI.
 *
 * Provider chain: Gemini (Google — the hackathon's required model family)
 * → Groq → OpenRouter. First provider with a key wins. Fully optional: with no
 * key, chat() returns null and callers keep the free extractive answer. Any
 * network/API error also returns null — the agent must never break because the
 * LLM was unavailable.
 *
 * Gemini speaks its own REST dialect (contents/parts + systemInstruction);
 * Groq/OpenRouter are OpenAI-compatible. chat() hides the difference.
 */
const PROVIDERS = [
  {
    name: "gemini",
    kind: "gemini",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-2.5-flash"
  },
  {
    name: "groq",
    kind: "openai",
    keyEnv: ["GROQ_API_KEY"],
    url: "https://api.groq.com/openai/v1/chat/completions",
    modelEnv: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile"
  },
  {
    name: "openrouter",
    kind: "openai",
    keyEnv: ["OPENROUTER_API_KEY"],
    url: "https://openrouter.ai/api/v1/chat/completions",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: "meta-llama/llama-3.3-70b-instruct"
  }
];

function providerKey(p) {
  for (const env of p.keyEnv) {
    if (process.env[env]) return process.env[env];
  }
  return null;
}

function activeProvider() {
  return PROVIDERS.find((p) => providerKey(p));
}

/* Convert OpenAI-style messages to a Gemini generateContent request body. */
function toGeminiBody(messages, { temperature, maxTokens }) {
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => ({ text: m.content }));
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens }
  };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };
  return body;
}

export function llmEnabled() {
  return Boolean(activeProvider());
}

export function llmInfo() {
  const p = activeProvider();
  if (!p) return { enabled: false };
  return {
    enabled: true,
    provider: p.name,
    model: process.env[p.modelEnv] || p.defaultModel
  };
}

/**
 * Run a chat completion. Returns { text, provider, model } or null.
 */
export async function chat(
  messages,
  { temperature = 0.2, maxTokens = 600, timeoutMs: timeoutOverride } = {}
) {
  const p = activeProvider();
  if (!p) return null;

  const model = process.env[p.modelEnv] || p.defaultModel;
  const key = providerKey(p);
  const timeoutMs = Number(
    timeoutOverride || process.env.LLM_TIMEOUT_MS || 12000
  );

  const isGemini = p.kind === "gemini";
  const url = isGemini
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
    : p.url;
  const headers = isGemini
    ? { "x-goog-api-key": key, "Content-Type": "application/json" }
    : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const body = isGemini
    ? toGeminiBody(messages, { temperature, maxTokens })
    : { model, messages, temperature, max_tokens: maxTokens };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body)
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`${p.name} ${res.status}: ${errBody.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = isGemini
      ? data?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim()
      : data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return { text, provider: p.name, model };
  } catch (error) {
    console.error(`[llm] ${error.message}`);
    return null;
  }
}
