/**
 * Pi-specific runtime adapter.
 *
 * This is deliberately thin: pi-agent-core remains the owner of the agent
 * loop and its live state. The application layer supplies a fully prepared
 * initial state and observes the core events through this adapter.
 */
import { Agent, createReadTool, FileError } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import nodeFetch from "node-fetch";
import { Readable } from "node:stream";
import { relative } from "node:path";
import { realpath } from "node:fs/promises";

// Pi's provider SDKs consume Web streams, while node-fetch exposes a Node
// stream. Keep that host-runtime adaptation beside the Pi integration.
export async function nodeBackedFetch(input, init) {
  const response = await nodeFetch(input, init);
  return {
    body: response.body ? Readable.toWeb(response.body) : null,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    ok: response.ok,
    url: response.url,
    text: () => response.text(),
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer()
  };
}

export class PiAgentRuntime {
  constructor(streamFn) {
    this.streamFn = streamFn;
    this.agent = undefined;
  }

  isAvailable() {
    return typeof Agent === "function";
  }

  /**
   * Create the core Agent. `options` are pi-agent-core AgentOptions (with
   * initialState, tools, and prompts prepared by the controller); this
   * adapter only supplies the stream function.
   */
  createAgent(options) {
    if (!this.agent) this.agent = new Agent({ ...options, streamFn: this.streamFn });
    return this.agent;
  }

  reset() {
    this.agent = undefined;
  }

  abort() {
    this.agent?.abort();
  }

  /**
   * Build the core read tool with this host's vault boundary. Tool enablement
   * and the decision to expose it remain application-layer policy.
   */
  createVaultReadTool(vaultPath) {
    const read = createReadTool();
    const env = new NodeExecutionEnv({ cwd: vaultPath });
    const safeRead = async (path, signal) => {
      const canonical = await realpath(path);
      if (relative(vaultPath, canonical).startsWith("..")) {
        return { ok: false, error: new FileError("permission_denied", "Read is limited to the vault.", path) };
      }
      return env.readBinaryFile(path, signal);
    };
    return {
      ...read,
      execute: (id, args, signal, update) => read.execute(id, args, signal, update, {
        env: { cwd: vaultPath, absolutePath: env.absolutePath.bind(env), readBinaryFile: safeRead }
      })
    };
  }
}
