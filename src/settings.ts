import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NotePiPlugin from "./main";

export class NotePiSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: NotePiPlugin) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Note Pi" });
    this.containerEl.createEl("p", { text: "Choose a provider, then connect it with an API key or supported subscription sign-in." });
    new Setting(this.containerEl)
      .setName("Provider")
      .setDesc("The selected provider supplies the model used for new chat turns.")
      .addDropdown((dropdown) => {
        for (const provider of this.plugin.providerOptions()) dropdown.addOption(provider.id, provider.label);
        dropdown.setValue(this.plugin.settings.providerId).onChange(async (providerId) => this.plugin.saveProvider(providerId));
      });

    const provider = this.plugin.selectedProvider();
    const status = this.plugin.providerStatus();
    if (provider.supportsApiKey) {
      let apiKeyInput: HTMLInputElement;
      new Setting(this.containerEl)
        .setName(provider.apiKeyLabel ?? "API key")
        .setDesc(status === "configured" ? "An API key or sign-in credential is stored locally for this provider." : "Stored in this plugin's local data file, not OS keychain storage.")
        .addText((text) => {
          text.setPlaceholder("Paste an API key");
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
    }

    if (provider.supportsOAuth) {
      new Setting(this.containerEl)
        .setName(`${provider.label} sign-in`)
        .setDesc("Uses Pi's provider-owned browser sign-in. Tokens are refreshed by the harness and stored in plugin data.")
        .addButton((button) => button.setButtonText(`Sign in to ${provider.label}`).setCta().onClick(async () => {
          button.setButtonText("Waiting for sign-in…").setDisabled(true);
          try {
            await this.plugin.loginWithOAuth(provider.id);
            new Notice(`${provider.label} connected.`);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Provider sign-in could not start.");
          } finally {
            this.display();
          }
        }));
    } else {
      this.containerEl.createEl("p", { cls: "note-pi-auth-note", text: "Google account browser sign-in is not bundled by Pi. Use a Gemini API key, including one with Google AI Studio free-tier quota." });
    }

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
