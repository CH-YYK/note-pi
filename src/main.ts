import { Plugin, Notice, WorkspaceLeaf } from "obsidian";
import { isAbsolute, resolve } from "node:path";
import { checkPiRuntime } from "./plugin/runtime-compatibility";
import { AUTH_PROVIDERS, EmbeddedHarness } from "./harness/host.mjs";
import { NotePiSettingsTab } from "./settings";
import { ObsidianAgentView, VIEW_TYPE_NOTE_PI } from "./view";

type HarnessEvent = { type: string; requestId: string; node?: string; pid?: number };
export interface NotePiCredential { type: "api_key"; key?: string; [key: string]: unknown; }
export interface NotePiSettings { providerId: string; agentDir: string; credentials: Record<string, NotePiCredential>; googleApiKey?: string; }
const DEFAULT_SETTINGS: NotePiSettings = { providerId: "google", agentDir: "", credentials: {}, googleApiKey: "" };

export default class NotePiPlugin extends Plugin {
  private harness?: EmbeddedHarness;
  private requestSequence = 0;
  settings: NotePiSettings = DEFAULT_SETTINGS;

  async onload() {
    const runtime = checkPiRuntime(process.versions.node);
    if (!runtime.supported) {
      new Notice(`Note Pi disabled: ${runtime.message}`);
      return;
    }
    this.settings = this.normalizeSettings(await this.loadData());
    await this.saveData(this.settings);
    await this.configureHarness();
    this.registerView(VIEW_TYPE_NOTE_PI, (leaf) => new ObsidianAgentView(leaf, this.startHarness(), () => this.openSettings()));
    this.addSettingTab(new NotePiSettingsTab(this.app, this));
    this.addCommand({ id: "open-chat", name: "Open Note Pi", callback: () => this.activateView() });
    this.addCommand({ id: "open-settings", name: "Open Note Pi settings", callback: () => this.openSettings() });
    this.addCommand({ id: "check-harness", name: "Check bundled harness runtime", callback: async () => {
      const event = await this.requestHealth();
      new Notice(`Harness ready, Node ${event.node}.`);
    } });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_NOTE_PI);
    this.harness?.close();
    this.harness = undefined;
  }

  providerOptions() { return AUTH_PROVIDERS; }
  selectedProvider() { return AUTH_PROVIDERS.find((provider) => provider.id === this.settings.providerId) ?? AUTH_PROVIDERS[0]; }
  providerStatus() { return this.startHarness().providerState(this.settings.providerId); }

  async saveProvider(providerId: string) {
    this.settings.providerId = providerId;
    await this.saveData(this.settings);
    await this.configureHarness();
  }

  async saveApiKey(apiKey: string) {
    this.settings.credentials = await this.startHarness().loginWithApiKey(this.settings.providerId, apiKey);
    await this.saveData(this.settings);
  }

  async logoutProvider(providerId: string) {
    this.settings.credentials = await this.startHarness().logout(providerId);
    await this.saveData(this.settings);
  }

  defaultAgentDir() { return resolve(this.vaultPath(), ".pi", "agent"); }
  async saveAgentDir(agentDir: string) {
    this.settings.agentDir = agentDir.trim() ? (isAbsolute(agentDir.trim()) ? resolve(agentDir.trim()) : resolve(this.vaultPath(), agentDir.trim())) : this.defaultAgentDir();
    await this.saveData(this.settings);
    await this.configureHarness();
  }

  openSettings() {
    const settings = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  async activateView() {
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_NOTE_PI, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private nextRequestId() {
    this.requestSequence += 1;
    return `request-${this.requestSequence}`;
  }

  private startHarness() {
    if (!this.harness) this.harness = new EmbeddedHarness();
    return this.harness;
  }

  private normalizeSettings(saved: Partial<NotePiSettings> | null): NotePiSettings {
    const { modelId: _legacyModelId, ...savedConfiguration } = (saved ?? {}) as Partial<NotePiSettings> & { modelId?: string };
    const credentials = { ...(savedConfiguration.credentials ?? {}) };
    if (savedConfiguration.googleApiKey?.trim() && !credentials.google) credentials.google = { type: "api_key", key: savedConfiguration.googleApiKey.trim() };
    const providerId = AUTH_PROVIDERS.some((provider) => provider.id === savedConfiguration.providerId) ? savedConfiguration.providerId ?? "google" : "google";
    const agentDir = savedConfiguration.agentDir?.trim() ? savedConfiguration.agentDir : this.defaultAgentDir();
    return { ...DEFAULT_SETTINGS, ...savedConfiguration, agentDir, credentials, providerId, googleApiKey: "" };
  }

  private async configureHarness() {
    await this.startHarness().applyPluginConfiguration({
      providerId: this.settings.providerId,
      credentials: this.settings.credentials,
      vaultPath: (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(),
      agentDir: this.settings.agentDir,
      enabledTools: ["read"]
    });
  }

  private vaultPath() { return (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(); }

  private async requestHealth(): Promise<HarnessEvent> {
    return this.startHarness().health(this.nextRequestId());
  }
}
