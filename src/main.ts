import { Plugin, Notice, WorkspaceLeaf } from "obsidian";
import { checkPiRuntime } from "./plugin/runtime-compatibility";
import { AUTH_PROVIDERS, EmbeddedHarness } from "./harness/host.mjs";
import { NotePiSettingsTab } from "./settings";
import { ObsidianAgentView, VIEW_TYPE_NOTE_PI } from "./view";

type HarnessEvent = { type: string; requestId: string; node?: string; pid?: number };
type OAuthPrompt = { message: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] };
type OAuthEvent = { type: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string };
export interface NotePiCredential { type: "api_key" | "oauth"; key?: string; access?: string; refresh?: string; expires?: number; [key: string]: unknown; }
export interface NotePiSettings { providerId: string; credentials: Record<string, NotePiCredential>; googleApiKey?: string; }
const DEFAULT_SETTINGS: NotePiSettings = { providerId: "google", credentials: {}, googleApiKey: "" };

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
    await this.configureHarness();
    this.registerView(VIEW_TYPE_NOTE_PI, (leaf) => new ObsidianAgentView(leaf, this));
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

  isProviderConfigured() { return this.providerStatus() === "configured"; }
  getTranscript() { return this.startHarness().transcript(); }
  cancelChat() { this.startHarness().cancel(); }
  async submitChat(prompt: string, onDelta: (delta: string) => void) { return this.startHarness().submit(prompt, onDelta); }
  providerOptions() { return AUTH_PROVIDERS; }
  selectedProvider() { return AUTH_PROVIDERS.find((provider) => provider.id === this.settings.providerId) ?? AUTH_PROVIDERS[0]; }
  providerStatus() { return this.startHarness().providerState(this.settings.providerId); }

  async saveProvider(providerId: string) {
    this.settings.providerId = providerId;
    await this.saveData(this.settings);
    await this.configureHarness();
    this.refreshViews();
  }

  async saveApiKey(apiKey: string) {
    await this.startHarness().loginWithApiKey(this.settings.providerId, apiKey);
    this.refreshViews();
  }

  async loginWithOAuth(providerId: string) {
    await this.startHarness().loginWithOAuth(providerId, {
      prompt: async (prompt: OAuthPrompt) => {
        const options = prompt.options?.map((option) => `${option.id}: ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n");
        const answer = window.prompt(options ? `${prompt.message}\n\n${options}` : prompt.message, prompt.options?.[0]?.id ?? prompt.placeholder ?? "");
        if (answer === null) throw new Error("Sign-in cancelled.");
        return answer;
      },
      notify: (event: OAuthEvent) => {
        if (event.type === "auth_url") {
          new Notice(event.instructions ?? "Continue sign-in in your browser.");
          window.open(event.url, "_blank");
        } else if (event.type === "device_code") {
          new Notice(`Enter code ${event.userCode} at ${event.verificationUri}`);
          window.open(event.verificationUri, "_blank");
        } else {
          new Notice(event.message ?? "Provider sign-in is in progress.");
        }
      }
    });
    this.refreshViews();
  }

  async logoutProvider(providerId: string) {
    await this.startHarness().logout(providerId);
    this.refreshViews();
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
    const credentials = { ...(saved?.credentials ?? {}) };
    if (saved?.googleApiKey?.trim() && !credentials.google) credentials.google = { type: "api_key", key: saved.googleApiKey.trim() };
    return { ...DEFAULT_SETTINGS, ...saved, credentials, providerId: saved?.providerId ?? "google", googleApiKey: "" };
  }

  private async configureHarness() {
    await this.startHarness().configure({
      providerId: this.settings.providerId,
      credentials: this.settings.credentials,
      persistCredentials: async (credentials: Record<string, NotePiCredential>) => {
        this.settings.credentials = credentials;
        this.settings.googleApiKey = "";
        await this.saveData(this.settings);
      }
    });
  }

  private refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTE_PI)
      .forEach((leaf: WorkspaceLeaf) => (leaf.view as ObsidianAgentView).refreshProviderState());
  }

  private async requestHealth(): Promise<HarnessEvent> {
    return this.startHarness().health(this.nextRequestId());
  }
}
