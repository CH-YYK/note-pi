import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type { HarnessClient, HarnessSnapshot } from "./harness/client";

export const VIEW_TYPE_NOTE_PI = "note-pi-view";

export class ObsidianAgentView extends ItemView {
  private transcriptEl!: HTMLElement;
  private composerEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private isStreaming = false;
  private snapshot!: HarnessSnapshot;
  private unsubscribe?: () => void;

  constructor(leaf: WorkspaceLeaf, private readonly harness: HarnessClient, private readonly openSettings: () => void) {
    super(leaf);
    this.snapshot = harness.snapshot();
  }

  getViewType() { return VIEW_TYPE_NOTE_PI; }
  getDisplayText() { return "Note Pi"; }
  getIcon() { return "bot"; }

  async onOpen() {
    this.unsubscribe = this.harness.subscribe((event) => {
      if (event.snapshot) {
        this.snapshot = event.snapshot;
        this.render();
      }
    });
    this.render();
  }
  async onClose() { this.unsubscribe?.(); }

  render() {
    this.contentEl.empty();
    this.contentEl.addClass("note-pi-view");
    this.renderHeader();
    this.transcriptEl = this.contentEl.createDiv({ cls: "agent-transcript" });
    this.renderTranscript();
    if (this.snapshot.providerState === "configured") this.renderComposer();
    else this.renderSetupCard();
  }

  private renderHeader() {
    const header = this.contentEl.createDiv({ cls: "agent-header" });
    header.createDiv({ cls: "agent-title", text: "Note Pi" });
    const modelPicker = header.createDiv({ cls: "agent-model-picker" });
    modelPicker.createSpan({ cls: "agent-model-label", text: "Model" });
    const select = modelPicker.createEl("select", { cls: "dropdown agent-model-select", attr: { "aria-label": "Chat model" } });
    for (const model of this.snapshot.models) select.createEl("option", { value: model.id, text: model.label });
    select.value = this.snapshot.modelId ?? "";
    select.onchange = async () => {
      if (this.isStreaming) {
        select.value = this.snapshot.modelId ?? "";
        new Notice("Wait for the current response before changing models.");
        return;
      }
      select.disabled = true;
      try {
        await this.harness.setSessionModel(select.value);
        new Notice(`Now using ${this.harness.snapshot().models.find((model) => model.id === select.value)?.label ?? select.value}.`);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Could not change the chat model.");
        select.disabled = false;
      }
    };
  }

  private renderTranscript() {
    const context = this.transcriptEl.createDiv({ cls: "agent-context" });
    context.createSpan({ cls: "agent-context-dot", text: "●" });
    context.createSpan({ text: this.app.workspace.getActiveFile()?.basename ?? "No active note" });
    context.createSpan({ cls: "agent-context-badge", text: "active" });
    const messages = this.snapshot.transcript;
    if (!messages.length) {
      this.transcriptEl.createDiv({ cls: "agent-empty", text: "Ask Pi to work with this note." });
      return;
    }
    for (const message of messages) this.addMessage(message.role, message.text);
  }

  private renderSetupCard() {
    const setup = this.contentEl.createDiv({ cls: "agent-setup" });
    setup.createEl("strong", { text: "No model provider is configured." });
    setup.createDiv({ text: "Add an API key or token in Note Pi settings to send your first chat message." });
    const button = setup.createEl("button", { text: "Open provider settings", cls: "mod-cta" });
    button.onclick = this.openSettings;
  }

  private renderComposer() {
    const composer = this.contentEl.createDiv({ cls: "agent-composer" });
    composer.createDiv({ cls: "agent-composer-context", text: "+ current note" });
    this.composerEl = composer.createEl("textarea", { attr: { placeholder: "Ask about this note…", rows: "3" } });
    this.composerEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      }
      if (event.key === "Escape" && this.isStreaming) this.harness.cancel();
    });
    this.sendButton = composer.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendButton.onclick = () => void this.submit();
    this.composerEl.focus();
  }

  private async submit() {
    const prompt = this.composerEl.value.trim();
    if (!prompt || this.isStreaming) return;
    this.isStreaming = true;
    this.composerEl.value = "";
    this.composerEl.disabled = true;
    this.sendButton.disabled = true;
    this.addMessage("user", prompt);
    const agentMessage = this.addMessage("assistant", "");
    try {
      await this.harness.submit(prompt, (delta) => {
        agentMessage.setText(agentMessage.textContent + delta);
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
      });
    } catch (error) {
      agentMessage.addClass("agent-error");
      agentMessage.setText(error instanceof Error ? error.message : "Chat failed. Fix provider setup and try again.");
      new Notice("Note Pi could not complete the chat turn.");
    } finally {
      this.isStreaming = false;
      this.composerEl.disabled = false;
      this.sendButton.disabled = false;
      this.composerEl.focus();
    }
  }

  private addMessage(role: "user" | "assistant", text: string) {
    const message = this.transcriptEl.createDiv({ cls: `agent-message agent-message-${role}` });
    message.createDiv({ cls: "agent-message-label", text: role === "user" ? "You" : "Agent" });
    return message.createDiv({ cls: "agent-message-body", text });
  }
}
