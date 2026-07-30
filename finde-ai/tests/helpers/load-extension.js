/**
 * Load the extension's content-script modules into a jsdom window.
 *
 * extract-core.js and platforms.js are plain IIFEs that attach to globalThis,
 * so evaluating them inside a jsdom window gives us the real adapters running
 * against a real DOM — no mocking of querySelector/closest.
 *
 * NOTE: jsdom does not implement innerText, so readText() falls through to
 * textContent. That is deliberate coverage: textContent produces LinkedIn's
 * "NameName" concatenated duplication, which stripDuplicatedHalf must handle
 * just as it handles the "Name\nName" form innerText produces in Chrome.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const EXT = new URL("../../extension/", import.meta.url);

function source(file) {
  return readFileSync(new URL(file, EXT), "utf8");
}

export function loadExtension(html = "<!doctype html><body></body>", url = "https://www.facebook.com/groups/1") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.eval(source("extract-core.js"));
  dom.window.eval(source("platforms.js"));
  return dom.window;
}

/** Just the pure helpers — no DOM fixture needed. */
export function loadCore() {
  return loadExtension().FindEExtract;
}

const ON_SCREEN = { width: 600, height: 200, top: 10, bottom: 210, left: 0, right: 600, x: 0, y: 10 };

/**
 * Load the FULL content script, with the two browser APIs it depends on stubbed:
 *
 *  - chrome.runtime — captures the registered onMessage listener so tests can
 *    drive the real message bridge, and records live-capture batches.
 *  - getBoundingClientRect — jsdom has no layout engine and returns 0x0 for
 *    every element, which would make isVisible() reject every post. We report a
 *    plausible on-screen rect so visibility filtering is exercised rather than
 *    short-circuited.
 */
export function loadContentScript(html, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const win = dom.window;

  win.Element.prototype.getBoundingClientRect = () => ({ ...ON_SCREEN });

  const listeners = [];
  const sentToBackground = [];
  win.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg) => sentToBackground.push(msg)
    }
  };

  win.eval(source("extract-core.js"));
  win.eval(source("platforms.js"));
  win.eval(source("content.js"));

  // Drive the real chrome.runtime.onMessage bridge.
  const send = (type) =>
    new Promise((resolve) => {
      for (const fn of listeners) fn({ type }, {}, resolve);
    });

  return { win, send, sentToBackground };
}
