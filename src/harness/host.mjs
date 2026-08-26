import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AUTH_PROVIDERS } from "../shared/providers.mjs";
import { ExtensionRegistry, loadNotePiExtensions } from "./extensions.mjs";
import { PiAgentRuntime, nodeBackedFetch } from "./pi-agent-runtime.mjs";

export { nodeBackedFetch } from "./pi-agent-runtime.mjs";
export { AUTH_PROVIDERS } from "../shared/providers.mjs";

const providers = new Map(AUTH_PROVIDERS.map((provider) => [provider.id, provider]));
const providerFactories = [googleProvider, anthropicProvider, githubCopilotProvider, kimiCodingProvider, moonshotaiProvider, openrouterProvider];

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

/**
 * Application layer. It owns Note Pi's provider/session/extension policy and
 * translates the Pi runtime into UI-facing snapshots and events.
 */
export class AgentController {
  constructor() {
    this.providerId = "google";
    this.modelId = undefined;
    this.runtime = new PiAgentRuntime((selectedModel, context, options) => this.models.streamSimple(selectedModel, context, { ...options, fetch: nodeBackedFetch }));
    this.models = undefined;
    this.credentialStore = undefined;
    this.listeners = new Set();
    this.extensionRegistry = new ExtensionRegistry();
    this.sessions = [];
    this.activeSessionId = crypto.randomUUID();
  }

  get agent() { return this.runtime.agent; }
  set agent(agent) { this.runtime.agent = agent; }

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
    await this.loadSessionStore();
    this.emit({ type: "session.state", snapshot: this.snapshot() });
  }

  // --- Session history ---------------------------------------------------------
  //
  // Sessions persist as JSON transcripts under <agentDir>/sessions/. This is
  // Note Pi's own store, not Pi's JsonlSessionRepo: the chat slice needs
  // list/resume, and Pi's lane/branch model arrives with the AgentHarness
  // integration. Messages are stored verbatim so a resumed session recreates
  // its Agent with full context.

  sessionsDir() {
    return this.agentDir ? join(this.agentDir, "sessions") : undefined;
  }

  async loadSessionStore() {
    this.sessions = [];
    const dir = this.sessionsDir();
    if (!dir) return;
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(join(dir, file), "utf8"));
        if (record?.version !== 1 || !Array.isArray(record.messages)) continue;
        this.sessions.push({
          id: record.id,
          title: record.title ?? "Untitled session",
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          modelId: record.modelId,
          messages: record.messages
        });
      } catch {
        // Corrupted session files are skipped, never fatal.
      }
    }
    this.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /** Persist the active session after each completed turn. */
  async persistActiveSession() {
    const dir = this.sessionsDir();
    const messages = this.agent?.state.messages ?? [];
    if (!dir || messages.length === 0) return;
    const existing = this.sessions.find((session) => session.id === this.activeSessionId);
    const firstUser = messages.find((message) => message.role === "user");
    const firstText = firstUser?.content?.filter((part) => part.type === "text").map((part) => part.text).join(" ") ?? "";
    const title = (existing?.title ?? firstText.trim().replace(/\s+/g, " ").slice(0, 60)) || "Untitled session";
    const record = {
      version: 1,
      id: this.activeSessionId,
      title,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      modelId: this.modelId,
      messages
    };
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${this.activeSessionId}.json`), JSON.stringify(record));
      const entry = { id: record.id, title, createdAt: record.createdAt, updatedAt: record.updatedAt, modelId: record.modelId, messages };
      if (existing) Object.assign(existing, entry);
      else this.sessions.unshift(entry);
    } catch {
      // History persistence is best-effort; chat must keep working without it.
    }
  }

  /** Start a fresh session, keeping the current one in history. */
  async newSession() {
    await this.persistActiveSession();
    this.activeSessionId = crypto.randomUUID();
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
  }

  /** Resume a session from history into a fresh Agent with its transcript. */
  async resumeSession(id) {
    if (id === this.activeSessionId) return;
    const session = this.sessions.find((entry) => entry.id === id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    await this.persistActiveSession();
    this.activeSessionId = id;
    if (session.modelId && this.models?.getModel(this.providerId, session.modelId)) this.modelId = session.modelId;
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
  }

  /** Messages of the active session, used when (re)creating the Agent. */
  activeSessionMessages() {
    return this.sessions.find((session) => session.id === this.activeSessionId)?.messages ?? [];
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
    return { type: "harness.health", requestId, node: process.versions.node, piAgentCoreLoaded: this.runtime.isAvailable(), piHostInstallationRequired: false };
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
      await this.persistActiveSession();
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
      sessions: this.sessions.map((session) => ({ id: session.id, title: session.title, updatedAt: session.updatedAt, messageCount: session.messages.length })),
      activeSessionId: this.activeSessionId,
      extensions: extensionSummary.extensions,
      extensionErrors: extensionSummary.errors
    };
  }

  usageTokens() {
    const messages = this.agent?.state.messages ?? this.activeSessionMessages();
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
    return (this.agent?.state.messages ?? this.activeSessionMessages())
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

  createAgent(messages) {
    if (this.providerState() !== "configured") throw new Error("No model provider is configured. Open provider settings to add an API key.");
    if (this.agent) return this.agent;
    const model = this.models.getModel(this.providerId, this.modelId);
    if (!model) throw new Error(`Bundled chat model is unavailable: ${this.modelId}`);
    this.agent = this.runtime.createAgent({
      initialState: { systemPrompt: "You are Note Pi. Answer concisely.", model, messages: messages ?? this.activeSessionMessages(), tools: [...this.nativeTools(), ...this.extensionRegistry.agentTools()] },
    });
    return this.agent;
  }

  nativeTools() {
    if (!this.enabledTools?.includes("read") || !this.vaultPath) return [];
    const readTool = this.runtime.createVaultReadTool(this.vaultPath);
    return [this.extensionRegistry.wrapNativeTool(readTool)];
  }

  readResponse(agent) {
    const response = agent.state.messages.at(-1);
    if (!response || response.role !== "assistant") throw new Error("Harness did not return an assistant response.");
    if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider request failed.");
    return response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
}

// Temporary compatibility name for existing consumers and extension tests.
export const EmbeddedHarness = AgentController;
