import { App, DropdownComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";

export interface ProviderInfo { id: string; label: string; apiKeyLabel: string; }
export interface StoredCredential { type: "api_key"; key?: string; }
export interface ExtensionInfo { name: string; description: string; }

/** Result of a provider connection probe, shown in the settings tab. */
export interface ProviderTestResult { model: string; latencyMs: number; }

/** Mask a stored key so the settings tab can confirm a key without leaking it. */
export function maskCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/**
 * Structural contract the settings tab needs from its host plugin. Both the
 * desktop NotePiPlugin and the mobile NotePiMobilePlugin satisfy it; the Pi
 * agent directory, extension inventory, and focused-note toggle only render
 * when the host exposes their (desktop-only) persistence methods.
 */
export interface ProviderConfigHost {
  settings: { providerId: string; agentDir?: string; credentials?: Record<string, StoredCredential> };
  providerOptions(): ProviderInfo[];
  providerStatus(providerId?: string): string;
  saveApiKey(apiKey: string, providerId?: string): Promise<void>;
  logoutProvider(providerId: string): Promise<void>;
  testProvider?(providerId: string): Promise<ProviderTestResult>;
  defaultAgentDir?(): string;
  saveAgentDir?(agentDir: string): Promise<void>;
  autoContextNote?(): boolean;
  setAutoContextNote?(enabled: boolean): Promise<void>;
  extensionStatus?(): { extensions: ExtensionInfo[] };
}

type SettingsTabId = "general" | "providers" | "extensions";

export class NotePiSettingsTab extends PluginSettingTab {
  private activeTab: SettingsTabId = "general";
  /** Last connection-check outcome per provider, for this settings session. */
  private testOutcomes = new Map<string, { ok: boolean; detail: string }>();
  /** Provider whose key is being edited. Local to this tab — key management never changes the chat provider. */
  private editingProviderId?: string;
  private providerDropdown?: DropdownComponent;
  private keyInput?: HTMLInputElement;

  constructor(app: App, private readonly plugin: Plugin & ProviderConfigHost) { super(app, plugin); }

  private hasGeneralSettings(): boolean {
    return Boolean(
      (this.plugin.autoContextNote && this.plugin.setAutoContextNote) ||
      (this.plugin.defaultAgentDir && this.plugin.saveAgentDir)
    );
  }

  private hasExtensionSettings(): boolean {
    return Boolean(this.plugin.extensionStatus);
  }

  display(): void {
    if (this.activeTab === "general" && !this.hasGeneralSettings()) this.activeTab = this.hasExtensionSettings() ? "extensions" : "providers";
    if (this.activeTab === "extensions" && !this.hasExtensionSettings()) this.activeTab = this.hasGeneralSettings() ? "general" : "providers";
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Note Pi" });
    if (this.hasGeneralSettings() || this.hasExtensionSettings()) this.renderTabBar();
    const content = this.containerEl.createDiv({ cls: "note-pi-settings-content" });
    if (this.activeTab === "general") this.renderGeneralTab(content);
    else if (this.activeTab === "extensions") this.renderExtensionsTab(content);
    else this.renderProvidersTab(content);
  }

  private renderTabBar(): void {
    const bar = this.containerEl.createDiv({ cls: "note-pi-settings-tabs" });
    bar.setAttr("role", "tablist");
    const tabs: [SettingsTabId, string][] = [
      ...(this.hasGeneralSettings() ? [["general", "General"] as [SettingsTabId, string]] : []),
      ...(this.hasExtensionSettings() ? [["extensions", "Extensions"] as [SettingsTabId, string]] : []),
      ["providers", "API Provider"]
    ];
    for (const [id, label] of tabs) {
      // Reuse Obsidian's native settings-nav item classes so the tabs pick up
      // whatever theme is installed instead of a bespoke look.
      const button = bar.createDiv({ cls: `vertical-tab-nav-item note-pi-settings-tab${this.activeTab === id ? " is-active" : ""}`, text: label });
      button.setAttr("role", "tab");
      button.setAttr("tabindex", "0");
      button.setAttr("aria-selected", String(this.activeTab === id));
      const activate = () => {
        this.activeTab = id;
        this.display();
      };
      button.addEventListener("click", activate);
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
    }
  }

  // --- General tab -------------------------------------------------------------

  private renderGeneralTab(container: HTMLElement): void {
    if (this.plugin.autoContextNote && this.plugin.setAutoContextNote) {
      const plugin = this.plugin;
      new Setting(container)
        .setName("Attach the focused note")
        .addToggle((toggle) => toggle.setValue(plugin.autoContextNote!()).onChange(async (enabled) => {
          await plugin.setAutoContextNote!(enabled);
        }));
    }

    if (this.plugin.defaultAgentDir && this.plugin.saveAgentDir) {
      const plugin = this.plugin;
      let agentDirInput: HTMLInputElement;
      new Setting(container)
        .setName("Pi agent directory")
        .setDesc("Vault-relative directory where Note Pi discovers local extensions and stores its sessions.")
        .addText((text) => {
          text.setPlaceholder(plugin.defaultAgentDir!());
          text.setValue(plugin.settings.agentDir ?? "");
          agentDirInput = text.inputEl;
        })
        .addButton((button) => button.setButtonText("Save directory").onClick(async () => {
          await plugin.saveAgentDir!(agentDirInput.value);
          new Notice("Pi agent directory saved.");
          this.display();
        }));
    }
  }

  // --- Extensions tab ----------------------------------------------------------

  private renderExtensionsTab(container: HTMLElement): void {
    const extensions = this.plugin.extensionStatus?.().extensions ?? [];
    const table = container.createEl("table", { cls: "note-pi-extension-table" });
    const header = table.createEl("thead").createEl("tr");
    header.createEl("th", { text: "Extension" });
    header.createEl("th", { text: "Description" });
    const body = table.createEl("tbody");
    for (const extension of extensions) {
      const row = body.createEl("tr");
      row.createEl("td", { text: extension.name });
      row.createEl("td", { text: extension.description });
    }
  }

  // --- API Provider tab ----------------------------------------------------------

  private editingProvider(): ProviderInfo {
    const options = this.plugin.providerOptions();
    return options.find((provider) => provider.id === this.editingProviderId)
      ?? options.find((provider) => provider.id === this.plugin.settings.providerId)
      ?? options[0];
  }

  private renderProvidersTab(container: HTMLElement): void {
    const provider = this.editingProvider();
    new Setting(container)
      .setName("Provider")
      .addDropdown((dropdown) => {
        for (const option of this.plugin.providerOptions()) dropdown.addOption(option.id, option.label);
        dropdown.setValue(provider.id).onChange((providerId) => {
          this.editingProviderId = providerId;
          this.display();
        });
        this.providerDropdown = dropdown;
      });

    // Key entry for the selected provider: first-time setup and key changes
    // both happen here; saved keys are listed below.
    const configured = this.plugin.providerStatus(provider.id) === "configured";
    new Setting(container)
      .setName(provider.apiKeyLabel)
      .setClass("note-pi-key-sub")
      .addText((text) => {
        text.setPlaceholder(configured ? `Replace ${provider.apiKeyLabel}` : `Paste ${provider.apiKeyLabel}`);
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        this.keyInput = text.inputEl;
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void this.saveSelectedKey();
          }
        });
      })
      .addExtraButton((button) => {
        button.setIcon("corner-down-left").setTooltip(configured ? "Replace the saved key (Enter)" : "Save key (Enter)");
        button.extraSettingsEl.setAttr("aria-label", configured ? `Replace ${provider.label} API key` : `Save ${provider.label} API key`);
        button.onClick(() => void this.saveSelectedKey());
      });

    const configuredProviders = this.plugin.providerOptions().filter((option) => this.plugin.providerStatus(option.id) === "configured");
    new Setting(container).setName("Added keys").setHeading();
    if (!configuredProviders.length) {
      container.createEl("p", { cls: "note-pi-settings-empty", text: "No saved keys yet." });
      return;
    }
    for (const option of configuredProviders) this.renderSavedKeyRow(container, option);
  }

  private async saveSelectedKey(): Promise<void> {
    const provider = this.editingProvider();
    if (!this.keyInput) return;
    try {
      await this.plugin.saveApiKey(this.keyInput.value, provider.id);
      new Notice(`${provider.label} API key saved.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not save the API key.");
    } finally {
      this.display();
    }
  }

  private renderSavedKeyRow(container: HTMLElement, provider: ProviderInfo): void {
    const stored = this.plugin.settings.credentials?.[provider.id];
    const masked = stored?.key?.trim() ? maskCredentialKey(stored.key) : undefined;
    let desc = `Key saved (${masked ?? "stored"})`;
    const outcome = this.testOutcomes.get(provider.id);
    if (outcome) desc += outcome.ok ? ` — last check: ${outcome.detail}` : ` — last check failed: ${outcome.detail}`;

    const row = new Setting(container)
      .setName(provider.label)
      .setDesc(desc);

    row.addExtraButton((button) => {
      button.setIcon("pencil").setTooltip(`Replace the ${provider.label} key`);
      button.extraSettingsEl.setAttr("aria-label", `Replace ${provider.label} API key`);
      button.onClick(() => {
        this.editingProviderId = provider.id;
        this.providerDropdown?.setValue(provider.id);
        this.display();
        this.keyInput?.focus();
      });
    });

    if (this.plugin.testProvider) {
      row.addExtraButton((button) => {
        button.setIcon("zap").setTooltip("Test the connection with the saved key");
        button.extraSettingsEl.setAttr("aria-label", `Test ${provider.label} connection`);
        button.onClick(async () => {
          button.setDisabled(true);
          button.setTooltip("Testing…");
          try {
            const result = await this.plugin.testProvider!(provider.id);
            const latency = `${(result.latencyMs / 1000).toFixed(1)}s`;
            this.testOutcomes.set(provider.id, { ok: true, detail: `connected via ${result.model} in ${latency}` });
            new Notice(`${provider.label} connection OK (${result.model}, ${latency}).`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Connection failed.";
            this.testOutcomes.set(provider.id, { ok: false, detail: message });
            new Notice(`${provider.label} connection failed: ${message}`);
          } finally {
            this.display();
          }
        });
      });
    }

    row.addExtraButton((button) => {
      button.setIcon("x").setTooltip(`Remove the ${provider.label} key`);
      button.extraSettingsEl.setAttr("aria-label", `Remove ${provider.label} key`);
      button.onClick(async () => {
        await this.plugin.logoutProvider(provider.id);
        this.testOutcomes.delete(provider.id);
        new Notice(`${provider.label} key removed.`);
        this.display();
      });
    });
  }
}
