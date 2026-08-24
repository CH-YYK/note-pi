import * as piAgentCore from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export const AUTH_PROVIDERS = [
  { id: "google", label: "Google Gemini", apiKeyLabel: "Gemini API key", defaultModel: "gemini-3.6-flash" },
  { id: "anthropic", label: "Anthropic", apiKeyLabel: "Anthropic API key", defaultModel: "claude-sonnet-4-5" },
  { id: "github-copilot", label: "GitHub Copilot", apiKeyLabel: "GitHub token", defaultModel: "gpt-4.1" },
  { id: "kimi-coding", label: "Kimi K3", apiKeyLabel: "Kimi API key", defaultModel: "k3" },
  { id: "openrouter", label: "OpenRouter", apiKeyLabel: "OpenRouter API key", defaultModel: "openai/gpt-4o-mini" }
];

const providers = new Map(AUTH_PROVIDERS.map((provider) => [provider.id, provider]));
const providerFactories = [googleProvider, anthropicProvider, githubCopilotProvider, kimiCodingProvider, openrouterProvider];

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
  }

  async configure({ providerId = "google", modelId, credentials = {}, persistCredentials = async (_credentials) => {} }) {
    if (!providers.has(providerId)) throw new Error(`Unsupported provider: ${providerId}`);
    this.providerId = providerId;
    this.credentialStore = new PiCredentialStore(credentials, persistCredentials);
    this.models = createModels({ credentials: this.credentialStore });
    for (const factory of providerFactories) this.models.setProvider(factory());
    const provider = providers.get(providerId);
    this.modelId = this.models.getModel(providerId, modelId)?.id ?? provider.defaultModel;
    this.agent = undefined;
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
  }

  async logout(providerId = this.providerId) {
    this.assertProvider(providerId);
    await this.models.logout(providerId);
    this.agent = undefined;
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
    const agent = this.createAgent();
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") onDelta(event.assistantMessageEvent.delta);
    });
    try {
      await agent.prompt(text);
      return this.readResponse(agent);
    } finally {
      unsubscribe();
    }
  }

  cancel() { this.agent?.abort(); }
  transcript() {
    return (this.agent?.state.messages ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("") }));
  }
  close() {}

  assertProvider(providerId) {
    if (!providers.has(providerId)) throw new Error(`Unsupported provider: ${providerId}`);
    if (!this.models) throw new Error("Harness has not been configured.");
  }

  createAgent() {
    if (this.providerState() !== "configured") throw new Error("No model provider is configured. Open provider settings to add an API key.");
    if (this.agent) return this.agent;
    const model = this.models.getModel(this.providerId, this.modelId);
    if (!model) throw new Error(`Bundled chat model is unavailable: ${this.modelId}`);
    this.agent = new Agent({ initialState: { systemPrompt: "You are Note Pi. Answer concisely.", model }, streamFn: this.models.streamSimple.bind(this.models) });
    return this.agent;
  }

  readResponse(agent) {
    const response = agent.state.messages.at(-1);
    if (!response || response.role !== "assistant") throw new Error("Harness did not return an assistant response.");
    if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider request failed.");
    return response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
}
