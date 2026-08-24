import * as piAgentCore from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";

const CHAT_MODEL = "gemini-3.6-flash";

function createGoogleCredentialStore(apiKey) {
  return {
    async read(providerId) { return providerId === "google" ? { type: "api_key", key: apiKey } : undefined; },
    async list() { return [{ providerId: "google", type: "api_key" }]; },
    async modify(providerId, fn) { return fn(providerId === "google" ? { type: "api_key", key: apiKey } : undefined); },
    async delete() {}
  };
}

export class EmbeddedHarness {
  constructor() {
    this.apiKey = "";
    this.agent = undefined;
  }

  async configure({ googleApiKey }) {
    this.apiKey = googleApiKey.trim();
    this.agent = undefined;
  }

  providerState() {
    return this.apiKey ? "configured" : "missing";
  }
  async health(requestId) {
    return {
      type: "harness.health",
      requestId,
      node: process.versions.node,
      piAgentCoreLoaded: typeof piAgentCore.AgentHarness === "function",
      piHostInstallationRequired: false
    };
  }

  async chat(text) {
    if (!this.apiKey) throw new Error("No model provider is configured. Open provider settings to add a Gemini API key.");
    const configuredModels = createModels({ credentials: createGoogleCredentialStore(this.apiKey) });
    configuredModels.setProvider(googleProvider());
    const model = configuredModels.getModel("google", CHAT_MODEL);
    if (!model) throw new Error(`Bundled chat model is unavailable: ${CHAT_MODEL}`);
    if (!this.agent) {
      this.agent = new Agent({
        initialState: { systemPrompt: "You are Obsidian Agent. Answer concisely.", model },
        streamFn: configuredModels.streamSimple.bind(configuredModels)
      });
    }
    await this.agent.prompt(text);
    const response = this.agent.state.messages.at(-1);
    if (!response || response.role !== "assistant") throw new Error("Harness did not return an assistant response.");
    if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider request failed.");
    return response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  async submit(text, onDelta) {
    let unsubscribe = () => {};
    try {
      const result = await this.chatWithEvents(text, onDelta, (stop) => { unsubscribe = stop; });
      return result;
    } finally {
      unsubscribe();
    }
  }

  async chatWithEvents(text, onDelta, setUnsubscribe) {
    if (!this.apiKey) throw new Error("No model provider is configured. Open provider settings to add a Gemini API key.");
    const models = createModels({ credentials: createGoogleCredentialStore(this.apiKey) });
    models.setProvider(googleProvider());
    const model = models.getModel("google", CHAT_MODEL);
    if (!model) throw new Error(`Bundled chat model is unavailable: ${CHAT_MODEL}`);
    if (!this.agent) this.agent = new Agent({ initialState: { systemPrompt: "You are Obsidian Agent. Answer concisely.", model }, streamFn: models.streamSimple.bind(models) });
    setUnsubscribe(this.agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") onDelta(event.assistantMessageEvent.delta);
    }));
    await this.agent.prompt(text);
    const response = this.agent.state.messages.at(-1);
    if (!response || response.role !== "assistant") throw new Error("Harness did not return an assistant response.");
    if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider request failed.");
    return response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }

  cancel() { this.agent?.abort(); }

  transcript() {
    return (this.agent?.state.messages ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("") }));
  }

  close() {
    // Slice 0 has no live agent session. The method establishes the lifecycle boundary.
  }
}
