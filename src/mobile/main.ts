import { Notice, Plugin, requestUrl } from "obsidian";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { AUTH_PROVIDERS, MOBILE_PROVIDER_IDS } from "../shared/providers.mjs";
import { NotePiSettingsTab } from "../settings";
import { MobileAgentController } from "./controller.mjs";
import { obsidianRequestUrlFetch } from "./network.mjs";
import { createMobileVaultReadTool } from "./vault-adapter.mjs";
import { MobileAgentView, VIEW_TYPE_NOTE_PI_MOBILE } from "./view";

interface MobileSettings { providerId: string; credentials: Record<string, { type: "api_key"; key?: string }>; }
const DEFAULT_SETTINGS: MobileSettings = { providerId: "google", credentials: {} };

/** Providers validated for the iOS WebView build. */
const MOBILE_PROVIDERS = AUTH_PROVIDERS.filter((provider) => MOBILE_PROVIDER_IDS.includes(provider.id));
const providerFactories = { google: googleProvider };

/**
 * Mobile entry point (iPad/iPhone). This is a distinct runtime target from
 * the desktop plugin: it wires MobileAgentView -> MobileAgentController ->
 * MobileAgentRuntime with a browser-safe Pi agent loop, Obsidian requestUrl
 * provider transport, Obsidian vault-API reads, and plugin-data session
 * persistence. No Node APIs, extensions, or shell tools exist in this build.
 */
export default class NotePiMobilePlugin extends Plugin {
  private controller?: MobileAgentController;
  settings: MobileSettings = DEFAULT_SETTINGS;

  async onload() {
    const saved = await this.loadData();
    const credentials = { ...(saved?.credentials ?? {}) };
    for (const id of Object.keys(credentials)) {
      if (!MOBILE_PROVIDERS.some((provider) => provider.id === id)) delete credentials[id];
    }
    this.settings = {
      providerId: MOBILE_PROVIDERS.some((provider) => provider.id === saved?.providerId) ? saved.providerId : DEFAULT_SETTINGS.providerId,
      credentials
    };
    await this.configureHarness();
    this.registerView(VIEW_TYPE_NOTE_PI_MOBILE, (leaf) => new MobileAgentView(leaf, this.startController(), () => this.openSettings()));
    this.addSettingTab(new NotePiSettingsTab(this.app, this));
    this.addCommand({ id: "open-chat", name: "Open Note Pi", callback: () => this.activateView() });
    this.addCommand({ id: "open-settings", name: "Open Note Pi settings", callback: () => this.openSettings() });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_NOTE_PI_MOBILE);
    this.controller?.close();
    this.controller = undefined;
  }

  providerOptions() { return MOBILE_PROVIDERS; }
  selectedProvider() { return MOBILE_PROVIDERS.find((provider) => provider.id === this.settings.providerId) ?? MOBILE_PROVIDERS[0]; }
  providerStatus(providerId = this.settings.providerId) { return this.startController().providerState(providerId); }

  async saveApiKey(apiKey: string, providerId = this.settings.providerId) {
    this.settings.credentials = await this.startController().loginWithApiKey(providerId, apiKey);
    await this.saveSettings();
  }

  async logoutProvider(providerId: string) {
    this.settings.credentials = await this.startController().logout(providerId);
    await this.saveSettings();
  }

  testProvider(providerId: string) {
    return this.startController().testProviderConnection(providerId);
  }

  openSettings() {
    const settings = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  async activateView() {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_NOTE_PI_MOBILE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private startController() {
    if (!this.controller) {
      this.controller = new MobileAgentController({
        storage: {
          read: async () => (await this.loadData())?.mobileSessions,
          write: async (value: unknown) => {
            const data = (await this.loadData()) ?? {};
            data.mobileSessions = value;
            await this.saveData(data);
          }
        },
        tools: () => [createMobileVaultReadTool({ readText: (path: string) => this.app.vault.adapter.read(path) })]
      });
    }
    return this.controller;
  }

  private async configureHarness() {
    const provider = this.selectedProvider();
    await this.startController().applyPluginConfiguration({
      providerId: provider.id,
      credentials: this.settings.credentials,
      providerFactories: [providerFactories[provider.id as keyof typeof providerFactories] ?? googleProvider],
      defaultModel: provider.defaultModel,
      fetch: obsidianRequestUrlFetch(requestUrl)
    });
  }

  private async saveSettings() {
    const data = (await this.loadData()) ?? {};
    data.providerId = this.settings.providerId;
    data.credentials = this.settings.credentials;
    await this.saveData(data);
  }
}
