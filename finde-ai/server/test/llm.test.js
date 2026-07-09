/**
 * Unit tests for the optional LLM composer layer.
 * Verifies safe fallback (no key => disabled, chat returns null, never throws).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { llmEnabled, llmInfo, chat } from "../services/llm.service.js";

function clearKeys() {
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
}

test("llmEnabled is false and info reports disabled without keys", () => {
  const prevG = process.env.GROQ_API_KEY;
  const prevO = process.env.OPENROUTER_API_KEY;
  clearKeys();
  assert.equal(llmEnabled(), false);
  assert.deepEqual(llmInfo(), { enabled: false });
  if (prevG !== undefined) process.env.GROQ_API_KEY = prevG;
  if (prevO !== undefined) process.env.OPENROUTER_API_KEY = prevO;
});

test("llmInfo reports provider/model when a key is present", () => {
  const prevG = process.env.GROQ_API_KEY;
  clearKeys();
  process.env.GROQ_API_KEY = "test-key";
  const info = llmInfo();
  assert.equal(info.enabled, true);
  assert.equal(info.provider, "groq");
  assert.ok(info.model.includes("llama"));
  clearKeys();
  if (prevG !== undefined) process.env.GROQ_API_KEY = prevG;
});

test("chat returns null (no throw) when no key is configured", async () => {
  const prevG = process.env.GROQ_API_KEY;
  const prevO = process.env.OPENROUTER_API_KEY;
  clearKeys();
  const out = await chat([{ role: "user", content: "hi" }]);
  assert.equal(out, null);
  if (prevG !== undefined) process.env.GROQ_API_KEY = prevG;
  if (prevO !== undefined) process.env.OPENROUTER_API_KEY = prevO;
});
