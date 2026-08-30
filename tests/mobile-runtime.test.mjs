import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MobileAgentController } from "../src/mobile/controller.mjs";
import { MobileAgentRuntime } from "../src/mobile/runtime.mjs";
import { createFakeStreamFn, FAKE_MOBILE_MODEL } from "../src/mobile/fake-provider.mjs";
import { createMobileVaultReadTool, normalizeVaultPath } from "../src/mobile/vault-adapter.mjs";
import { obsidianRequestUrlFetch } from "../src/mobile/network.mjs";

function memoryStorage(initial) {
  const storage = {
    value: initial,
    read: async () => storage.value,
    write: async (next) => {
      storage.value = next;
    }
  };
  return storage;
}

function fakeController(script, { storage = memoryStorage(), tools } = {}) {
  return new MobileAgentController({ storage, streamFn: createFakeStreamFn(script), tools });
}

test("mobile runtime loads the Pi agent loop without Node execution APIs", () => {
  const runtime = new MobileAgentRuntime(() => {
    throw new Error("unused");
  });
  assert.equal(runtime.isAvailable(), true);
});

test("mobile sources never import Node execution surfaces", async () => {
  const dir = join(import.meta.dirname, "..", "src", "mobile");
  for (const file of await readdir(dir)) {
    const source = await readFile(join(dir, file), "utf8");
    assert.ok(
      !/(?:from|require\(|import\()\s*["'](?:node:|node-fetch|jiti)|NodeExecutionEnv/.test(source),
      `${file} must not import Node APIs, node-fetch, NodeExecutionEnv, or jiti`
    );
  }
});

test("fake provider streams a deterministic turn through the controller", async () => {
  const controller = fakeController([{ text: "Hello from mobile.", chunks: 3 }]);
  await controller.applyPluginConfiguration();
  const deltas = [];
  const events = [];
  controller.subscribe((event) => {
    events.push(event.type);
    if (event.type === "assistant.delta") deltas.push(event.delta);
  });

  const result = await controller.submit("hi");

  assert.equal(result, "Hello from mobile.");
  assert.equal(deltas.join(""), "Hello from mobile.");
  assert.ok(events.includes("assistant.delta"));
  assert.ok(events.includes("session.usage"));
  assert.deepEqual(controller.transcript(), [
    { role: "user", text: "hi" },
    { role: "assistant", text: "Hello from mobile." }
  ]);
});

test("submit fails visibly when no provider is configured", async () => {
  const controller = new MobileAgentController({ storage: memoryStorage() });
  await controller.applyPluginConfiguration();
  await assert.rejects(() => controller.submit("hi"), /No model provider is configured/);
});

test("connection probe short-circuits on the injected stream and rejects without a key", async () => {
  const controller = fakeController([{ text: "ok", chunks: 1 }]);
  await controller.applyPluginConfiguration();
  const result = await controller.testProviderConnection("google");
  assert.equal(result.model, "injected-test-stream");

  const bare = new MobileAgentController({ storage: memoryStorage() });
  await bare.applyPluginConfiguration();
  await assert.rejects(() => bare.testProviderConnection("google"), /No API key saved/);
});

test("cancelling a streaming turn aborts the agent loop", async () => {
  const longText = "word ".repeat(200).trim();
  const controller = fakeController([{ text: longText, chunks: 40, chunkDelayMs: 5 }]);
  await controller.applyPluginConfiguration();
  let sawDelta = false;
  const pending = controller.submit("hi", () => {
    if (!sawDelta) {
      sawDelta = true;
      controller.cancel();
    }
  });

  const result = await pending;

  assert.ok(sawDelta, "expected at least one streamed delta before cancelling");
  assert.ok(result.length < longText.length, "cancelled turn must not stream the full response");
  const last = controller.agent.state.messages.at(-1);
  assert.equal(last.stopReason, "aborted");
});

test("vault read tool runs inside the agent loop with Obsidian-provided reads", async () => {
  const reads = [];
  const tools = () => [
    createMobileVaultReadTool({
      readText: async (path) => {
        reads.push(path);
        return "contents of the note";
      }
    })
  ];
  const controller = fakeController(
    [{ toolCalls: [{ name: "read", arguments: { path: "Notes/Idea.md" } }] }, { text: "The note says hi." }],
    { tools }
  );
  await controller.applyPluginConfiguration();
  const toolEvents = [];
  controller.subscribe((event) => {
    if (event.type === "activity.tool") toolEvents.push(event.activity);
  });

  const result = await controller.submit("read my note");

  assert.equal(result, "The note says hi.");
  assert.deepEqual(reads, ["Notes/Idea.md"]);
  assert.deepEqual(
    toolEvents.map((activity) => [activity.name, activity.status]),
    [["read", "running"], ["read", "completed"]]
  );
});

test("vault read tool cannot escape the vault", async () => {
  let facadeCalled = false;
  const tool = createMobileVaultReadTool({
    readText: async () => {
      facadeCalled = true;
      return "";
    }
  });

  for (const escape of ["../secret.md", "../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini", "..\\..\\secret.md", "notes/../../../x.md"]) {
    await assert.rejects(() => tool.execute("call-1", { path: escape }), /escapes the vault/);
  }
  assert.equal(facadeCalled, false, "the facade must never see an escaping path");

  const result = await tool.execute("call-2", { path: "./Notes//Idea.md" });
  assert.equal(facadeCalled, true);
  assert.deepEqual(result.details, { path: "Notes/Idea.md" });
});

test("normalizeVaultPath accepts vault-relative paths only", () => {
  assert.equal(normalizeVaultPath("Notes/Idea.md"), "Notes/Idea.md");
  assert.equal(normalizeVaultPath(" ./a/./b.md "), "a/b.md");
  assert.throws(() => normalizeVaultPath(""), /vault-relative/);
  assert.throws(() => normalizeVaultPath(".."), /escapes the vault/);
});

test("sessions persist through plugin-data storage and resume after reopen", async () => {
  const storage = memoryStorage();
  const first = fakeController([{ text: "First answer." }], { storage });
  await first.applyPluginConfiguration();
  await first.submit("first question");
  const sessionId = first.activeSessionId;
  assert.ok(storage.value?.sessions?.length === 1, "turn must persist to storage");

  // Simulate closing and reopening the view: a new controller over the same storage.
  const streamFn = createFakeStreamFn([{ text: "Second answer." }]);
  const reopened = new MobileAgentController({ storage, streamFn });
  await reopened.applyPluginConfiguration();
  assert.equal(reopened.snapshot().sessions.length, 1);

  await reopened.resumeSession(sessionId);
  assert.deepEqual(reopened.transcript(), [
    { role: "user", text: "first question" },
    { role: "assistant", text: "First answer." }
  ]);

  await reopened.submit("follow up");
  const llmContexts = streamFn.contexts;
  const resumeContext = llmContexts.at(-1);
  assert.deepEqual(
    resumeContext.messages.map((message) => message.role),
    ["user", "assistant", "user"],
    "the resumed agent must receive the persisted transcript as context"
  );
});

test("session model changes stay ephemeral and emit a harness event", async () => {
  const controller = fakeController([]);
  await controller.applyPluginConfiguration();
  const events = [];
  controller.subscribe((event) => events.push(event.type));

  await controller.setSessionModel(FAKE_MOBILE_MODEL.id);

  assert.equal(controller.snapshot().modelId, FAKE_MOBILE_MODEL.id);
  assert.ok(events.includes("session.model.changed"));
});

test("Obsidian requestUrl transport adapts to the fetch shape providers expect", async () => {
  const requests = [];
  const fetch = obsidianRequestUrlFetch(async (request) => {
    requests.push(request);
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      arrayBuffer: new TextEncoder().encode("response-body").buffer,
      text: "response-body",
      json: { ok: true }
    };
  });

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    method: "POST",
    headers: { "x-goog-api-key": "secret" },
    body: "{\"prompt\":true}"
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(requests[0].throw, false);
  assert.equal(requests[0].body, "{\"prompt\":true}");
  assert.equal(await response.text(), "response-body");
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.equal(new TextDecoder().decode(chunk.value), "response-body");
  assert.equal((await reader.read()).done, true);
});

test("requestUrl transport surfaces provider errors as non-ok responses", async () => {
  const fetch = obsidianRequestUrlFetch(async () => ({
    status: 429,
    headers: {},
    arrayBuffer: new TextEncoder().encode("rate limited").buffer,
    text: "rate limited",
    json: {}
  }));
  const response = await fetch("https://example.com");
  assert.equal(response.ok, false);
  assert.equal(response.status, 429);
});
