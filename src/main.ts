import { Plugin, Notice, WorkspaceLeaf } from "obsidian";
import { checkPiRuntime } from "./plugin/runtime-compatibility";
import { EmbeddedHarness } from "./harness/host.mjs";
import { ObsidianAgentSettingsTab } from "./settings";
import { ObsidianAgentView, VIEW_TYPE_OBSIDIAN_AGENT } from "./view";

type HarnessEvent = { type: string; requestId: string; node?: string; pid?: number };
export interface ObsidianAgentSettings { googleApiKey: string; }
const DEFAULT_SETTINGS: ObsidianAgentSettings = { googleApiKey: "" };

export default class ObsidianAgentPlugin extends Plugin {
  private harness?: EmbeddedHarness;
  private requestSequence = 0;
  settings: ObsidianAgentSettings = DEFAULT_SETTINGS;

  async onload() {
    const runtime = checkPiRuntime(process.versions.node);
    if (!runtime.supported) {
      new Notice(`Obsidian Agent disabled: ${runtime.message}`);
      return;
    }
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    await this.startHarness().configure(this.settings);
    this.registerView(VIEW_TYPE_OBSIDIAN_AGENT, (leaf) => new ObsidianAgentView(leaf, this));
    this.addSettingTab(new ObsidianAgentSettingsTab(this.app, this));
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => this.activateView() });

    this.addCommand({
      id: "check-harness",
      name: "Check bundled harness runtime",
      callback: async () => {
        const event = await this.requestHealth();
        new Notice(`Harness ready, Node ${event.node}.`);
      }
    });
    this.addCommand({
      id: "verify-harness-chat",
      name: "Verify bundled harness chat",
      callback: async () => {
        const text = await this.startHarness().chat("Reply with exactly: harness chat works");
        new Notice(`Harness chat: ${text}`);
      }
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OBSIDIAN_AGENT);
    this.harness?.close();
    this.harness = undefined;
  }

  private nextRequestId() {
    this.requestSequence += 1;
    return `request-${this.requestSequence}`;
  }

  private startHarness() {
    if (!this.harness) this.harness = new EmbeddedHarness();
    return this.harness;
  }

  isProviderConfigured() { return this.startHarness().providerState() === "configured"; }
  getTranscript() { return this.startHarness().transcript(); }
  cancelChat() { this.startHarness().cancel(); }
  async submitChat(prompt: string, onDelta: (delta: string) => void) { return this.startHarness().submit(prompt, onDelta); }
  async saveProviderKey(googleApiKey: string) {
    this.settings = { googleApiKey: googleApiKey.trim() };
    await this.saveData(this.settings);
    await this.startHarness().configure(this.settings);
    this.refreshViews();
  }
  openSettings() {
    const settings = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
  }
  async activateView() {
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_OBSIDIAN_AGENT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  private refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSIDIAN_AGENT)
      .forEach((leaf: WorkspaceLeaf) => (leaf.view as ObsidianAgentView).refreshProviderState());
  }

  private async requestHealth(): Promise<HarnessEvent> {
    const harness = this.startHarness();
    const requestId = this.nextRequestId();
    return harness.health(requestId);
  }
}
