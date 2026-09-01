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

const CRLF = String.fromCharCode(13, 10);

class StubBase {}

function sse(frames) {
  const lines = [];
  for (const frame of frames) {
    if (frame.event) lines.push("event: " + frame.event);
    lines.push("data: " + frame.data, "");
  }
  return lines.join(CRLF) + CRLF;
}

const GEMINI_SSE = sse([
  { data: '{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2},"modelVersion":"gemini-3.6-flash"}' }
]);

// Anthropic Messages stream; the Kimi Code provider speaks the same
// protocol against its own base URL.
const ANTHROPIC_SSE = sse([
  { event: "message_start", data: '{"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}' },
  { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' },
  { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}' },
  { event: "content_block_stop", data: '{"type":"content_block_stop","index":0}' },
  { event: "message_delta", data: '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}' },
  { event: "message_stop", data: '{"type":"message_stop"}' }
]);

const OPENAI_SSE = sse([
  { event: "response.created", data: '{"type":"response.created","response":{"id":"resp_test","object":"response","created_at":1,"status":"in_progress","model":"gpt-5.5","output":[]}}' },
  { event: "response.output_item.added", data: '{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_test","status":"in_progress","role":"assistant","content":[]}}' },
  { event: "response.output_text.delta", data: '{"type":"response.output_text.delta","item_id":"msg_test","output_index":0,"content_index":0,"delta":"ok"}' },
  { event: "response.output_item.done", data: '{"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_test","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}}' },
  { event: "response.completed", data: '{"type":"response.completed","response":{"id":"resp_test","object":"response","created_at":1,"status":"completed","model":"gpt-5.5","output":[{"type":"message","id":"msg_test","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":0},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":2}}}' }
]);

function cannedSse(url) {
  if (url.includes("generativelanguage.googleapis.com")) return GEMINI_SSE;
  if (url.includes("api.anthropic.com")) return ANTHROPIC_SSE;
  if (url.includes("api.kimi.com")) return ANTHROPIC_SSE;
  if (url.includes("api.openai.com")) return OPENAI_SSE;
  throw new Error("unexpected provider URL: " + url);
}

async function loadMobilePlugin() {
  const fetchCalls = [];
  const requestUrlCalls = [];
  const webviewFetch = async (url) => {
    fetchCalls.push({ url: String(url) });
    return new Response(cannedSse(String(url)), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const obsidianStub = new Proxy({
    Platform: { isMobile: true, isMobileApp: true, isDesktopApp: false, isPhone: false, isTablet: true },
    requestUrl: async (request) => {
      requestUrlCalls.push({ url: String(request.url) });
      const body = cannedSse(String(request.url));
      const bytes = new TextEncoder().encode(body);
      return { status: 200, headers: { "content-type": "text/event-stream" }, arrayBuffer: bytes.buffer, text: body, json: undefined };
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
    FormData, Blob, File,
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
  plugin.loadData = async () => ({
    credentials: {
      google: { type: "api_key", key: "webview-safety-test-key" },
      anthropic: { type: "api_key", key: "webview-safety-test-key" },
      "kimi-coding": { type: "api_key", key: "webview-safety-test-key" },
      openai: { type: "api_key", key: "webview-safety-test-key" }
    }
  });
  plugin.saveData = async () => {};
  plugin.registerView = () => {};
  plugin.addSettingTab = () => {};
  plugin.addCommand = () => {};
  await plugin.onload();
  return { plugin, fetchCalls, requestUrlCalls };
}

const skip = !existsSync(BUNDLE_UNDER_TEST) && "bundle not built";

test("universal bundle loads the mobile runtime without Node globals", { skip }, async () => {
  const { plugin } = await loadMobilePlugin();
  assert.equal(typeof plugin.selectedProvider, "function", "expected the mobile plugin class");
  // The plugin runs in the vm realm; spread results into test-realm arrays
  // before deep comparison.
  assert.deepEqual([...plugin.providerOptions().map((provider) => provider.id)], ["google", "anthropic", "kimi-coding", "openai"]);
  for (const id of ["google", "anthropic", "kimi-coding", "openai"]) {
    assert.equal(plugin.providerStatus(id), "configured", id);
  }
});

test("a Gemini connection probe completes without Node globals", { skip }, async () => {
  const { plugin, fetchCalls, requestUrlCalls } = await loadMobilePlugin();
  const result = await plugin.testProvider("google");
  assert.ok(result.model, "probe should report the model it used");
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes("generativelanguage.googleapis.com"));
  assert.equal(requestUrlCalls.length, 0, "Google providers must use the WebView fetch, not requestUrl");
});

test("an Anthropic connection probe completes over the requestUrl transport", { skip }, async () => {
  const { plugin, fetchCalls, requestUrlCalls } = await loadMobilePlugin();
  const result = await plugin.testProvider("anthropic");
  assert.ok(result.model, "probe should report the model it used");
  assert.equal(requestUrlCalls.length, 1);
  assert.ok(requestUrlCalls[0].url.includes("api.anthropic.com"));
  assert.equal(fetchCalls.length, 0, "Anthropic must not use the WebView fetch");
});

test("a Kimi Code connection probe completes over the requestUrl transport", { skip }, async () => {
  const { plugin, fetchCalls, requestUrlCalls } = await loadMobilePlugin();
  const result = await plugin.testProvider("kimi-coding");
  assert.ok(result.model, "probe should report the model it used");
  assert.equal(requestUrlCalls.length, 1);
  assert.ok(requestUrlCalls[0].url.includes("api.kimi.com"));
  assert.equal(fetchCalls.length, 0, "Kimi Code must not use the WebView fetch");
});

test("an OpenAI connection probe completes over the requestUrl transport", { skip }, async () => {
  const { plugin, fetchCalls, requestUrlCalls } = await loadMobilePlugin();
  const result = await plugin.testProvider("openai");
  assert.ok(result.model, "probe should report the model it used");
  assert.equal(requestUrlCalls.length, 1);
  assert.ok(requestUrlCalls[0].url.includes("api.openai.com"));
  assert.equal(fetchCalls.length, 0, "OpenAI must not use the WebView fetch");
});
