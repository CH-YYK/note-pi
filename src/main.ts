import { Plugin, Notice, WorkspaceLeaf } from "obsidian";
import { isAbsolute, relative, resolve } from "node:path";
import { checkPiRuntime } from "./plugin/runtime-compatibility";
import { AUTH_PROVIDERS, AgentController } from "./harness/host.mjs";
import { NotePiSettingsTab } from "./settings";
import { ObsidianAgentView, VIEW_TYPE_NOTE_PI } from "./view";

type HarnessEvent = { type: string; requestId: string; node?: string; pid?: number };
export interface NotePiCredential { type: "api_key"; key?: string; [key: string]: unknown; }
export interface NotePiSettings { providerId: string; agentDir: string; autoContextNote: boolean; extensions: string[]; credentials: Record<string, NotePiCredential>; googleApiKey?: string; }
const DEFAULT_SETTINGS: NotePiSettings = { providerId: "google", agentDir: "", autoContextNote: true, extensions: [], credentials: {}, googleApiKey: "" };

export default class NotePiPlugin extends Plugin {
  private controller?: AgentController;
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
    this.registerView(VIEW_TYPE_NOTE_PI, (leaf) => new ObsidianAgentView(leaf, this.startHarness(), () => this.openSettings(), {
      autoContextNote: () => this.settings.autoContextNote,
      setAutoContextNote: (enabled) => this.setAutoContextNote(enabled)
    }));
    // A leaf restored from the workspace layout can be created through a
    // previous plugin instance's registration, binding it to a dead harness
    // (default provider, empty sessions). Force recreation so every view
    // binds to this instance's controller.
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_NOTE_PI);
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
    this.controller?.close();
    this.controller = undefined;
  }

  providerOptions() { return AUTH_PROVIDERS; }
  providerStatus(providerId = this.settings.providerId) { return this.startHarness().providerState(providerId); }
  extensionStatus() {
    const snapshot = this.startHarness().snapshot();
    return { extensions: snapshot.extensions, errors: snapshot.extensionErrors };
  }

  async saveApiKey(apiKey: string, providerId = this.settings.providerId) {
    this.settings.credentials = await this.startHarness().loginWithApiKey(providerId, apiKey);
    await this.saveData(this.settings);
  }

  async logoutProvider(providerId: string) {
    this.settings.credentials = await this.startHarness().logout(providerId);
    await this.saveData(this.settings);
  }

  testProvider(providerId: string) {
    return this.startHarness().testProviderConnection(providerId);
  }

  defaultAgentDir() { return "_pi/agent"; }
  async saveAgentDir(agentDir: string) {
    this.settings.agentDir = this.normalizeAgentDir(agentDir);
    await this.saveData(this.settings);
    await this.configureHarness();
  }

  autoContextNote() { return this.settings.autoContextNote; }
  async setAutoContextNote(enabled: boolean) {
    this.settings.autoContextNote = enabled;
    await this.saveData(this.settings);
  }

  async saveExtensions(extensionPaths: string[]) {
    this.settings.extensions = this.normalizeExtensionPaths(extensionPaths);
    await this.saveData(this.settings);
    await this.configureHarness();
  }

  async reloadExtensions() {
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
    if (!this.controller) this.controller = new AgentController();
    return this.controller;
  }

  /** Public lookup so restored views can rebind to the live harness. */
  harnessClient() {
    return this.startHarness();
  }

  private normalizeSettings(saved: Partial<NotePiSettings> | null): NotePiSettings {
    const { modelId: _legacyModelId, ...savedConfiguration } = (saved ?? {}) as Partial<NotePiSettings> & { modelId?: string };
    const credentials = { ...(savedConfiguration.credentials ?? {}) };
    if (savedConfiguration.googleApiKey?.trim() && !credentials.google) credentials.google = { type: "api_key", key: savedConfiguration.googleApiKey.trim() };
    // Drop credentials for providers that no longer exist in the catalog.
    for (const id of Object.keys(credentials)) {
      if (!AUTH_PROVIDERS.some((provider) => provider.id === id)) delete credentials[id];
    }
    const providerId = AUTH_PROVIDERS.some((provider) => provider.id === savedConfiguration.providerId) ? savedConfiguration.providerId ?? "google" : "google";
    const agentDir = this.normalizeAgentDir(savedConfiguration.agentDir === ".pi/agent" ? "" : savedConfiguration.agentDir ?? "");
    const extensions = this.normalizeExtensionPaths(savedConfiguration.extensions ?? [], false);
    return { ...DEFAULT_SETTINGS, ...savedConfiguration, agentDir, extensions, credentials, providerId, googleApiKey: "" };
  }

  private async configureHarness() {
    await this.startHarness().applyPluginConfiguration({
      providerId: this.settings.providerId,
      credentials: this.settings.credentials,
      vaultPath: (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(),
      agentDir: resolve(this.vaultPath(), this.settings.agentDir),
      extensionPaths: this.settings.extensions.map((extensionPath) => resolve(this.vaultPath(), extensionPath)),
      enabledTools: ["read"],
      jitiPath: resolve(this.vaultPath(), this.manifest.dir ?? "", "runtime/jiti/lib/jiti.cjs")
    });
  }

  private vaultPath() { return (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(); }
  private normalizeAgentDir(value: string) {
    const resolved = resolve(this.vaultPath(), value.trim() || this.defaultAgentDir());
    const vaultRelative = relative(this.vaultPath(), resolved);
    if (!vaultRelative || vaultRelative === ".." || vaultRelative.startsWith(`..${"/"}`)) throw new Error("Pi agent directory must be inside this vault.");
    return vaultRelative.replaceAll("\\", "/");
  }

  /** Store extension sources as vault-relative paths, never host paths. */
  private normalizeExtensionPaths(values: unknown, rejectInvalid = true) {
    if (!Array.isArray(values)) return [];
    const normalized = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) continue;
      try {
        if (isAbsolute(value.trim())) throw new Error("Extension paths must be vault-relative.");
        const resolved = resolve(this.vaultPath(), value.trim());
        const vaultRelative = relative(this.vaultPath(), resolved);
        if (!vaultRelative || vaultRelative === ".." || vaultRelative.startsWith(`..${"/"}`)) {
          throw new Error("Extension paths must stay inside this vault.");
        }
        normalized.add(vaultRelative.replaceAll("\\", "/"));
      } catch (error) {
        if (rejectInvalid) throw error;
      }
    }
    return [...normalized];
  }

  private async requestHealth(): Promise<HarnessEvent> {
    return this.startHarness().health(this.nextRequestId());
  }
}
