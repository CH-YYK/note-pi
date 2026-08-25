import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";

export interface ProviderInfo { id: string; label: string; apiKeyLabel: string; }

/**
 * Structural contract the settings tab needs from its host plugin. Both the
 * desktop NotePiPlugin and the mobile NotePiMobilePlugin satisfy it; the Pi
 * agent directory section only renders when the host exposes saveAgentDir
 * (desktop-only capability).
 */
export interface ProviderConfigHost {
  settings: { providerId: string; agentDir?: string };
  providerOptions(): ProviderInfo[];
  selectedProvider(): ProviderInfo;
  providerStatus(): string;
  saveProvider(providerId: string): Promise<void>;
  saveApiKey(apiKey: string): Promise<void>;
  logoutProvider(providerId: string): Promise<void>;
  defaultAgentDir?(): string;
  saveAgentDir?(agentDir: string): Promise<void>;
}

export class NotePiSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: Plugin & ProviderConfigHost) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Note Pi" });
    this.containerEl.createEl("p", { text: "Choose a provider, then connect it with its API key or token." });
    new Setting(this.containerEl)
      .setName("Provider")
      .setDesc("The selected provider supplies the model used for new chat turns.")
      .addDropdown((dropdown) => {
        for (const provider of this.plugin.providerOptions()) dropdown.addOption(provider.id, provider.label);
        dropdown.setValue(this.plugin.settings.providerId).onChange(async (providerId) => this.plugin.saveProvider(providerId));
      });

    const provider = this.plugin.selectedProvider();

    const { defaultAgentDir, saveAgentDir } = this.plugin;
    if (defaultAgentDir && saveAgentDir) {
      let agentDirInput: HTMLInputElement;
      new Setting(this.containerEl)
        .setName("Pi agent directory")
        .setDesc(`Vault-relative resource root for future Pi skills, extensions, prompts, and settings. Default: ${defaultAgentDir()}`)
        .addText((text) => {
          text.setPlaceholder(defaultAgentDir());
          text.setValue(this.plugin.settings.agentDir ?? "");
          agentDirInput = text.inputEl;
        })
        .addButton((button) => button.setButtonText("Save directory").onClick(async () => {
          await saveAgentDir(agentDirInput.value);
          new Notice("Pi agent directory saved.");
          this.display();
        }));
    }

    const status = this.plugin.providerStatus();
    let apiKeyInput: HTMLInputElement;
    new Setting(this.containerEl)
      .setName(provider.apiKeyLabel)
      .setDesc(status === "configured" ? "An API key or token is stored locally for this provider." : "Stored in this plugin's local data file, not OS keychain storage.")
      .addText((text) => {
        text.setPlaceholder("Paste an API key or token");
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        apiKeyInput = text.inputEl;
      })
      .addButton((button) => button.setButtonText("Save API key").setCta().onClick(async () => {
        try {
          await this.plugin.saveApiKey(apiKeyInput.value);
          new Notice(`${provider.label} API key saved.`);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not save the API key.");
        } finally {
          this.display();
        }
      }));

    if (status === "configured") {
      new Setting(this.containerEl)
        .setName("Disconnect provider")
        .setDesc("Removes the stored credential for this provider from Note Pi.")
        .addButton((button) => button.setButtonText("Disconnect").setWarning().onClick(async () => {
          await this.plugin.logoutProvider(provider.id);
          new Notice(`${provider.label} disconnected.`);
          this.display();
        }));
    }
  }
}
