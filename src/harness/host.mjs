import * as piAgentCore from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { createReadTool, FileError } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai";
import nodeFetch from "node-fetch";
import { Readable } from "node:stream";
import { relative } from "node:path";
import { realpath } from "node:fs/promises";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { ExtensionRegistry, loadNotePiExtensions } from "./extensions.mjs";

export const AUTH_PROVIDERS = [
  { id: "google", label: "Google Gemini", apiKeyLabel: "Gemini API key", defaultModel: "gemini-3.6-flash" },
  { id: "anthropic", label: "Anthropic", apiKeyLabel: "Anthropic API key", defaultModel: "claude-sonnet-4-5" },
  { id: "github-copilot", label: "GitHub Copilot", apiKeyLabel: "GitHub token", defaultModel: "gpt-4.1" },
  { id: "kimi-coding", label: "Kimi Code", apiKeyLabel: "Kimi Code API key", defaultModel: "k3" },
  { id: "moonshotai", label: "Moonshot AI", apiKeyLabel: "Moonshot AI API key", defaultModel: "kimi-k3" },
  { id: "openrouter", label: "OpenRouter", apiKeyLabel: "OpenRouter API key", defaultModel: "openai/gpt-4o-mini" }
];

const providers = new Map(AUTH_PROVIDERS.map((provider) => [provider.id, provider]));
const providerFactories = [googleProvider, anthropicProvider, githubCopilotProvider, kimiCodingProvider, moonshotaiProvider, openrouterProvider];

// Pi's provider SDKs consume Web streams, while node-fetch exposes a Node stream.
// Adapt the response so the Electron renderer can use Node networking without
// falling back to its CORS-constrained global fetch implementation.
export async function nodeBackedFetch(input, init) {
  const response = await nodeFetch(input, init);
  return {
    body: response.body ? Readable.toWeb(response.body) : null,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    ok: response.ok,
    url: response.url,
    // Providers read error bodies via text()/json(); delegate to node-fetch.
    text: () => response.text(),
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer()
  };
}

export class PiCredentialStore {
  constructor(credentials = {}, persist = async (_credentials) => {}) {
    this.credentials = { ...credentials };
    this.persist = persist;
  }

  async read(providerId) { return this.credentials[providerId]; }
  async list() { return Object.entries(this.credentials).map(([providerId, credential]) => ({ providerId, type: credential.type })); }
  async modify(providerId, fn) {
    const current = this.credentials[providerId];
    const next = await fn(current);
    if (next !== undefined) {
      this.credentials[providerId] = next;
      await this.persist({ ...this.credentials });
    }
    return next ?? current;
  }
  async delete(providerId) {
    delete this.credentials[providerId];
    await this.persist({ ...this.credentials });
  }
}

export class EmbeddedHarness {
  constructor() {
    this.providerId = "google";
    this.modelId = undefined;
    this.agent = undefined;
    this.models = undefined;
    this.credentialStore = undefined;
    this.listeners = new Set();
    this.extensionRegistry = new ExtensionRegistry();
  }

  async applyPluginConfiguration({ providerId = "google", credentials = {}, vaultPath, agentDir, enabledTools = ["read"], jitiPath }) {
    if (!providers.has(providerId)) throw new Error(`Unsupported provider: ${providerId}`);
    this.providerId = providerId;
    this.credentialStore = new PiCredentialStore(credentials);
    this.models = createModels({ credentials: this.credentialStore });
    for (const factory of providerFactories) this.models.setProvider(factory());
    const provider = providers.get(providerId);
    this.modelId = provider.defaultModel;
    this.vaultPath = vaultPath;
    this.agentDir = agentDir;
    this.enabledTools = enabledTools;
    this.jitiPath = jitiPath;
    this.agent = undefined;
    await this.loadExtensions();
    this.emit({ type: "session.state", snapshot: this.snapshot() });
  }

  async loadExtensions() {
    this.extensionRegistry = this.agentDir
      ? await loadNotePiExtensions(this.agentDir, {
          vaultPath: this.vaultPath,
          notify: (message, type) => this.emit({ type: "extension.notify", notification: { message, level: type } }),
          onToolRegistered: (definition) => {
            if (!this.agent) return;
            this.agent.tools = [...this.agent.tools, this.extensionRegistry.wrapTool(definition)];
          }
        }, this.jitiPath)
      : new ExtensionRegistry();
    if (!this.extensionRegistry.isEmpty()) {
      this.emit({ type: "session.extensions", snapshot: this.snapshot() });
      await this.extensionRegistry.emit({ type: "session_start", cwd: this.vaultPath });
    }
  }

  providerState(providerId = this.providerId) {
    const credential = this.credentialStore?.credentials[providerId];
    if (!credential || credential.type !== "api_key" || !credential.key?.trim()) return "missing";
    return "configured";
  }

  modelsForProvider(providerId = this.providerId) {
    this.assertProvider(providerId);
    return this.models.getModels(providerId).map((model) => ({ id: model.id, label: model.name ?? model.id }));
  }

  async loginWithApiKey(providerId, apiKey) {
    this.assertProvider(providerId);
    if (!apiKey.trim()) throw new Error("Enter an API key before saving.");
    await this.models.login(providerId, "api_key", { prompt: async () => apiKey.trim(), notify: () => {} });
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
    return { ...this.credentialStore.credentials };
  }

  async logout(providerId = this.providerId) {
    this.assertProvider(providerId);
    await this.models.logout(providerId);
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
    return { ...this.credentialStore.credentials };
  }

  async health(requestId) {
    return { type: "harness.health", requestId, node: process.versions.node, piAgentCoreLoaded: typeof piAgentCore.AgentHarness === "function", piHostInstallationRequired: false };
  }

  async chat(text) {
    const agent = this.createAgent();
    await agent.prompt(text);
    return this.readResponse(agent);
  }

  async submit(text, onDelta) {
    const commandResult = await this.tryRunCommand(text);
    if (commandResult !== undefined) return commandResult;
    const agent = this.createAgent();
    await this.extensionRegistry.emit({ type: "turn_start" });
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        onDelta?.(delta);
        this.emit({ type: "assistant.delta", delta });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") this.emit({ type: "activity.thinking", delta: event.assistantMessageEvent.delta });
      if (event.type === "tool_execution_start") this.emit({ type: "activity.tool", activity: { name: event.toolName, status: "running", detail: this.toolDetail(event.args) } });
      if (event.type === "tool_execution_end") this.emit({ type: "activity.tool", activity: { name: event.toolName, status: event.isError ? "failed" : "completed", detail: this.toolDetail(event.args) } });
    });
    try {
      await agent.prompt(text);
      const response = this.readResponse(agent);
      await this.extensionRegistry.emit({ type: "turn_end", message: agent.state.messages.at(-1) });
      return response;
    } finally {
      unsubscribe();
      this.emit({ type: "session.usage", usage: this.usageTokens() });
    }
  }

  /**
   * Route "/name args" input to an extension-registered command. Returns
   * undefined when the input is not a registered command.
   */
  async tryRunCommand(text) {
    const match = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text.trim());
    if (!match) return undefined;
    const [, name, args] = match;
    if (!this.extensionRegistry.commands().has(name)) return undefined;
    this.emit({ type: "activity.tool", activity: { name: `/${name}`, status: "running" } });
    try {
      const result = await this.extensionRegistry.runCommand(name, args);
      this.emit({ type: "activity.tool", activity: { name: `/${name}`, status: "completed" } });
      return result;
    } catch (error) {
      this.emit({ type: "activity.tool", activity: { name: `/${name}`, status: "failed" } });
      throw error;
    }
  }

  cancel() { this.agent?.abort(); }

  /** A short human-readable target for an activity row, when one exists. */
  toolDetail(args) {
    if (!args || typeof args !== "object") return undefined;
    const candidate = args.path ?? args.note ?? args.command ?? args.file;
    return typeof candidate === "string" ? candidate : undefined;
  }

  /** Start a fresh session: drop the agent and its transcript, keep provider config. */
  newSession() {
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  snapshot() {
    const extensionSummary = this.extensionRegistry.summary();
    return {
      providerId: this.providerId,
      providerState: this.providerState(),
      modelId: this.modelId,
      models: this.models ? this.modelsForProvider() : [],
      transcript: this.transcript(),
      usageTokens: this.usageTokens(),
      extensions: extensionSummary.extensions,
      extensionErrors: extensionSummary.errors
    };
  }

  usageTokens() {
    const messages = this.agent?.state.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = messages[i].usage;
      if (usage?.totalTokens) return usage.totalTokens;
    }
    return 0;
  }
  async setSessionModel(modelId) {
    this.assertProvider(this.providerId);
    const model = this.models.getModel(this.providerId, modelId);
    if (!model) throw new Error(`Bundled chat model is unavailable: ${modelId}`);
    const transcript = this.agent?.state.messages ?? [];
    this.modelId = model.id;
    this.agent = undefined;
    if (transcript.length) this.createAgent(transcript);
    this.emit({ type: "session.model.changed", snapshot: this.snapshot() });
  }
  transcript() {
    return (this.agent?.state.messages ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("") }));
  }
  close() {
    void this.extensionRegistry.emit({ type: "session_shutdown" });
  }

  assertProvider(providerId) {
    if (!providers.has(providerId)) throw new Error(`Unsupported provider: ${providerId}`);
    if (!this.models) throw new Error("Harness has not been configured.");
  }

  createAgent(messages = []) {
    if (this.providerState() !== "configured") throw new Error("No model provider is configured. Open provider settings to add an API key.");
    if (this.agent) return this.agent;
    const model = this.models.getModel(this.providerId, this.modelId);
    if (!model) throw new Error(`Bundled chat model is unavailable: ${this.modelId}`);
    this.agent = new Agent({
      initialState: { systemPrompt: "You are Note Pi. Answer concisely.", model, messages, tools: [...this.nativeTools(), ...this.extensionRegistry.agentTools()] },
      // Obsidian renderer fetch is subject to Chromium's network policy. Pi must use
      // a Node-backed fetch so provider requests use the same transport as Node tests.
      streamFn: (selectedModel, context, options) => this.models.streamSimple(selectedModel, context, { ...options, fetch: nodeBackedFetch })
    });
    return this.agent;
  }

  nativeTools() {
    if (!this.enabledTools?.includes("read") || !this.vaultPath) return [];
    const read = createReadTool();
    const env = new NodeExecutionEnv({ cwd: this.vaultPath });
    const root = this.vaultPath;
    const safeRead = async (path, signal) => {
      const canonical = await realpath(path);
      if (relative(root, canonical).startsWith("..")) return { ok: false, error: new FileError("permission_denied", "Read is limited to the vault.", path) };
      return env.readBinaryFile(path, signal);
    };
    const readTool = { ...read, execute: (id, args, signal, update) => read.execute(id, args, signal, update, { env: { cwd: root, absolutePath: env.absolutePath.bind(env), readBinaryFile: safeRead } }) };
    return [this.extensionRegistry.wrapNativeTool(readTool)];
  }

  readResponse(agent) {
    const response = agent.state.messages.at(-1);
    if (!response || response.role !== "assistant") throw new Error("Harness did not return an assistant response.");
    if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider request failed.");
    return response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
}
