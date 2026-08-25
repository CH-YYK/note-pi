/**
 * Deterministic fake streaming provider for the mobile feasibility spike and
 * automated tests. It speaks Pi's AssistantMessageEventStream protocol
 * without any network or Node dependency, so the mobile bundle can prove the
 * Pi agent loop end to end in a WebView.
 *
 * A script is a list of turns. Each turn is either:
 *   { text: string, chunks?: number }   — stream `text` in `chunks` deltas
 *   { toolCalls: [{ name, arguments }], text?: string } — request tools
 * When the script is exhausted, the provider echoes a canned reply so tests
 * never hang.
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export const FAKE_MOBILE_MODEL = {
  id: "fake-mobile-model",
  name: "Fake mobile model",
  api: "fake",
  provider: "fake",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192
};

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function baseMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api ?? "fake",
    provider: model.provider ?? "fake",
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now()
  };
}

function splitIntoChunks(text, chunks) {
  if (chunks <= 1 || text.length <= 1) return [text];
  const size = Math.ceil(text.length / chunks);
  const parts = [];
  for (let offset = 0; offset < text.length; offset += size) parts.push(text.slice(offset, offset + size));
  return parts;
}

export function createFakeStreamFn(script = []) {
  const turns = [...script];
  const contexts = [];
  const streamFn = (model, context, options = {}) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    const turn = turns.length ? turns.shift() : { text: "Fake mobile response." };
    const signal = options.signal;
    void (async () => {
      const message = baseMessage(model);
      const aborted = () => {
        const finalMessage = { ...message, stopReason: "aborted", errorMessage: "The request was cancelled." };
        stream.push({ type: "error", reason: "aborted", error: finalMessage });
      };
      stream.push({ type: "start", partial: { ...message } });
      if (signal?.aborted) return aborted();

      const toolCalls = turn.toolCalls ?? [];
      const text = turn.text ?? "";
      for (const [index, toolCall] of toolCalls.entries()) {
        const call = {
          type: "toolCall",
          id: `fake-call-${contexts.length}-${index}`,
          name: toolCall.name,
          arguments: toolCall.arguments ?? {}
        };
        message.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex: message.content.length - 1, partial: { ...message } });
        stream.push({ type: "toolcall_end", contentIndex: message.content.length - 1, toolCall: call, partial: { ...message } });
        await Promise.resolve();
        if (signal?.aborted) return aborted();
      }

      if (text) {
        message.content.push({ type: "text", text: "" });
        const contentIndex = message.content.length - 1;
        for (const chunk of splitIntoChunks(text, turn.chunks ?? 3)) {
          message.content[contentIndex].text += chunk;
          stream.push({ type: "text_delta", contentIndex, delta: chunk, partial: { ...message, content: [...message.content] } });
          // Yield so cancellation can land between deltas.
          await new Promise((resolve) => setTimeout(resolve, turn.chunkDelayMs ?? 1));
          if (signal?.aborted) return aborted();
        }
      }

      const finalMessage = { ...message, stopReason: toolCalls.length ? "toolUse" : "stop" };
      stream.push({ type: "done", reason: toolCalls.length ? "toolUse" : "stop", message: finalMessage });
    })();
    return stream;
  };
  // Test hook: every LLM context the fake provider was called with.
  streamFn.contexts = contexts;
  return streamFn;
}
