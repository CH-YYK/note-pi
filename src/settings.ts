import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidianAgentPlugin from "./main";

export class ObsidianAgentSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianAgentPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Note Pi" });
    this.containerEl.createEl("p", { text: "Configure the local model provider used by the bundled Pi harness." });
    new Setting(this.containerEl)
      .setName("Gemini API key")
      .setDesc("Stored in this plugin's local data file (not OS keychain storage). The key is never shown in the chat transcript.")
      .addText((text) => text
        .setPlaceholder("AIza…")
        .setValue(this.plugin.settings.googleApiKey)
        .then((input) => { input.inputEl.type = "password"; })
        .onChange(async (value) => this.plugin.saveProviderKey(value)));
  }
}
