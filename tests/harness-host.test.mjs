import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AUTH_PROVIDERS, AgentController, EmbeddedHarness, nodeBackedFetch } from "../src/harness/host.mjs";

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

test("AgentController is the application-layer entry point", () => {
  assert.equal(EmbeddedHarness, AgentController);
  const controller = new AgentController();
  assert.equal(controller.runtime.isAvailable(), true);
});

test("created agents receive the controller-prepared model, prompt, and tools", async () => {
  const controller = new AgentController();
  await controller.applyPluginConfiguration({
    providerId: "google",
    credentials: { google: { type: "api_key", key: "test-key" } },
    vaultPath: import.meta.dirname,
    enabledTools: ["read"]
  });

  const agent = controller.createAgent();

  assert.equal(agent.state.model.id, "gemini-3.6-flash");
  assert.match(agent.state.systemPrompt, /Note Pi/);
  assert.ok(agent.state.tools.some((tool) => tool.name === "read"), "native read tool must reach the agent");
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

test("API-key login returns a provider-scoped credential for plugin configuration to persist", async () => {
  const harness = new EmbeddedHarness();
  await harness.applyPluginConfiguration({ providerId: "google" });

  const credentials = await harness.loginWithApiKey("google", "test-gemini-key");

  assert.equal(harness.providerState(), "configured");
  assert.deepEqual(credentials, { google: { type: "api_key", key: "test-gemini-key" } });
});

test("OAuth-only provider selections are rejected after migration to API-only authentication", async () => {
  const harness = new EmbeddedHarness();
  await harness.applyPluginConfiguration({ providerId: "google" });

  await assert.rejects(() => harness.applyPluginConfiguration({ providerId: "openai-codex" }), /Unsupported provider/);
});

test("every advertised provider exposes its default chat model in Pi's catalog", async () => {
  for (const provider of AUTH_PROVIDERS) {
    assert.ok(provider.apiKeyLabel, `${provider.id} must offer an API-key label`);
    const harness = new EmbeddedHarness();
    await harness.applyPluginConfiguration({
      providerId: provider.id,
      credentials: { [provider.id]: { type: "api_key", key: "test-key" } }
    });
    assert.ok(harness.modelsForProvider().some((model) => model.id === provider.defaultModel), provider.id);
    assert.doesNotThrow(() => harness.createAgent(), provider.id);
  }
});

test("a session model changes without reapplying plugin configuration", async () => {
  const harness = new EmbeddedHarness();
  await harness.applyPluginConfiguration({
    providerId: "openrouter",
    credentials: { openrouter: { type: "api_key", key: "test-key" } }
  });
  await harness.setSessionModel("openai/gpt-4o-mini");

  assert.equal(harness.modelId, "openai/gpt-4o-mini");
  assert.doesNotThrow(() => harness.createAgent());
});

test("chat models span every configured provider and selection switches providers", async () => {
  const harness = new EmbeddedHarness();
  await harness.applyPluginConfiguration({
    providerId: "kimi-coding",
    credentials: {
      "kimi-coding": { type: "api_key", key: "kimi-key" },
      anthropic: { type: "api_key", key: "anthropic-key" }
    }
  });

  const snapshot = harness.snapshot();
  assert.equal(snapshot.providerState, "configured");
  assert.equal(snapshot.modelId, "kimi-coding/k3");
  assert.ok(snapshot.models.some((model) => model.id === "kimi-coding/k3" && model.provider === "Kimi Code"));
  assert.ok(snapshot.models.some((model) => model.id.startsWith("anthropic/") && model.provider === "Anthropic"));
  assert.ok(!snapshot.models.some((model) => model.id.startsWith("google/")), "unconfigured providers stay out of the picker");

  await harness.setSessionModel("anthropic/claude-sonnet-4-5");
  assert.equal(harness.providerId, "anthropic");
  assert.equal(harness.modelId, "claude-sonnet-4-5");

  await assert.rejects(() => harness.setSessionModel("google/gemini-3.6-flash"), /no API key/);
});

test("an unconfigured preferred provider falls back to a configured one", async () => {
  const harness = new EmbeddedHarness();
  await harness.applyPluginConfiguration({
    providerId: "anthropic",
    credentials: { "kimi-coding": { type: "api_key", key: "kimi-key" } }
  });

  assert.equal(harness.providerId, "kimi-coding");
  assert.equal(harness.modelId, "k3");
  assert.equal(harness.snapshot().providerState, "configured");
});

test("agent requests use Node-backed fetch instead of Obsidian renderer fetch", async () => {
  const harness = new EmbeddedHarness();
  await harness.applyPluginConfiguration({
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
