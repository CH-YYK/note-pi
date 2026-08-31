/**
 * Mobile application layer for Note Pi.
 *
 * Owns session state, model choice, app-facing events, and the mobile
 * capability policy. It deliberately excludes everything the desktop
 * AgentController gets from Node: no filesystem paths, no jiti, no extension
 * loading, no shell tools. Session persistence goes through an injected
 * storage adapter (Obsidian plugin data on device, in-memory in tests).
 *
 * The first mobile profile is read-only: the only tool available to the
 * agent is the vault read tool supplied by the plugin wiring.
 */
import { MobileAgentRuntime } from "./runtime.mjs";
import { FAKE_MOBILE_MODEL } from "./fake-provider.mjs";
import { createModels } from "@earendil-works/pi-ai";

/** Minimal credential store matching the interface pi-ai's createModels expects. */
class MobileCredentialStore {
  constructor(credentials = {}) {
    this.credentials = { ...credentials };
  }

  async read(providerId) {
    return this.credentials[providerId];
  }

  async list() {
    return Object.entries(this.credentials).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(providerId, fn) {
    const current = this.credentials[providerId];
    const next = await fn(current);
    if (next !== undefined) this.credentials[providerId] = next;
    return next ?? current;
  }

  async delete(providerId) {
    delete this.credentials[providerId];
  }
}

export class MobileAgentController {
  /**
   * @param {object} [options]
   * @param {{ read(): Promise<any>, write(value: any): Promise<void> }} [options.storage]
   *   Session persistence adapter backed by Obsidian plugin data.
   * @param {(model: any, context: any, options?: any) => any} [options.streamFn]
   *   Injected stream function. When present (the fake provider spike), no
   *   provider credential or model catalog is required.
   * @param {() => any[]} [options.tools]
   *   Mobile capability policy: the full tool set offered to the agent.
   */
  constructor({ storage, streamFn, tools } = {}) {
    this.storage = storage;
    this.injectedStreamFn = streamFn;
    this.toolPolicy = tools ?? (() => []);
    this.runtime = new MobileAgentRuntime((model, context, options) => this.stream(model, context, options));
    this.fetchFn = undefined;
    this.providerId = "google";
    this.modelId = undefined;
    this.models = undefined;
    this.credentialStore = undefined;
    this.listeners = new Set();
    this.sessions = [];
    this.activeSessionId = crypto.randomUUID();
  }

  get agent() {
    return this.runtime.agent;
  }

  set agent(agent) {
    this.runtime.agent = agent;
  }

  stream(model, context, options) {
    if (this.injectedStreamFn) return this.injectedStreamFn(model, context, options);
    // pi-ai's Google adapters create their own client and reject a custom
    // fetch. Gemini's endpoint is CORS-enabled (verified: preflight allows
    // the app://obsidian.md origin and the x-goog-api-key header), so the
    // WebView's native fetch is the transport for Google. Providers whose
    // adapters accept a custom fetch keep the requestUrl transport.
    const providerId = model?.provider ?? this.providerId;
    const adapterRejectsCustomFetch = providerId === "google" || providerId === "google-vertex";
    const fetchOption = this.fetchFn && !adapterRejectsCustomFetch ? { fetch: this.fetchFn } : {};
    return this.models.streamSimple(model, context, { ...options, ...fetchOption });
  }

  /**
   * Apply durable plugin configuration. Unlike the desktop controller this
   * takes no filesystem paths: `models` is a configured pi-ai model catalog
   * and `credentials` come from Obsidian plugin data.
   *
   * @param {object} [configuration]
   * @param {string} [configuration.providerId]
   * @param {Record<string, any>} [configuration.credentials]
   * @param {Array<() => any>} [configuration.providerFactories]
   * @param {string} [configuration.defaultModel]
   * @param {(input: any, init?: any) => Promise<any>} [configuration.fetch]
   */
  async applyPluginConfiguration({ providerId = "google", credentials = {}, providerFactories = [], defaultModel, fetch } = {}) {
    this.providerId = providerId;
    this.credentialStore = new MobileCredentialStore(credentials);
    this.fetchFn = fetch;
    this.models = undefined;
    if (providerFactories.length) {
      this.models = createModels({ credentials: this.credentialStore });
      for (const factory of providerFactories) this.models.setProvider(factory());
      const available = this.models.getModels(providerId);
      this.modelId = available.some((model) => model.id === defaultModel) ? defaultModel : available[0]?.id;
    }
    this.agent = undefined;
    await this.loadSessionStore();
    this.emit({ type: "session.state", snapshot: this.snapshot() });
  }

  /* Session history.
   *
   * Same record shape as the desktop store ({version, id, title, createdAt,
   * updatedAt, modelId, messages}) so sessions stay conceptually portable,
   * but persisted through Obsidian's plugin data APIs instead of node:fs. */

  async loadSessionStore() {
    this.sessions = [];
    if (!this.storage) return;
    let stored;
    try {
      stored = await this.storage.read();
    } catch {
      return;
    }
    const records = stored?.version === 1 && Array.isArray(stored.sessions) ? stored.sessions : [];
    for (const record of records) {
      if (record?.version !== 1 || !Array.isArray(record.messages)) continue;
      this.sessions.push({
        id: record.id,
        title: record.title ?? "Untitled session",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        modelId: record.modelId,
        messages: record.messages
      });
    }
    this.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async persistActiveSession() {
    const messages = this.agent?.state.messages ?? [];
    if (!this.storage || messages.length === 0) return;
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
      const entry = { id: record.id, title, createdAt: record.createdAt, updatedAt: record.updatedAt, modelId: record.modelId, messages };
      if (existing) Object.assign(existing, entry);
      else this.sessions.unshift(entry);
      await this.storage.write({ version: 1, sessions: this.sessions.map((session) => ({ version: 1, ...session })) });
    } catch {
      // History persistence is best-effort; chat must keep working without it.
    }
  }

  async newSession() {
    await this.persistActiveSession();
    this.activeSessionId = crypto.randomUUID();
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
  }

  async resumeSession(id) {
    if (id === this.activeSessionId) return;
    const session = this.sessions.find((entry) => entry.id === id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    await this.persistActiveSession();
    this.activeSessionId = id;
    if (session.modelId) this.modelId = session.modelId;
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
  }

  activeSessionMessages() {
    return this.sessions.find((session) => session.id === this.activeSessionId)?.messages ?? [];
  }

  /* Provider and model state. */

  providerState(providerId = this.providerId) {
    if (this.injectedStreamFn) return "configured";
    const credential = this.credentialStore?.credentials[providerId];
    if (!credential || credential.type !== "api_key" || !credential.key?.trim()) return "missing";
    return "configured";
  }

  modelsForProvider() {
    if (this.injectedStreamFn) return [{ id: FAKE_MOBILE_MODEL.id, label: FAKE_MOBILE_MODEL.name }];
    if (!this.models) return [];
    return this.models.getModels(this.providerId).map((model) => ({ id: model.id, label: model.name ?? model.id }));
  }

  async setSessionModel(modelId) {
    const model = this.injectedStreamFn ? undefined : this.models?.getModel(this.providerId, modelId);
    if (!this.injectedStreamFn && !model) throw new Error(`Chat model is unavailable: ${modelId}`);
    this.modelId = this.injectedStreamFn ? FAKE_MOBILE_MODEL.id : model.id;
    this.agent = undefined;
    this.emit({ type: "session.model.changed", snapshot: this.snapshot() });
  }

  async loginWithApiKey(providerId, apiKey) {
    if (!this.models) throw new Error("No provider catalog is available in this build.");
    if (!apiKey.trim()) throw new Error("Enter an API key before saving.");
    await this.models.login(providerId, "api_key", { prompt: async () => apiKey.trim(), notify: () => {} });
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
    return { ...this.credentialStore.credentials };
  }

  async logout(providerId = this.providerId) {
    if (!this.models) throw new Error("No provider catalog is available in this build.");
    await this.models.logout(providerId);
    if (providerId === this.providerId) {
      const remaining = Object.keys(this.credentialStore?.credentials ?? {}).filter((id) => this.providerState(id) === "configured");
      if (remaining.length) {
        this.providerId = remaining[0];
        this.modelId = this.models.getModels(remaining[0])[0]?.id;
      }
    }
    this.agent = undefined;
    this.emit({ type: "session.state", snapshot: this.snapshot() });
    return { ...this.credentialStore.credentials };
  }

  /**
   * Connection probe for the settings panel: run a minimal one-word turn
   * against the provider with its stored key. Uses the same requestUrl-backed
   * transport as chat turns. Resolves with the responding model id and
   * round-trip latency; rejects with the provider's error.
   */
  async testProviderConnection(providerId) {
    if (this.providerState(providerId) !== "configured") throw new Error("No API key saved for this provider.");
    if (this.injectedStreamFn) return { model: "injected-test-stream", latencyMs: 0 };
    if (!this.models) throw new Error("No provider catalog is available in this build.");
    const model = this.models.getModels(providerId)[0];
    if (!model) throw new Error(`No model available for provider: ${providerId}`);
    const context = { messages: [{ role: "user", content: "Reply with the single word: ok", timestamp: Date.now() }] };
    const abort = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("Connection timed out after 30s."));
      }, 30000);
    });
    const startedAt = Date.now();
    try {
      const stream = this.stream(model, context, { signal: abort.signal });
      const message = await Promise.race([stream.result(), timeout]);
      if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "Connection failed.");
      return { model: message.responseModel ?? model.id, latencyMs: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  /* Turn flow. */

  async submit(text, onDelta) {
    const agent = this.createAgent();
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        onDelta?.(delta);
        this.emit({ type: "assistant.delta", delta });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        this.emit({ type: "activity.thinking", delta: event.assistantMessageEvent.delta });
      }
      if (event.type === "tool_execution_start") {
        this.emit({ type: "activity.tool", activity: { name: event.toolName, status: "running", detail: this.toolDetail(event.args) } });
      }
      if (event.type === "tool_execution_end") {
        this.emit({ type: "activity.tool", activity: { name: event.toolName, status: event.isError ? "failed" : "completed", detail: this.toolDetail(event.args) } });
      }
    });
    try {
      await agent.prompt(text);
      return this.readResponse(agent);
    } finally {
      unsubscribe();
      this.emit({ type: "session.usage", usage: this.usageTokens() });
      await this.persistActiveSession();
    }
  }

  cancel() {
    this.agent?.abort();
  }

  toolDetail(args) {
    if (!args || typeof args !== "object") return undefined;
    const candidate = args.path ?? args.note ?? args.command ?? args.file;
    return typeof candidate === "string" ? candidate : undefined;
  }

  createAgent() {
    if (this.providerState() !== "configured") {
      throw new Error("No model provider is configured. Open provider settings to add an API key.");
    }
    if (this.agent) return this.agent;
    const model = this.injectedStreamFn ? FAKE_MOBILE_MODEL : this.models.getModel(this.providerId, this.modelId);
    if (!model) throw new Error(`Chat model is unavailable: ${this.modelId}`);
    this.agent = this.runtime.createAgent({
      initialState: {
        systemPrompt: "You are Note Pi on Obsidian mobile. Answer concisely. You can read notes in the vault with the read tool; you cannot modify anything.",
        model,
        messages: this.activeSessionMessages(),
        tools: this.toolPolicy()
      }
    });
    return this.agent;
  }

  readResponse(agent) {
    const response = agent.state.messages.at(-1);
    if (!response || response.role !== "assistant") throw new Error("Harness did not return an assistant response.");
    if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider request failed.");
    return response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }

  /* UI-facing contract. */

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  usageTokens() {
    const messages = this.agent?.state.messages ?? this.activeSessionMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = messages[i].usage;
      if (usage?.totalTokens) return usage.totalTokens;
    }
    return 0;
  }

  transcript() {
    return (this.agent?.state.messages ?? this.activeSessionMessages())
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("") }));
  }

  snapshot() {
    return {
      providerId: this.providerId,
      providerState: this.providerState(),
      modelId: this.modelId,
      models: this.modelsForProvider(),
      transcript: this.transcript(),
      usageTokens: this.usageTokens(),
      sessions: this.sessions.map((session) => ({ id: session.id, title: session.title, updatedAt: session.updatedAt, messageCount: session.messages.length })),
      activeSessionId: this.activeSessionId,
      extensions: [],
      extensionErrors: []
    };
  }

  close() {
    this.agent?.abort();
  }
}
