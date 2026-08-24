import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AUTH_PROVIDERS, EmbeddedHarness, nodeBackedFetch } from "../src/harness/host.mjs";

test("embedded harness loads Pi without a host Pi executable", async () => {
  const harness = new EmbeddedHarness();
  const health = await harness.health("in-process-health");
  assert.deepEqual(health, {
    type: "harness.health",
    requestId: "in-process-health",
    node: process.versions.node,
    piAgentCoreLoaded: true,
    piHostInstallationRequired: false
  });
});

test("chat fails visibly when no provider credential is available", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(() => new EmbeddedHarness().chat("hello"));
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
  }
});

test("API-key login persists a provider-scoped Pi credential", async () => {
  const persisted = [];
  const harness = new EmbeddedHarness();
  await harness.configure({
    providerId: "google",
    persistCredentials: async (credentials) => persisted.push(credentials)
  });

  await harness.loginWithApiKey("google", "test-gemini-key");

  assert.equal(harness.providerState(), "configured");
  assert.deepEqual(persisted, [{ google: { type: "api_key", key: "test-gemini-key" } }]);
});

test("OAuth-only provider selections are rejected after migration to API-only authentication", async () => {
  const harness = new EmbeddedHarness();
  await harness.configure({ providerId: "google" });

  await assert.rejects(() => harness.configure({ providerId: "openai-codex" }), /Unsupported provider/);
});

test("every advertised provider exposes its default chat model in Pi's catalog", async () => {
  for (const provider of AUTH_PROVIDERS) {
    assert.ok(provider.apiKeyLabel, `${provider.id} must offer an API-key label`);
    const harness = new EmbeddedHarness();
    await harness.configure({
      providerId: provider.id,
      credentials: { [provider.id]: { type: "api_key", key: "test-key" } }
    });
    assert.ok(harness.modelsForProvider().some((model) => model.id === provider.defaultModel), provider.id);
    assert.doesNotThrow(() => harness.createAgent(), provider.id);
  }
});

test("a selected provider model replaces its default when it exists in Pi's catalog", async () => {
  const harness = new EmbeddedHarness();
  await harness.configure({
    providerId: "moonshotai",
    modelId: "kimi-k3",
    credentials: { moonshotai: { type: "api_key", key: "test-key" } }
  });

  assert.equal(harness.modelId, "kimi-k3");
  assert.doesNotThrow(() => harness.createAgent());
});

test("agent requests use Node-backed fetch instead of Obsidian renderer fetch", async () => {
  const harness = new EmbeddedHarness();
  await harness.configure({
    providerId: "kimi-coding",
    credentials: { "kimi-coding": { type: "api_key", key: "test-key" } }
  });
  const agent = harness.createAgent();
  let receivedOptions;
  harness.models.streamSimple = (_model, _context, options) => {
    receivedOptions = options;
    return {};
  };

  agent.streamFunction(harness.models.getModel("kimi-coding", "k3"), { messages: [] }, {});

  assert.equal(typeof receivedOptions.fetch, "function");
  assert.notEqual(receivedOptions.fetch, globalThis.fetch);
});

test("Node-backed fetch adapts Node response streams to Web streams", async () => {
  const server = createServer((_request, response) => response.end("stream-ready"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await nodeBackedFetch(`http://127.0.0.1:${port}`);
    assert.equal(typeof response.body?.getReader, "function");
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "stream-ready");
    assert.equal((await reader.read()).done, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
