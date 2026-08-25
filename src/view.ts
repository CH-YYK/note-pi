import { Component, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type { HarnessClient, HarnessSnapshot } from "./harness/client";

export const VIEW_TYPE_NOTE_PI = "note-pi-view";

/** Interval between Markdown re-renders while a response is streaming. */
const STREAM_RENDER_INTERVAL_MS = 120;

type RenderedMarkdown = { el: HTMLElement; component?: Component; source: string };

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s`;
}

export class ObsidianAgentView extends ItemView {
  private transcriptEl!: HTMLElement;
  private composerEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private jumpButtonEl?: HTMLButtonElement;
  private isStreaming = false;
  private snapshot: HarnessSnapshot;
  private unsubscribe?: () => void;
  private turnTimelineEl?: HTMLElement;
  private streamBody?: HTMLElement;
  private streamMarkdown = "";
  private streamRender?: RenderedMarkdown;
  private streamRenderTimer?: number;
  private renderedComponents: Component[] = [];
  private titleMetaEl?: HTMLElement;
  private titleNameEl?: HTMLElement;

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
      if (event.type === "activity.thinking" && event.delta) this.addActivity({ key: "thinking", label: "Thinking", status: "working" });
      if (event.type === "activity.tool" && event.activity) {
        this.addActivity({ key: `tool:${event.activity.name}`, label: this.activityLabel(event.activity.name, event.activity.detail), status: event.activity.status, detail: event.activity.detail });
      }
      if (event.type === "extension.notify" && event.notification) new Notice(event.notification.message);
      if (event.type === "session.usage" && typeof event.usage === "number") {
        this.snapshot = this.harness.snapshot();
        this.updateUsageMeta(event.usage);
        this.titleNameEl?.setText(this.sessionTitle());
      }
    });
    this.render();
  }

  async onClose() {
    this.unsubscribe?.();
    this.teardownRenderedMarkdown();
  }

  render() {
    this.teardownRenderedMarkdown();
    this.turnTimelineEl = undefined;
    this.contentEl.empty();
    this.contentEl.addClass("note-pi-view");
    this.renderHeader();
    this.transcriptEl = this.contentEl.createDiv({ cls: "agent-transcript" });
    this.transcriptEl.addEventListener("scroll", () => this.updateJumpButton());
    this.renderTranscript();
    if (this.snapshot.providerState === "configured") this.renderComposer();
    else this.renderSetupCard();
  }

  // --- Header ---------------------------------------------------------------

  private sessionTitle(): string {
    const first = this.snapshot.transcript.find((message) => message.role === "user" && message.text.trim());
    if (!first) return "Note Pi";
    const text = first.text.trim().replace(/\s+/g, " ");
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  private renderHeader() {
    const header = this.contentEl.createDiv({ cls: "agent-header" });
    const title = header.createDiv({ cls: "agent-title" });
    title.createSpan({ cls: "agent-title-icon", text: "π" });
    const titleText = title.createDiv({ cls: "agent-title-text" });
    this.titleNameEl = titleText.createDiv({ cls: "agent-title-name", text: this.sessionTitle() });
    this.titleMetaEl = titleText.createDiv({ cls: "agent-title-meta" });
    this.updateUsageMeta(this.snapshot.usageTokens);

    this.renderExtensionChip(header);

    const newSession = header.createEl("button", {
      cls: "agent-icon-button",
      attr: { "aria-label": "New session", title: "New session" },
      text: "+"
    });
    newSession.onclick = () => {
      if (this.isStreaming) {
        new Notice("Wait for the current response before starting a new session.");
        return;
      }
      this.harness.newSession();
    };
  }

  private updateUsageMeta(tokens: number) {
    if (!this.titleMetaEl) return;
    this.titleMetaEl.removeClass("agent-title-warning");
    if (tokens > 0) this.titleMetaEl.setText(`${formatTokens(tokens)} tokens`);
    else if (this.snapshot.providerState !== "configured") {
      this.titleMetaEl.setText("setup needed");
      this.titleMetaEl.addClass("agent-title-warning");
    } else this.titleMetaEl.setText("");
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

  // --- Transcript -------------------------------------------------------------

  private renderTranscript() {
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

  private addMessage(role: "user" | "assistant", text: string, timestamp?: Date) {
    if (timestamp) this.transcriptEl.createDiv({ cls: "agent-timestamp", text: formatClock(timestamp) });
    if (role === "user") {
      const card = this.transcriptEl.createDiv({ cls: "agent-user-card" });
      card.createDiv({ cls: "agent-user-text", text });
      this.turnTimelineEl = undefined;
      this.scrollTranscriptIfFollowing();
      return card;
    }
    const message = this.transcriptEl.createDiv({ cls: "agent-message agent-message-assistant" });
    const body = message.createDiv({ cls: "agent-message-body" });
    if (text) this.renderMarkdownInto(body, text);
    this.scrollTranscriptIfFollowing();
    return body;
  }

  // --- Activity timeline --------------------------------------------------------

  private activityLabel(name: string, detail?: string): string {
    if (name === "read" && detail) return `Read: ${detail.split("/").pop() ?? detail}`;
    return `Using tool: ${name}`;
  }

  private currentTimeline(): HTMLElement {
    if (!this.turnTimelineEl || !this.turnTimelineEl.isConnected) {
      this.turnTimelineEl = this.transcriptEl.createDiv({ cls: "agent-timeline", attr: { "aria-live": "polite" } });
    }
    return this.turnTimelineEl;
  }

  private addActivity(activity: { key: string; label: string; status: string; detail?: string }) {
    const timeline = this.currentTimeline();
    const working = activity.status === "working" || activity.status === "running";
    const existing = [...timeline.querySelectorAll<HTMLElement>(".agent-activity")].find((item) => item.dataset.key === activity.key && item.dataset.state === "working");

    if (existing) {
      if (working) return; // duplicate working event
      this.finishActivity(existing, activity.status);
      return;
    }
    const item = timeline.createDiv({ cls: `agent-activity agent-activity-${activity.status}` });
    item.dataset.key = activity.key;
    item.dataset.state = working ? "working" : activity.status;
    item.dataset.startedAt = String(Date.now());
    item.setAttr("role", "button");
    item.setAttr("tabindex", "0");
    item.createSpan({ cls: "agent-activity-dot" });
    item.createSpan({ cls: "agent-activity-label", text: activity.label });
    item.createSpan({ cls: "agent-activity-duration" });
    item.createSpan({ cls: "agent-activity-chevron", text: "›" });
    if (activity.detail) item.dataset.detail = activity.detail;
    const toggle = () => this.toggleActivityDetail(item);
    item.addEventListener("click", toggle);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    if (!working) this.finishActivity(item, activity.status);
    this.scrollTranscriptIfFollowing();
  }

  private finishActivity(item: HTMLElement, status: string) {
    item.dataset.state = status === "working" || status === "running" ? "working" : status;
    if (item.dataset.state === "working") return;
    const startedAt = Number(item.dataset.startedAt ?? Date.now());
    const duration = item.querySelector(".agent-activity-duration");
    if (duration) duration.textContent = formatDuration(Date.now() - startedAt);
    item.classList.remove("agent-activity-working", "agent-activity-running");
    item.classList.add(status === "failed" ? "agent-activity-failed" : "agent-activity-completed");
  }

  private toggleActivityDetail(item: HTMLElement) {
    const existing = item.querySelector(".agent-activity-detail");
    if (existing) {
      existing.remove();
      item.removeClass("agent-activity-open");
      return;
    }
    const detail = item.dataset.detail;
    if (!detail) return;
    item.addClass("agent-activity-open");
    const detailEl = item.createDiv({ cls: "agent-activity-detail" });
    if (detail.endsWith(".md")) {
      const link = detailEl.createSpan({ cls: "agent-activity-link", text: detail });
      link.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.app.workspace.openLinkText(detail, "", false).catch(() => new Notice(`Could not open ${detail}.`));
      });
    } else {
      detailEl.setText(detail);
    }
  }

  private completeWorkingActivities() {
    if (!this.turnTimelineEl) return;
    for (const item of Array.from(this.turnTimelineEl.querySelectorAll<HTMLElement>(".agent-activity"))) {
      if (item.dataset.state === "working") this.finishActivity(item, "completed");
    }
  }

  // --- Composer ----------------------------------------------------------------

  private renderComposer() {
    const composer = this.contentEl.createDiv({ cls: "agent-composer" });
    const activeNote = this.app.workspace.getActiveFile()?.basename;
    if (activeNote) {
      const contextRow = composer.createDiv({ cls: "agent-context-row" });
      const chip = contextRow.createDiv({ cls: "agent-context-chip" });
      chip.createSpan({ cls: "agent-context-chip-icon", text: "📄" });
      chip.createSpan({ text: activeNote });
    }
    const box = composer.createDiv({ cls: "agent-composer-box" });
    this.composerEl = box.createEl("textarea", {
      attr: { placeholder: "Ask anything…", rows: "1", "aria-label": "Message Note Pi" }
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

  // --- Turn flow -----------------------------------------------------------------

  private async submit() {
    const prompt = this.composerEl.value.trim();
    if (!prompt || this.isStreaming) return;
    this.setStreaming(true);
    this.composerEl.value = "";
    this.autoGrowComposer();
    this.addMessage("user", prompt, new Date());
    // Activities for this turn collect into a timeline group that sits
    // between the user card and the assistant response.
    this.currentTimeline();
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
      this.transcriptEl.createDiv({ cls: "agent-timestamp", text: formatClock(new Date()) });
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
    if (this.transcriptAtBottom()) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    this.updateJumpButton();
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
