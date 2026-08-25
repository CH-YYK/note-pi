import { Component, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type { HarnessClient, HarnessSnapshot } from "./harness/client";

export const VIEW_TYPE_NOTE_PI = "note-pi-view";

/** Interval between Markdown re-renders while a response is streaming. */
const STREAM_RENDER_INTERVAL_MS = 120;

type RenderedMarkdown = { el: HTMLElement; component?: Component; source: string };

export class ObsidianAgentView extends ItemView {
  private transcriptEl!: HTMLElement;
  private composerEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private jumpButtonEl?: HTMLButtonElement;
  private isStreaming = false;
  private snapshot: HarnessSnapshot;
  private unsubscribe?: () => void;
  private activityEl?: HTMLElement;
  private streamBody?: HTMLElement;
  private streamMarkdown = "";
  private streamRender?: RenderedMarkdown;
  private streamRenderTimer?: number;
  private renderedComponents: Component[] = [];

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
      if (event.type === "activity.thinking" && event.delta) this.addActivity("Thinking", "working");
      if (event.type === "activity.tool" && event.activity) this.addActivity(event.activity.name, event.activity.status);
      if (event.type === "extension.notify" && event.notification) new Notice(event.notification.message);
    });
    this.render();
  }

  async onClose() {
    this.unsubscribe?.();
    this.teardownRenderedMarkdown();
  }

  render() {
    this.teardownRenderedMarkdown();
    this.contentEl.empty();
    this.contentEl.addClass("note-pi-view");
    this.renderHeader();
    this.transcriptEl = this.contentEl.createDiv({ cls: "agent-transcript" });
    this.transcriptEl.addEventListener("scroll", () => this.updateJumpButton());
    this.activityEl = this.transcriptEl.createDiv({ cls: "agent-activities", attr: { "aria-live": "polite" } });
    this.renderTranscript();
    if (this.snapshot.providerState === "configured") this.renderComposer();
    else this.renderSetupCard();
  }

  private renderHeader() {
    const header = this.contentEl.createDiv({ cls: "agent-header" });
    const title = header.createDiv({ cls: "agent-title" });
    title.createSpan({ cls: "agent-title-icon", text: "π" });
    title.createSpan({ text: "Note Pi" });
    header.createSpan({ cls: `agent-status agent-status-${this.snapshot.providerState}`, text: this.snapshot.providerState === "configured" ? "ready" : "setup needed" });
    this.renderExtensionChip(header);
  }

  private renderExtensionChip(header: HTMLElement) {
    const extensions = this.snapshot.extensions ?? [];
    const errors = this.snapshot.extensionErrors ?? [];
    if (!extensions.length && !errors.length) return;
    const hasErrors = errors.length > 0;
    const chip = header.createSpan({
      cls: `agent-extensions${hasErrors ? " agent-extensions-error" : ""}`,
      text: hasErrors ? `⬡ ${extensions.length} ext · ${errors.length} failed` : `⬡ ${extensions.length} ext`
    });
    const lines = [
      ...extensions.map((extension) => `${extension.path.split("/").pop() ?? extension.path} — tools: ${extension.tools.join(", ") || "none"} · commands: ${[...extension.commands].map((name) => `/${name}`).join(", ") || "none"}`),
      ...errors.map((error) => `FAILED ${error.path.split("/").pop() ?? error.path}: ${error.error}`)
    ];
    chip.setAttr("title", lines.join("\n"));
  }

  private renderTranscript() {
    const context = this.transcriptEl.createDiv({ cls: "agent-context" });
    context.createSpan({ cls: "agent-context-dot", text: "●" });
    context.createSpan({ text: this.app.workspace.getActiveFile()?.basename ?? "No active note" });
    context.createSpan({ cls: "agent-context-badge", text: "active" });
    const messages = this.snapshot.transcript;
    if (!messages.length) {
      const empty = this.transcriptEl.createDiv({ cls: "agent-empty" });
      empty.createDiv({ cls: "agent-empty-lead", text: "Ask Pi to work with this note." });
      const hints = empty.createDiv({ cls: "agent-empty-hints" });
      for (const hint of ["Summarize this note", "Explain a section in detail", "Suggest tags and links"]) {
        const chip = hints.createDiv({ cls: "agent-empty-hint", text: hint });
        chip.setAttr("role", "button");
        chip.setAttr("tabindex", "0");
        const run = () => {
          if (!this.composerEl) return;
          this.composerEl.value = hint;
          this.composerEl.focus();
        };
        chip.addEventListener("click", run);
        chip.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            run();
          }
        });
      }
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
    const box = composer.createDiv({ cls: "agent-composer-box" });
    this.composerEl = box.createEl("textarea", {
      attr: { placeholder: "Ask about this note…", rows: "1", "aria-label": "Message Note Pi" }
    });
    this.composerEl.addEventListener("input", () => this.autoGrowComposer());
    this.composerEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (this.isStreaming) return;
        void this.submit();
      }
      if (event.key === "Escape" && this.isStreaming) this.harness.cancel();
    });

    const bar = box.createDiv({ cls: "agent-composer-bar" });
    bar.createDiv({ cls: "agent-composer-context", text: "+ current note" });
    this.renderModelPicker(bar);
    bar.createDiv({ cls: "agent-composer-hint", text: "↵ send · ⇧↵ newline · Esc stop" });
    this.sendButton = bar.createEl("button", {
      cls: "agent-send-button mod-cta",
      attr: { "aria-label": "Send message", title: "Send (Enter)" },
      text: "↑"
    });
    this.sendButton.onclick = () => {
      if (this.isStreaming) {
        this.harness.cancel();
        return;
      }
      void this.submit();
    };
    this.composerEl.focus();
  }

  private renderModelPicker(parent: HTMLElement) {
    const select = parent.createEl("select", { cls: "dropdown agent-model-select", attr: { "aria-label": "Chat model" } });
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

  private autoGrowComposer() {
    this.composerEl.style.height = "auto";
    this.composerEl.style.height = `${Math.min(this.composerEl.scrollHeight, 200)}px`;
  }

  private setStreaming(streaming: boolean) {
    this.isStreaming = streaming;
    this.sendButton.setText(streaming ? "■" : "↑");
    this.sendButton.setAttr("aria-label", streaming ? "Stop response" : "Send message");
    this.sendButton.setAttr("title", streaming ? "Stop (Esc)" : "Send (Enter)");
    this.sendButton.toggleClass("agent-send-stop", streaming);
  }

  private async submit() {
    const prompt = this.composerEl.value.trim();
    if (!prompt || this.isStreaming) return;
    this.setStreaming(true);
    this.composerEl.value = "";
    this.autoGrowComposer();
    this.addMessage("user", prompt);
    const body = this.addMessage("assistant", "");
    this.streamBody = body;
    this.streamMarkdown = "";
    this.streamRender = undefined;
    body.addClass("agent-streaming");
    try {
      const result = await this.harness.submit(prompt, (delta) => {
        this.streamMarkdown += delta;
        this.scheduleStreamRender();
      });
      // Slash-command results and non-streaming providers return text
      // without emitting deltas; render the returned text in that case.
      if (!this.streamMarkdown && result) this.streamMarkdown = result;
      this.renderStreamMarkdown(true);
    } catch (error) {
      this.flushStreamRenderTimer();
      body.removeClass("agent-streaming");
      body.addClass("agent-error");
      body.setText(error instanceof Error ? error.message : "Chat failed. Fix provider setup and try again.");
      new Notice("Note Pi could not complete the chat turn.");
    } finally {
      this.streamBody = undefined;
      this.streamRender = undefined;
      this.streamMarkdown = "";
      this.completeWorkingActivities();
      this.setStreaming(false);
      this.composerEl.focus();
    }
  }

  private completeWorkingActivities() {
    if (!this.activityEl) return;
    for (const item of Array.from(this.activityEl.querySelectorAll<HTMLElement>(".agent-activity-working"))) {
      item.classList.remove("agent-activity-working");
      item.classList.add("agent-activity-completed");
      const status = item.querySelector(".agent-activity-status");
      if (status) status.textContent = "done";
    }
  }

  private addMessage(role: "user" | "assistant", text: string) {
    const message = this.transcriptEl.createDiv({ cls: `agent-message agent-message-${role}` });
    message.createDiv({ cls: "agent-message-label", text: role === "user" ? "You" : "Agent" });
    const body = message.createDiv({ cls: "agent-message-body" });
    if (role === "assistant" && text) this.renderMarkdownInto(body, text);
    else body.setText(text);
    this.scrollTranscriptIfFollowing();
    return body;
  }

  private addActivity(name: string, status: string) {
    if (!this.activityEl) return;
    const latest = this.activityEl.lastElementChild as HTMLElement | null;
    if (latest?.dataset.activity === name && status === "working") return;
    const item = this.activityEl.createDiv({ cls: `agent-activity agent-activity-${status}` });
    item.dataset.activity = name;
    item.createSpan({ cls: "agent-activity-dot" });
    item.createSpan({ text: name });
    item.createSpan({ cls: "agent-activity-status", text: status });
    this.scrollTranscriptIfFollowing();
  }

  // --- Markdown rendering ---------------------------------------------------

  private renderMarkdownInto(body: HTMLElement, markdown: string, previous?: RenderedMarkdown): RenderedMarkdown {
    previous?.component?.unload();
    body.empty();
    const component = new Component();
    component.load();
    this.renderedComponents.push(component);
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    void MarkdownRenderer.render(this.app, markdown, body, sourcePath, component);
    return { el: body, component, source: markdown };
  }

  private scheduleStreamRender() {
    if (this.streamRenderTimer !== undefined) return;
    this.streamRenderTimer = window.setTimeout(() => {
      this.streamRenderTimer = undefined;
      this.renderStreamMarkdown(false);
    }, STREAM_RENDER_INTERVAL_MS);
  }

  private flushStreamRenderTimer() {
    if (this.streamRenderTimer === undefined) return;
    window.clearTimeout(this.streamRenderTimer);
    this.streamRenderTimer = undefined;
  }

  private renderStreamMarkdown(final: boolean) {
    if (!this.streamBody) return;
    this.flushStreamRenderTimer();
    this.streamRender = this.renderMarkdownInto(this.streamBody, this.streamMarkdown, this.streamRender);
    if (final) this.streamBody.removeClass("agent-streaming");
    this.scrollTranscriptIfFollowing();
  }

  private teardownRenderedMarkdown() {
    this.flushStreamRenderTimer();
    for (const component of this.renderedComponents) component.unload();
    this.renderedComponents = [];
    this.streamRender = undefined;
  }

  // --- Scrolling ------------------------------------------------------------

  private transcriptAtBottom() {
    return this.transcriptEl.scrollHeight - this.transcriptEl.scrollTop - this.transcriptEl.clientHeight < 48;
  }

  private scrollTranscriptIfFollowing() {
    if (this.transcriptAtBottom()) {
      this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
      this.updateJumpButton();
    } else {
      this.updateJumpButton();
    }
  }

  private updateJumpButton() {
    const show = !this.transcriptAtBottom() && this.snapshot.transcript.length > 0;
    if (show && !this.jumpButtonEl) {
      this.jumpButtonEl = this.contentEl.createEl("button", { cls: "agent-jump-latest", text: "↓ Jump to latest" });
      this.jumpButtonEl.onclick = () => {
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
        this.jumpButtonEl?.remove();
        this.jumpButtonEl = undefined;
      };
    } else if (!show && this.jumpButtonEl) {
      this.jumpButtonEl.remove();
      this.jumpButtonEl = undefined;
    }
  }
}
