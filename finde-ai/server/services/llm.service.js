/**
 * Optional LLM layer for FindE AI (OpenAI-compatible chat completions).
 *
 * Prefers Groq (free & fast), falls back to OpenRouter. Fully optional: with no
 * key, chat() returns null and callers keep the free extractive answer. Any
 * network/API error also returns null — the agent must never break because the
 * LLM was unavailable.
 */
const PROVIDERS = [
  {
    name: "groq",
    keyEnv: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    modelEnv: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile"
  },
  {
    name: "openrouter",
    keyEnv: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: "meta-llama/llama-3.3-70b-instruct"
  }
];

function activeProvider() {
  return PROVIDERS.find((p) => process.env[p.keyEnv]);
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
export async function chat(messages, { temperature = 0.2, maxTokens = 600 } = {}) {
  const p = activeProvider();
  if (!p) return null;

  const model = process.env[p.modelEnv] || p.defaultModel;
  try {
    const res = await fetch(p.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env[p.keyEnv]}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${p.name} ${res.status}: ${body.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return { text, provider: p.name, model };
  } catch (error) {
    console.error(`[llm] ${error.message}`);
    return null;
  }
}
