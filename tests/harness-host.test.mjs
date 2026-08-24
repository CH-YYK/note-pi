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

test("OAuth credentials select a configured bundled provider without a host Pi install", async () => {
  const harness = new EmbeddedHarness();
  await harness.configure({
    providerId: "openai-codex",
    credentials: { "openai-codex": { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 } }
  });

  assert.equal(harness.providerState(), "configured");
  assert.doesNotThrow(() => harness.createAgent());
});

test("Google browser login remains explicitly unsupported", async () => {
  const harness = new EmbeddedHarness();
  await harness.configure({ providerId: "google" });

  await assert.rejects(() => harness.loginWithOAuth("google", { prompt: async () => "", notify: () => {} }), /does not provide a bundled OAuth login/);
});

test("every advertised provider has its configured chat model in Pi's catalog", async () => {
  for (const provider of AUTH_PROVIDERS) {
    const harness = new EmbeddedHarness();
    await harness.configure({
      providerId: provider.id,
      credentials: { [provider.id]: { type: "api_key", key: "test-key" } }
    });
    assert.doesNotThrow(() => harness.createAgent(), provider.id);
  }
});
