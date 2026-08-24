import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NotePiPlugin from "./main";

export class NotePiSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: NotePiPlugin) { super(app, plugin); }

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
    const models = this.plugin.modelOptions();
    new Setting(this.containerEl)
      .setName("Model")
      .setDesc("Choose the model Note Pi uses for new chat turns.")
      .addDropdown((dropdown) => {
        for (const model of models) dropdown.addOption(model.id, model.label);
        dropdown.setValue(this.plugin.selectedModel()?.id ?? provider.defaultModel).onChange(async (modelId) => this.plugin.saveModel(modelId));
      });

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
