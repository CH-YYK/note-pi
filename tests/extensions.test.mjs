import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { discoverExtensionPaths, loadNotePiExtensions } from "../src/harness/extensions.mjs";
import { EmbeddedHarness } from "../src/harness/host.mjs";

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

test("unregistered slash input falls through to the agent", async () => {
  await withTempAgentDir(async (agentDir) => {
    const harness = new EmbeddedHarness();
    await harness.applyPluginConfiguration({ providerId: "google", vaultPath: agentDir, agentDir, jitiPath: JITI_PATH });
    // No provider credential and no matching command: falls through to the
    // agent, which fails visibly on the missing provider.
    await assert.rejects(() => harness.submit("/not-a-command hi"), /No model provider/);
  });
});
