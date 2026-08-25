export type HarnessModel = { id: string; label: string };
export type HarnessMessage = { role: "user" | "assistant"; text: string };
export type HarnessSnapshot = {
  providerId: string;
  providerState: string;
  modelId?: string;
  models: HarnessModel[];
  transcript: HarnessMessage[];
};
export type HarnessEvent = { type: "session.state" | "session.model.changed" | "assistant.delta"; snapshot?: HarnessSnapshot; delta?: string };

export interface HarnessClient {
  snapshot(): HarnessSnapshot;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  setSessionModel(modelId: string): Promise<void>;
  submit(text: string, onDelta?: (delta: string) => void): Promise<string>;
  cancel(): void;
}
