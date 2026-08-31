import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

// Simulate the iOS WebView: evaluate the shipped universal bundle in a
// context that has web platform globals but NO Node globals (no process, no
// Buffer, and a require that only knows "obsidian"), with Platform.isMobile
// set so the entry dispatcher selects the mobile runtime. Desktop mobile
// emulation cannot catch this class of bug because "process" still exists
// there. NOTE_PI_BUNDLE overrides the artifact under test so the check can
// be red-run against unpatched builds.

const BUNDLE_UNDER_TEST = process.env.NOTE_PI_BUNDLE || join(import.meta.dirname, "..", "main.js");

class StubBase {}

const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2},"modelVersion":"gemini-3.6-flash"}',
  "",
  ""
].join("\r\n");

async function loadMobilePlugin() {
  const fetchCalls = [];
  const webviewFetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(GEMINI_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const obsidianStub = new Proxy({
    Platform: { isMobile: true, isMobileApp: true, isDesktopApp: false, isPhone: false, isTablet: true },
    requestUrl: async () => {
      throw new Error("requestUrl must not be used for Google providers");
    }
  }, {
    get(target, key) {
      return key in target ? target[key] : StubBase;
    }
  });

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    ReadableStream, WritableStream, TransformStream,
    Headers, Request, Response,
    AbortController, AbortSignal,
    crypto, atob, btoa, structuredClone, performance,
    fetch: webviewFetch
    // Deliberately absent: process, Buffer, __dirname, global.
  };
  const context = vm.createContext(sandbox);
  const module = { exports: {} };
  const require = (id) => {
    if (id === "obsidian") return obsidianStub;
    throw new Error("WebView cannot require: " + id);
  };

  const source = readFileSync(BUNDLE_UNDER_TEST, "utf8");
  const wrapped = "(function (module, exports, require) { " + source + "\n})";
  vm.runInContext(wrapped, context)(module, module.exports, require);
  const PluginClass = module.exports.default ?? module.exports;

  const plugin = Object.create(PluginClass.prototype);
  plugin.app = { workspace: {}, vault: { adapter: { read: async () => "" } } };
  plugin.manifest = { id: "note-pi" };
  plugin.loadData = async () => ({ credentials: { google: { type: "api_key", key: "webview-safety-test-key" } } });
  plugin.saveData = async () => {};
  plugin.registerView = () => {};
  plugin.addSettingTab = () => {};
  plugin.addCommand = () => {};
  await plugin.onload();
  return { plugin, fetchCalls };
}

test("universal bundle loads the mobile runtime without Node globals", { skip: !existsSync(BUNDLE_UNDER_TEST) && "bundle not built" }, async () => {
  const { plugin } = await loadMobilePlugin();
  assert.equal(typeof plugin.selectedProvider, "function", "expected the mobile plugin class");
  assert.equal(plugin.providerStatus("google"), "configured");
});

test("a Gemini connection probe completes without Node globals", { skip: !existsSync(BUNDLE_UNDER_TEST) && "bundle not built" }, async () => {
  const { plugin, fetchCalls } = await loadMobilePlugin();
  const result = await plugin.testProvider("google");
  assert.ok(result.model, "probe should report the model it used");
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes("generativelanguage.googleapis.com"));
});
