import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";

export interface ProviderInfo { id: string; label: string; apiKeyLabel: string; }
export interface ExtensionInfo { path: string; tools: string[]; commands: string[]; }
export interface ExtensionError { path: string; error: string; }

/**
 * Structural contract the settings tab needs from its host plugin. Both the
 * desktop NotePiPlugin and the mobile NotePiMobilePlugin satisfy it; the Pi
 * agent directory and extension controls only render when the host exposes
 * their desktop-only persistence methods.
 */
export interface ProviderConfigHost {
  settings: { providerId: string; agentDir?: string; extensions?: string[] };
  providerOptions(): ProviderInfo[];
  selectedProvider(): ProviderInfo;
  providerStatus(): string;
  saveProvider(providerId: string): Promise<void>;
  saveApiKey(apiKey: string): Promise<void>;
  logoutProvider(providerId: string): Promise<void>;
  defaultAgentDir?(): string;
  saveAgentDir?(agentDir: string): Promise<void>;
  saveExtensions?(extensionPaths: string[]): Promise<void>;
  reloadExtensions?(): Promise<void>;
  extensionStatus?(): { extensions: ExtensionInfo[]; errors: ExtensionError[] };
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

    const { saveExtensions, reloadExtensions, extensionStatus } = this.plugin;
    if (saveExtensions) {
      let extensionPathsInput: HTMLTextAreaElement;
      const status = extensionStatus?.() ?? { extensions: [], errors: [] };
      const manager = this.containerEl.createDiv({ cls: "note-pi-extension-manager" });
      const heading = manager.createDiv({ cls: "note-pi-extension-manager-heading" });
      const copy = heading.createDiv();
      copy.createEl("h3", { text: "Extensions" });
      copy.createDiv({ cls: "note-pi-extension-manager-copy", text: "Trusted, vault-local capabilities for Note Pi." });
      const badgeText = status.errors.length ? `${status.errors.length} need attention` : `${status.extensions.length} loaded`;
      heading.createDiv({ cls: `note-pi-extension-manager-badge${status.errors.length ? " is-error" : ""}`, text: badgeText });

      const overview = manager.createDiv({ cls: "note-pi-extension-overview" });
      if (status.extensions.length) {
        for (const extension of status.extensions) {
          const card = overview.createDiv({ cls: "note-pi-extension-card" });
          card.createDiv({ cls: "note-pi-extension-name", text: extension.path.split("/").at(-1) ?? extension.path });
          const capabilities = [
            extension.tools.length ? `Tools: ${extension.tools.join(", ")}` : "No tools",
            extension.commands.length ? `Commands: ${extension.commands.map((command) => `/${command}`).join(", ")}` : "No commands"
          ];
          card.createDiv({ cls: "note-pi-extension-capabilities", text: capabilities.join(" · ") });
          card.createDiv({ cls: "note-pi-extension-path", text: extension.path });
        }
      } else {
        overview.createDiv({ cls: "note-pi-extension-empty", text: "No extension modules are loaded. Add a source below or place a module in the default extensions folder." });
      }
      for (const failure of status.errors) {
        const card = overview.createDiv({ cls: "note-pi-extension-card is-error" });
        card.createDiv({ cls: "note-pi-extension-name", text: failure.path.split("/").at(-1) ?? failure.path });
        card.createDiv({ cls: "note-pi-extension-capabilities", text: failure.error });
      }

      new Setting(manager)
        .setName("Extension sources")
        .setDesc("One vault-relative TypeScript or JavaScript file, extension package directory, or extension directory per line. The default <agent directory>/extensions folder is always included.")
        .addTextArea((text) => {
          text.setPlaceholder("_pi/agent/extensions/my-extension.ts");
          text.setValue((this.plugin.settings.extensions ?? []).join("\n"));
          text.inputEl.rows = 4;
          extensionPathsInput = text.inputEl;
        })
        .addButton((button) => button.setButtonText("Save extensions").onClick(async () => {
          try {
            await saveExtensions(extensionPathsInput.value.split(/\r?\n/));
            new Notice("Extension sources saved and reloaded.");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Could not save extension sources.");
          } finally {
            this.display();
          }
        }));
      if (reloadExtensions) {
        new Setting(manager)
          .setName("Reload installed extensions")
          .setDesc("Re-read extension files and refresh the status above. Your active chat session is restarted.")
          .addButton((button) => button.setButtonText("Reload extensions").onClick(async () => {
            try {
              await reloadExtensions();
              new Notice("Extensions reloaded.");
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Could not reload extensions.");
            } finally {
              this.display();
            }
          }));
      }
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
