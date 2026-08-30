import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { discoverExtensionPaths, loadNotePiExtensions } from "../src/harness/extensions.mjs";
import { EmbeddedHarness } from "../src/harness/host.mjs";
import { PiAgentRuntime } from "../src/harness/pi-agent-runtime.mjs";

const JITI_PATH = createRequire(import.meta.url).resolve("jiti");

async function withTempAgentDir(fn) {
  const agentDir = await mkdtemp(join(tmpdir(), "note-pi-ext-"));
  try {
    return await fn(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("discovery matches pi-coding-agent rules: files, index entries, and pi manifests", async () => {
  await withTempAgentDir(async (agentDir) => {
    const extensionsDir = join(agentDir, "extensions");
    await mkdir(join(extensionsDir, "indexed"), { recursive: true });
    await mkdir(join(extensionsDir, "manifested"), { recursive: true });
    await mkdir(join(extensionsDir, "empty-dir"), { recursive: true });
    await writeFile(join(extensionsDir, "direct.ts"), "export default function () {}");
    await writeFile(join(extensionsDir, "plain.js"), "module.exports = function () {}");
    await writeFile(join(extensionsDir, "indexed", "index.ts"), "export default function () {}");
    await writeFile(join(extensionsDir, "manifested", "package.json"), JSON.stringify({ pi: { extensions: ["src/main.ts"] } }));
    await mkdir(join(extensionsDir, "manifested", "src"));
    await writeFile(join(extensionsDir, "manifested", "src", "main.ts"), "export default function () {}");
    await writeFile(join(extensionsDir, "ignored.txt"), "not an extension");
    const paths = discoverExtensionPaths(extensionsDir).sort();
    assert.deepEqual(
      paths.map((path) => path.slice(extensionsDir.length + 1)),
      ["direct.ts", "indexed/index.ts", "manifested/src/main.ts", "plain.js"]
    );
  });
});

test("discovery returns nothing when the extensions directory is missing", async () => {
  await withTempAgentDir(async (agentDir) => {
    assert.deepEqual(discoverExtensionPaths(join(agentDir, "extensions")), []);
  });
});

test("extension summary uses package metadata and local-file fallbacks", async () => {
  await withTempAgentDir(async (agentDir) => {
    const extensionsDir = join(agentDir, "extensions");
    const packageDir = join(extensionsDir, "package-extension");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(extensionsDir, "local.ts"), "export default function () {}");
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "package-extension", description: "A package extension", pi: { extensions: ["src/main.ts"] } }));
    await mkdir(join(packageDir, "src"));
    await writeFile(join(packageDir, "src", "main.ts"), "export default function () {}");

    const registry = await loadNotePiExtensions(agentDir, {}, JITI_PATH);
    assert.deepEqual(registry.summary().extensions.map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name)), [
      { name: "local", description: "Local extension" },
      { name: "package-extension", description: "A package extension" }
    ]);
  });
});

test("compatibility shims load Coding Agent utility extensions that only use text-mode commands", async () => {
  await withTempAgentDir(async (agentDir) => {
    const extensionsDir = join(agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      join(extensionsDir, "utility.ts"),
      `import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
class NeverRendered extends Container {}
export default function (pi) {
  if (CONFIG_DIR_NAME !== ".pi" || getAgentDir() !== ${JSON.stringify(agentDir)}) throw new Error("compatibility module unavailable");
  pi.registerCommand("tools", { handler: async () => pi.getAllTools().map((tool) => tool.name).join(",") });
}`
    );
    const registry = await loadNotePiExtensions(agentDir, { getAllTools: () => [{ name: "read" }] }, JITI_PATH);
    assert.equal(registry.errors.length, 0);
    assert.equal(await registry.runCommand("tools", ""), "read");
  });
});

test("extensions register tools, commands, and handlers like pi-coding-agent factories", async () => {
  await withTempAgentDir(async (agentDir) => {
    const extensionsDir = join(agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      join(extensionsDir, "greeter.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "greet",
    description: "Greet by name",
    parameters: Type.Object({ name: Type.String() }),
    async execute(id, params) { return { content: [{ type: "text", text: "Hello " + params.name }], details: {} }; }
  });
  pi.registerCommand("hello", { description: "Say hello", handler: async (args) => "Hello " + (args || "world") });
  pi.on("session_start", async (event, ctx) => { ctx.ui.notify("greeter loaded"); });
}`
    );
    const notifications = [];
    const registry = await loadNotePiExtensions(agentDir, { vaultPath: agentDir, notify: (message) => notifications.push(message) }, JITI_PATH);
    assert.equal(registry.errors.length, 0);
    assert.equal(registry.extensions.length, 1);
    assert.deepEqual([...registry.tools().keys()], ["greet"]);
    assert.deepEqual([...registry.commands().keys()], ["hello"]);
    await registry.emit({ type: "session_start" });
    assert.deepEqual(notifications, ["greeter loaded"]);
    assert.equal(await registry.runCommand("hello", "pi"), "Hello pi");
    const [tool] = registry.agentTools();
    const result = await tool.execute("call-1", { name: "Pi" });
    assert.equal(result.content[0].text, "Hello Pi");
  });
});

test("a broken extension reports an error and never blocks the others", async () => {
  await withTempAgentDir(async (agentDir) => {
    const extensionsDir = join(agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, "broken.ts"), "throw new Error('boom');");
    await writeFile(join(extensionsDir, "healthy.ts"), "export default function (pi) { pi.registerCommand('ok', { handler: async () => 'fine' }); }");
    const registry = await loadNotePiExtensions(agentDir, {}, JITI_PATH);
    assert.equal(registry.extensions.length, 1);
    assert.equal(registry.errors.length, 1);
    assert.match(registry.errors[0].error, /boom/);
    assert.equal(await registry.runCommand("ok", ""), "fine");
  });
});

test("tool_call handlers can block a tool call", async () => {
  await withTempAgentDir(async (agentDir) => {
    const extensionsDir = join(agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      join(extensionsDir, "guard.ts"),
      `export default function (pi) {
  pi.on("tool_call", async (event) => event.toolName === "danger" ? { block: true, reason: "not allowed" } : undefined);
  pi.registerTool({
    name: "danger",
    description: "Dangerous",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ran" }], details: {} }; }
  });
}`
    );
    const registry = await loadNotePiExtensions(agentDir, {}, JITI_PATH);
    const [tool] = registry.agentTools();
    const result = await tool.execute("call-1", {});
    assert.match(result.content[0].text, /blocked: not allowed/i);
    assert.equal(result.details.blocked, true);
  });
});

test("harness loads vault-local extensions during configuration and routes slash commands", async () => {
  await withTempAgentDir(async (agentDir) => {
    const extensionsDir = join(agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      join(extensionsDir, "echo.ts"),
      "export default function (pi) { pi.registerCommand('echo', { description: 'Echo args', handler: async (args) => 'echo: ' + args }); }"
    );
    const harness = new EmbeddedHarness();
    const events = [];
    harness.subscribe((event) => events.push(event.type));
    await harness.applyPluginConfiguration({ providerId: "google", vaultPath: agentDir, agentDir, jitiPath: JITI_PATH });
    assert.equal(harness.snapshot().extensions.length, 1);
    assert.deepEqual(harness.snapshot().extensions[0].commands, ["echo"]);
    assert.ok(events.includes("session.extensions"));
    assert.equal(await harness.submit("/echo hello there"), "echo: hello there");
  });
});

test("harness ignores extension sources outside the Pi agent directory", async () => {
  await withTempAgentDir(async (agentDir) => {
    const extensionsDir = join(agentDir, "extensions");
    const outsideExtension = join(agentDir, "outside.ts");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, "local.ts"), "export default function (pi) { pi.registerCommand('local', { handler: async () => 'ok' }); }");
    await writeFile(outsideExtension, "export default function (pi) { pi.registerCommand('outside', { handler: async () => 'not ok' }); }");
    const harness = new EmbeddedHarness();
    await harness.applyPluginConfiguration({ providerId: "google", vaultPath: agentDir, agentDir, extensionPaths: [outsideExtension], jitiPath: JITI_PATH });
    assert.deepEqual(harness.snapshot().extensions.map((extension) => extension.name), ["local"]);
    assert.deepEqual([...harness.extensionRegistry.commands().keys()], ["local"]);
  });
});

test("unregistered slash input falls through to the agent", async () => {
  await withTempAgentDir(async (agentDir) => {
    const harness = new EmbeddedHarness();
    await harness.applyPluginConfiguration({ providerId: "google", vaultPath: agentDir, agentDir, jitiPath: JITI_PATH });
    // No provider credential and no matching command: falls through to the
    // agent, which fails visibly on the missing provider.
    await assert.rejects(() => harness.submit("/not-a-command hi"), /No model provider/);
  });
});

test("newSession resets the agent and reports zero usage", async () => {
  await withTempAgentDir(async (agentDir) => {
    const harness = new EmbeddedHarness();
    await harness.applyPluginConfiguration({
      providerId: "google",
      credentials: { google: { type: "api_key", key: "test-key" } },
      vaultPath: agentDir,
      agentDir,
      jitiPath: JITI_PATH
    });
    const events = [];
    harness.subscribe((event) => events.push(event.type));
    harness.createAgent();
    assert.ok(harness.snapshot().usageTokens >= 0);

    await harness.newSession();

    assert.ok(events.includes("session.state"));
    assert.deepEqual(harness.snapshot().transcript, []);
    assert.equal(harness.snapshot().usageTokens, 0);
  });
});

test("tool activity events carry a human-readable detail when the tool has a target", async () => {
  await withTempAgentDir(async (agentDir) => {
    const harness = new EmbeddedHarness();
    await harness.applyPluginConfiguration({ providerId: "google", vaultPath: agentDir, agentDir, jitiPath: JITI_PATH });
    assert.equal(harness.toolDetail({ path: "Notes/A.md" }), "Notes/A.md");
    assert.equal(harness.toolDetail({ note: "B.md" }), "B.md");
    assert.equal(harness.toolDetail({ unrelated: 1 }), undefined);
    assert.equal(harness.toolDetail(undefined), undefined);
  });
});

function configuredHarness(agentDir) {
  const harness = new EmbeddedHarness();
  return harness.applyPluginConfiguration({
    providerId: "google",
    credentials: { google: { type: "api_key", key: "test-key" } },
    vaultPath: agentDir,
    agentDir,
    jitiPath: JITI_PATH
  }).then(() => harness);
}

function pushFakeTurn(harness, text) {
  const agent = harness.createAgent();
  agent.state.messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  agent.state.messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now(), usage: { totalTokens: 42 } });
  return agent;
}

test("newSession archives the active session and starts fresh", async () => {
  await withTempAgentDir(async (agentDir) => {
    const harness = await configuredHarness(agentDir);
    pushFakeTurn(harness, "summarize the design note");

    await harness.newSession();

    const snapshot = harness.snapshot();
    assert.deepEqual(snapshot.transcript, []);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].title, "summarize the design note");
    assert.notEqual(snapshot.activeSessionId, snapshot.sessions[0].id);
    const stored = await readdir(join(agentDir, "sessions"));
    assert.equal(stored.length, 1);
  });
});

test("session history survives a harness restart and resumes its transcript", async () => {
  await withTempAgentDir(async (agentDir) => {
    const first = await configuredHarness(agentDir);
    pushFakeTurn(first, "first turn question");
    await first.newSession();

    // Simulate a plugin reload: a brand-new harness over the same agentDir.
    const second = await configuredHarness(agentDir);
    const sessions = second.snapshot().sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, "first turn question");

    await second.resumeSession(sessions[0].id);

    const snapshot = second.snapshot();
    assert.equal(snapshot.activeSessionId, sessions[0].id);
    assert.deepEqual(
      snapshot.transcript.map((message) => message.text),
      ["first turn question", "ok"]
    );
    assert.equal(snapshot.usageTokens, 42);
  });
});

test("corrupted session files are skipped without breaking the store", async () => {
  await withTempAgentDir(async (agentDir) => {
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    await writeFile(join(agentDir, "sessions", "broken.json"), "{ not json");
    const harness = await configuredHarness(agentDir);
    assert.deepEqual(harness.snapshot().sessions, []);
  });
});

test("withContextNotes prepends attached vault notes without touching bare prompts", () => {
  const harness = new EmbeddedHarness();
  assert.equal(harness.withContextNotes("hello"), "hello");
  assert.equal(harness.withContextNotes("hello", []), "hello");
  const wrapped = harness.withContextNotes("summarize this", ["Notes/A.md", "Notes/B.md"]);
  assert.ok(wrapped.endsWith("summarize this"));
  assert.ok(wrapped.includes("- Notes/A.md"));
  assert.ok(wrapped.includes("- Notes/B.md"));
});

test("vault read tool reads files inside the vault", async () => {
  await withTempAgentDir(async (vault) => {
    await writeFile(join(vault, "note.md"), "hello vault");
    const tool = new PiAgentRuntime(() => {}).createVaultReadTool(vault);
    const result = await tool.execute("1", { path: "note.md" }, new AbortController().signal, undefined);
    assert.ok(result.content[0].text.includes("hello vault"));
  });
});

test("vault read tool denies absolute, relative, and symlink escapes", async () => {
  await withTempAgentDir(async (vault) => {
    const outside = join(tmpdir(), `note-pi-outside-${Date.now()}.md`);
    await writeFile(outside, "secret");
    await symlink(outside, join(vault, "linked.md"));
    const tool = new PiAgentRuntime(() => {}).createVaultReadTool(vault);
    await assert.rejects(() => tool.execute("1", { path: outside }, new AbortController().signal, undefined), /limited to the vault/);
    await assert.rejects(() => tool.execute("2", { path: "../outside.md" }, new AbortController().signal, undefined));
    await assert.rejects(() => tool.execute("3", { path: "linked.md" }, new AbortController().signal, undefined), /limited to the vault/);
    await rm(outside, { force: true });
  });
});

test("vault read tool surfaces a clean error for missing files", async () => {
  await withTempAgentDir(async (vault) => {
    const tool = new PiAgentRuntime(() => {}).createVaultReadTool(vault);
    await assert.rejects(() => tool.execute("1", { path: "missing.md" }, new AbortController().signal, undefined));
  });
});

test("context block never leaks into transcripts or session titles", async () => {
  await withTempAgentDir(async (agentDir) => {
    const harness = await configuredHarness(agentDir);
    const wrapped = harness.withContextNotes("summarize this", ["Notes/A.md"]);
    pushFakeTurn(harness, wrapped);
    await harness.newSession();

    const snapshot = harness.snapshot();
    assert.equal(snapshot.sessions[0].title, "summarize this");

    await harness.resumeSession(snapshot.sessions[0].id);
    const transcript = harness.snapshot().transcript;
    assert.equal(transcript[0].text, "summarize this");
  });
});
