export type HarnessModel = { id: string; label: string };
export type HarnessMessage = { role: "user" | "assistant"; text: string };
export type HarnessExtension = { path: string; tools: string[]; commands: string[] };
export type HarnessExtensionError = { path: string; error: string };
export type HarnessSnapshot = {
  providerId: string;
  providerState: string;
  modelId?: string;
  models: HarnessModel[];
  transcript: HarnessMessage[];
  extensions: HarnessExtension[];
  extensionErrors: HarnessExtensionError[];
};
export type HarnessEvent = { type: "session.state" | "session.model.changed" | "session.extensions" | "assistant.delta" | "activity.thinking" | "activity.tool" | "extension.notify"; snapshot?: HarnessSnapshot; delta?: string; activity?: { name: string; status: string }; notification?: { message: string; level: string } };

export interface HarnessClient {
  snapshot(): HarnessSnapshot;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  setSessionModel(modelId: string): Promise<void>;
  submit(text: string, onDelta?: (delta: string) => void): Promise<string>;
  cancel(): void;
}
