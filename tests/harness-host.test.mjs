import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_PROVIDERS, EmbeddedHarness } from "../src/harness/host.mjs";

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
