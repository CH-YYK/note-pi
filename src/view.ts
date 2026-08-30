import { Component, ItemView, MarkdownRenderer, MarkdownView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { HarnessClient, HarnessSessionMeta, HarnessSnapshot } from "./harness/client";

export const VIEW_TYPE_NOTE_PI = "note-pi-view";

/** Interval between Markdown re-renders while a response is streaming. */
const STREAM_RENDER_INTERVAL_MS = 120;

type RenderedMarkdown = { el: HTMLElement; component?: Component; source: string };

/** Host-supplied preference for attaching the focused note to every turn. */
export interface ContextNotePrefs {
  autoContextNote(): boolean;
  setAutoContextNote(enabled: boolean): Promise<void> | void;
}

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

function isToday(timestamp?: number): boolean {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export class ObsidianAgentView extends ItemView {
  private bodyEl!: HTMLElement;
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
  private railEl?: HTMLElement;
  private railVisible = false;
  private railHideTimer?: number;
  private historyButtonEl?: HTMLButtonElement;
  private contextNotes: { path: string; name: string }[] = [];
  private contextRowEl?: HTMLElement;
  private lastFocusedNotePath?: string;

  constructor(leaf: WorkspaceLeaf, private harness: HarnessClient, private readonly openSettings: () => void, private readonly contextPrefs?: ContextNotePrefs) {
    super(leaf);
    this.snapshot = harness.snapshot();
  }

  getViewType() { return VIEW_TYPE_NOTE_PI; }
  getDisplayText() { return "Note Pi"; }
  getIcon() { return "bot"; }

  async onOpen() {
    this.rebindLiveHarness();
    this.unsubscribe = this.harness.subscribe((event) => {
      if (event.snapshot) {
        this.snapshot = event.snapshot;
        this.render();
      }
      if (event.type === "activity.thinking" && event.delta) this.addActivity({ key: "thinking", label: "Thinking", status: "working" });
      if (event.type === "activity.tool" && event.activity) {
        const { prefix, emphasis } = this.activityLabelParts(event.activity.name, event.activity.detail);
        this.addActivity({ key: `tool:${event.activity.name}`, label: prefix, emphasis, status: event.activity.status, detail: event.activity.detail });
      }
      if (event.type === "extension.notify" && event.notification) new Notice(event.notification.message);
      if (event.type === "session.usage" && typeof event.usage === "number") {
        this.snapshot = this.harness.snapshot();
        this.updateUsageMeta(event.usage);
        this.titleNameEl?.setText(this.sessionTitle());
      }
    });
    // Track the last focused markdown note (the chat view itself never counts)
    // so the auto-context chip stays put while the composer has focus, and
    // follows along when the user switches notes.
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) this.lastFocusedNotePath = activeFile.path;
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      const view = leaf?.view;
      if (view instanceof MarkdownView && view.file) this.lastFocusedNotePath = view.file.path;
      this.renderContextChips();
    }));
    this.render();
  }

  // A workspace-restored leaf can be created through a previous plugin
  // instance's lingering view registration, binding it to a dead harness
  // (default provider, empty sessions). Rebind to the live plugin's harness
  // without importing the plugin class: duck-typed lookup through the app.
  private rebindLiveHarness() {
    const registry = (this.app as unknown as { plugins?: { plugins?: Record<string, { harnessClient?(): HarnessClient }> } }).plugins?.plugins;
    const live = registry?.["note-pi"]?.harnessClient?.();
    if (live && live !== this.harness) {
      this.harness = live;
      this.snapshot = live.snapshot();
    }
  }

  async onClose() {
    this.unsubscribe?.();
    this.teardownRenderedMarkdown();
    if (this.railHideTimer) window.clearTimeout(this.railHideTimer);
  }

  render() {
    this.teardownRenderedMarkdown();
    this.turnTimelineEl = undefined;
    this.contentEl.empty();
    this.contentEl.addClass("note-pi-view");
    this.renderHeader();
    this.bodyEl = this.contentEl.createDiv({ cls: "note-pi-body" });
    this.renderSessionRail();
    this.transcriptEl = this.bodyEl.createDiv({ cls: "note-pi-transcript" });
    this.transcriptEl.addEventListener("scroll", () => this.updateJumpButton());
    this.renderTranscript();
    if (this.snapshot.providerState === "configured") this.renderComposer();
    else this.renderSetupCard();
  }

  // --- Session rail -------------------------------------------------------------

  private renderSessionRail() {
    this.railEl = this.bodyEl.createDiv({ cls: "note-pi-rail" });
    this.railEl.toggleClass("is-open", this.railVisible);
    this.railEl.addEventListener("mouseenter", () => this.showRail());
    this.railEl.addEventListener("mouseleave", () => this.scheduleRailHide());
    const railHeader = this.railEl.createDiv({ cls: "note-pi-rail-header" });
    railHeader.createSpan({ cls: "note-pi-rail-title", text: "Sessions" });
    const addButton = railHeader.createEl("button", { cls: "note-pi-icon-button", attr: { "aria-label": "New session", title: "New session" } });
    setIcon(addButton, "plus");
    addButton.onclick = () => {
      this.hideRail();
      this.startNewSession();
    };

    const sessions = this.snapshot.sessions;
    if (!sessions.length) {
      this.railEl.createDiv({ cls: "note-pi-rail-empty", text: "No past sessions yet." });
      return;
    }
    const today = sessions.filter((session) => isToday(session.updatedAt));
    const earlier = sessions.filter((session) => !isToday(session.updatedAt));
    if (today.length) this.renderSessionGroup("Today", today);
    if (earlier.length) this.renderSessionGroup("Earlier", earlier);
  }

  private renderSessionGroup(label: string, sessions: HarnessSessionMeta[]) {
    const group = this.railEl!.createDiv({ cls: "note-pi-rail-group" });
    group.createDiv({ cls: "note-pi-rail-group-label", text: label });
    for (const session of sessions) {
      const row = group.createDiv({ cls: `note-pi-rail-session${session.id === this.snapshot.activeSessionId ? " is-active" : ""}` });
      row.setAttr("role", "button");
      row.setAttr("tabindex", "0");
      row.createDiv({ cls: "note-pi-rail-session-title", text: session.title });
      const meta = session.updatedAt ? formatClock(new Date(session.updatedAt)) : "";
      row.createDiv({ cls: "note-pi-rail-session-meta", text: `${meta}${meta ? " · " : ""}${session.messageCount} msgs` });
      const open = () => void this.openSession(session.id);
      row.addEventListener("click", () => {
        this.hideRail();
        open();
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    }
  }

  private async openSession(id: string) {
    if (id === this.snapshot.activeSessionId) return;
    if (this.isStreaming) {
      new Notice("Wait for the current response before switching sessions.");
      return;
    }
    try {
      await this.harness.resumeSession(id);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not resume that session.");
    }
  }

  private startNewSession() {
    if (this.isStreaming) {
      new Notice("Wait for the current response before starting a new session.");
      return;
    }
    void this.harness.newSession();
  }

  private showRail() {
    if (this.railHideTimer) {
      window.clearTimeout(this.railHideTimer);
      this.railHideTimer = undefined;
    }
    if (this.railVisible) return;
    this.railVisible = true;
    this.railEl?.addClass("is-open");
    this.historyButtonEl?.addClass("is-active");
  }

  private hideRail() {
    if (this.railHideTimer) {
      window.clearTimeout(this.railHideTimer);
      this.railHideTimer = undefined;
    }
    if (!this.railVisible) return;
    this.railVisible = false;
    this.railEl?.removeClass("is-open");
    this.historyButtonEl?.removeClass("is-active");
  }

  private scheduleRailHide() {
    if (this.railHideTimer) window.clearTimeout(this.railHideTimer);
    this.railHideTimer = window.setTimeout(() => this.hideRail(), 250);
  }

  // --- Header ---------------------------------------------------------------

  private sessionTitle(): string {
    const first = this.snapshot.transcript.find((message) => message.role === "user" && message.text.trim());
    if (!first) return "Note Pi";
    const text = first.text.trim().replace(/\s+/g, " ");
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  private renderHeader() {
    const header = this.contentEl.createDiv({ cls: "note-pi-header" });
    const title = header.createDiv({ cls: "note-pi-title" });
    title.createSpan({ cls: "note-pi-title-icon", text: "π" });
    const titleText = title.createDiv({ cls: "note-pi-title-text" });
    this.titleNameEl = titleText.createDiv({ cls: "note-pi-title-name", text: this.sessionTitle() });
    this.titleMetaEl = titleText.createDiv({ cls: "note-pi-title-meta" });
    this.updateUsageMeta(this.snapshot.usageTokens);

    this.renderExtensionChip(header);

    const historyButton = header.createEl("button", { cls: "note-pi-icon-button", attr: { "aria-label": "Toggle session history", title: "Session history" } });
    setIcon(historyButton, "history");
    this.historyButtonEl = historyButton;
    historyButton.addEventListener("mouseenter", () => this.showRail());
    historyButton.addEventListener("mouseleave", () => this.scheduleRailHide());
    historyButton.onclick = () => {
      if (this.railVisible) this.hideRail();
      else this.showRail();
    };
    historyButton.toggleClass("is-active", this.railVisible);

    const newSession = header.createEl("button", { cls: "note-pi-icon-button", attr: { "aria-label": "New session", title: "New session" } });
    setIcon(newSession, "plus");
    newSession.onclick = () => this.startNewSession();
  }

  private updateUsageMeta(tokens: number) {
    if (!this.titleMetaEl) return;
    this.titleMetaEl.removeClass("note-pi-title-warning");
    if (tokens > 0) this.titleMetaEl.setText(`${formatTokens(tokens)} tokens`);
    else if (this.snapshot.providerState !== "configured") {
      this.titleMetaEl.setText("setup needed");
      this.titleMetaEl.addClass("note-pi-title-warning");
    } else this.titleMetaEl.setText("");
  }

  private renderExtensionChip(header: HTMLElement) {
    const extensions = this.snapshot.extensions ?? [];
    const errors = this.snapshot.extensionErrors ?? [];
    if (!extensions.length && !errors.length) return;
    const hasErrors = errors.length > 0;
    const chip = header.createSpan({
      cls: `note-pi-extensions${hasErrors ? " note-pi-extensions-error" : ""}`,
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
      const empty = this.transcriptEl.createDiv({ cls: "note-pi-empty" });
      empty.createDiv({ cls: "note-pi-empty-lead", text: "Ask Pi to work with this note." });
      const hints = empty.createDiv({ cls: "note-pi-empty-hints" });
      for (const hint of ["Summarize this note", "Explain a section in detail", "Suggest tags and links"]) {
        const chip = hints.createDiv({ cls: "note-pi-empty-hint", text: hint });
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
    const setup = this.contentEl.createDiv({ cls: "note-pi-setup" });
    setup.createEl("strong", { text: "No model provider is configured." });
    setup.createDiv({ text: "Add an API key or token in Note Pi settings to send your first chat message." });
    const button = setup.createEl("button", { text: "Open provider settings", cls: "mod-cta" });
    button.onclick = this.openSettings;
  }

  private addMessage(role: "user" | "assistant", text: string, timestamp?: Date) {
    if (timestamp) this.transcriptEl.createDiv({ cls: "note-pi-timestamp", text: formatClock(timestamp) });
    if (role === "user") {
      const card = this.transcriptEl.createDiv({ cls: "note-pi-user-card" });
      card.createDiv({ cls: "note-pi-user-text", text });
      this.turnTimelineEl = undefined;
      this.scrollTranscriptIfFollowing();
      return card;
    }
    const message = this.transcriptEl.createDiv({ cls: "note-pi-message note-pi-message-assistant" });
    const body = message.createDiv({ cls: "note-pi-message-body" });
    if (text) this.renderMarkdownInto(body, text);
    const copy = message.createEl("button", { cls: "note-pi-copy-button", attr: { "aria-label": "Copy message text", title: "Copy" } });
    setIcon(copy, "copy");
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(body.innerText);
        setIcon(copy, "check");
        window.setTimeout(() => setIcon(copy, "copy"), 1200);
      } catch {
        new Notice("Could not copy the message.");
      }
    };
    this.scrollTranscriptIfFollowing();
    return body;
  }

  // --- Activity timeline --------------------------------------------------------

  private activityLabelParts(name: string, detail?: string): { prefix: string; emphasis: string } {
    if (name === "read" && detail) return { prefix: "Read: ", emphasis: detail.split("/").pop() ?? detail };
    return { prefix: "Using tool: ", emphasis: name };
  }

  private currentTimeline(): HTMLElement {
    if (!this.turnTimelineEl || !this.turnTimelineEl.isConnected) {
      this.turnTimelineEl = this.transcriptEl.createDiv({ cls: "note-pi-timeline", attr: { "aria-live": "polite" } });
    }
    return this.turnTimelineEl;
  }

  private addActivity(activity: { key: string; label: string; emphasis?: string; status: string; detail?: string }) {
    const timeline = this.currentTimeline();
    const working = activity.status === "working" || activity.status === "running";
    const existing = [...timeline.querySelectorAll<HTMLElement>(".note-pi-activity")].find((item) => item.dataset.key === activity.key && item.dataset.state === "working");

    if (existing) {
      if (working) return; // duplicate working event
      this.finishActivity(existing, activity.status);
      return;
    }
    const item = timeline.createDiv({ cls: `note-pi-activity note-pi-activity-${activity.status}` });
    item.dataset.key = activity.key;
    item.dataset.state = working ? "working" : activity.status;
    item.dataset.startedAt = String(Date.now());
    item.setAttr("role", "button");
    item.setAttr("tabindex", "0");
    item.createSpan({ cls: "note-pi-activity-dot" });
    const label = item.createSpan({ cls: "note-pi-activity-label" });
    label.appendText(activity.label);
    if (activity.emphasis) label.createSpan({ cls: "note-pi-activity-emphasis", text: activity.emphasis });
    item.createSpan({ cls: "note-pi-activity-duration" });
    item.createSpan({ cls: "note-pi-activity-chevron", text: "›" });
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
    const duration = item.querySelector(".note-pi-activity-duration");
    if (duration) duration.textContent = formatDuration(Date.now() - startedAt);
    item.classList.remove("note-pi-activity-working", "note-pi-activity-running");
    item.classList.add(status === "failed" ? "note-pi-activity-failed" : "note-pi-activity-completed");
  }

  private toggleActivityDetail(item: HTMLElement) {
    const existing = item.querySelector(".note-pi-activity-detail");
    if (existing) {
      existing.remove();
      item.removeClass("note-pi-activity-open");
      return;
    }
    const detail = item.dataset.detail;
    if (!detail) return;
    item.addClass("note-pi-activity-open");
    const detailEl = item.createDiv({ cls: "note-pi-activity-detail" });
    if (detail.endsWith(".md")) {
      const link = detailEl.createSpan({ cls: "note-pi-activity-link", text: detail });
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
    for (const item of Array.from(this.turnTimelineEl.querySelectorAll<HTMLElement>(".note-pi-activity"))) {
      if (item.dataset.state === "working") this.finishActivity(item, "completed");
    }
  }

  // --- Composer ----------------------------------------------------------------

  private renderComposer() {
    const composer = this.contentEl.createDiv({ cls: "note-pi-composer" });
    this.contextRowEl = composer.createDiv({ cls: "note-pi-context-row" });
    this.renderContextChips();
    const box = composer.createDiv({ cls: "note-pi-composer-box" });
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

    const bar = box.createDiv({ cls: "note-pi-composer-bar" });
    this.renderModelPicker(bar);
    bar.createDiv({ cls: "note-pi-composer-hint", text: "↵ send · ⇧↵ newline · Esc stop" });
    this.sendButton = bar.createEl("button", {
      cls: "note-pi-send-button mod-cta",
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

  private renderContextChips() {
    if (!this.contextRowEl || !this.contextRowEl.isConnected) return;
    this.contextRowEl.empty();
    const autoFile = this.autoContextFile();
    if (autoFile) {
      const chip = this.contextRowEl.createDiv({ cls: "note-pi-context-chip note-pi-context-chip-auto", attr: { title: "Attached automatically from the focused note. Use the Auto toggle to disable." } });
      chip.createSpan({ cls: "note-pi-context-chip-icon", text: "📄" });
      chip.createSpan({ text: autoFile.basename });
      chip.createSpan({ cls: "note-pi-context-chip-badge", text: "auto" });
    }
    for (const note of this.contextNotes) {
      const chip = this.contextRowEl.createDiv({ cls: "note-pi-context-chip" });
      chip.createSpan({ cls: "note-pi-context-chip-icon", text: "📄" });
      chip.createSpan({ text: note.name });
      const remove = chip.createSpan({ cls: "note-pi-context-chip-remove", attr: { role: "button", tabindex: "0", "aria-label": `Remove ${note.name} from context`, title: "Remove from context" } });
      setIcon(remove, "x");
      const removeNote = () => {
        this.contextNotes = this.contextNotes.filter((item) => item.path !== note.path);
        this.renderContextChips();
      };
      remove.addEventListener("click", removeNote);
      remove.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          removeNote();
        }
      });
    }
    const add = this.contextRowEl.createEl("button", { cls: "note-pi-context-add", attr: { "aria-label": "Add the focused note as context", title: "Add the focused note as context" } });
    setIcon(add.createSpan({ cls: "note-pi-context-add-icon" }), "plus");
    add.createSpan({ text: "Add current note" });
    add.onclick = () => this.addFocusedNoteContext();
    if (this.contextPrefs) this.renderAutoContextToggle();
  }

  private renderAutoContextToggle() {
    const enabled = this.contextPrefs!.autoContextNote();
    const toggle = this.contextRowEl!.createEl("button", {
      cls: `note-pi-context-auto${enabled ? " is-on" : ""}`,
      attr: {
        "aria-label": "Toggle automatic focused-note context",
        "aria-pressed": String(enabled),
        title: enabled ? "Auto-context on: the focused note is attached to every turn. Click to turn off." : "Auto-context off. Click to attach the focused note to every turn."
      }
    });
    setIcon(toggle.createSpan({ cls: "note-pi-context-add-icon" }), "paperclip");
    toggle.createSpan({ text: enabled ? "Auto on" : "Auto off" });
    toggle.onclick = async () => {
      await this.contextPrefs!.setAutoContextNote(!enabled);
      this.renderContextChips();
    };
  }

  /** The note treated as "current": the live active file, or the last focused one. */
  private focusedNoteFile(): TFile | undefined {
    const path = this.app.workspace.getActiveFile()?.path ?? this.lastFocusedNotePath;
    if (!path) return undefined;
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : undefined;
  }

  /** The focused note to attach automatically, or undefined when disabled/duplicate. */
  private autoContextFile(): TFile | undefined {
    if (!this.contextPrefs?.autoContextNote()) return undefined;
    const file = this.focusedNoteFile();
    if (!file) return undefined;
    if (this.contextNotes.some((note) => note.path === file.path)) return undefined;
    return file;
  }

  private addFocusedNoteContext() {
    const file = this.focusedNoteFile();
    if (!file) {
      new Notice("No focused note to add. Focus a note first.");
      return;
    }
    if (this.contextNotes.some((note) => note.path === file.path)) return;
    this.contextNotes.push({ path: file.path, name: file.basename });
    this.renderContextChips();
  }

  private renderModelPicker(parent: HTMLElement) {
    const select = parent.createEl("select", { cls: "dropdown note-pi-model-select", attr: { "aria-label": "Chat model" } });
    // Models arrive from every configured provider; group them under provider
    // optgroups so switching providers is a single pick in the composer.
    const grouped = new Map<string, { id: string; label: string }[]>();
    for (const model of this.snapshot.models) {
      const group = model.provider ?? "";
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group)!.push(model);
    }
    for (const [providerLabel, models] of grouped) {
      if (!providerLabel) {
        for (const model of models) select.createEl("option", { value: model.id, text: model.label });
        continue;
      }
      const optgroup = select.createEl("optgroup", { attr: { label: providerLabel } });
      for (const model of models) optgroup.createEl("option", { value: model.id, text: model.label });
    }
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
    this.sendButton.toggleClass("note-pi-send-stop", streaming);
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
    body.addClass("note-pi-streaming");
    try {
      const result = await this.harness.submit(
        prompt,
        (delta) => {
          this.streamMarkdown += delta;
          this.scheduleStreamRender();
        },
        { contextNotes: this.turnContextPaths() }
      );
      // Slash-command results and non-streaming providers return text
      // without emitting deltas; render the returned text in that case.
      if (!this.streamMarkdown && result) this.streamMarkdown = result;
      this.renderStreamMarkdown(true);
      this.transcriptEl.createDiv({ cls: "note-pi-timestamp", text: formatClock(new Date()) });
    } catch (error) {
      this.flushStreamRenderTimer();
      body.removeClass("note-pi-streaming");
      body.addClass("note-pi-error");
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

  /** Manually added notes plus the auto-attached focused note, if enabled. */
  private turnContextPaths(): string[] {
    const paths = this.contextNotes.map((note) => note.path);
    const autoFile = this.autoContextFile();
    if (autoFile) paths.unshift(autoFile.path);
    return paths;
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
    if (final) this.streamBody.removeClass("note-pi-streaming");
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
      this.jumpButtonEl = this.contentEl.createEl("button", { cls: "note-pi-jump-latest", text: "↓ Jump to latest" });
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
