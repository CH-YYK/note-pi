export type HarnessModel = { id: string; label: string; provider?: string };
export type HarnessMessage = { role: "user" | "assistant"; text: string };
export type HarnessSessionMeta = { id: string; title: string; updatedAt?: number; messageCount: number };
export type HarnessExtension = { path: string; tools: string[]; commands: string[] };
export type HarnessExtensionError = { path: string; error: string };
export type HarnessSnapshot = {
  providerId: string;
  providerState: string;
  modelId?: string;
  models: HarnessModel[];
  transcript: HarnessMessage[];
  usageTokens: number;
  sessions: HarnessSessionMeta[];
  activeSessionId: string;
  extensions: HarnessExtension[];
  extensionErrors: HarnessExtensionError[];
};
export type HarnessEvent = { type: "session.state" | "session.model.changed" | "session.extensions" | "session.usage" | "assistant.delta" | "activity.thinking" | "activity.tool" | "extension.notify"; snapshot?: HarnessSnapshot; delta?: string; activity?: { name: string; status: string; detail?: string }; notification?: { message: string; level: string }; usage?: number };

export interface HarnessClient {
  snapshot(): HarnessSnapshot;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  setSessionModel(modelId: string): Promise<void>;
  submit(text: string, onDelta?: (delta: string) => void, options?: { contextNotes?: string[] }): Promise<string>;
  cancel(): void;
  newSession(): void | Promise<void>;
  resumeSession(id: string): Promise<void>;
}
