import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddedHarness } from "../src/harness/host.mjs";

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
