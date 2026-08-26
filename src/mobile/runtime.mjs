/**
 * Browser-safe Pi runtime adapter for Obsidian mobile (iPad/iPhone).
 *
 * This mirrors PiAgentRuntime's shape but is restricted to the portable Pi
 * agent loop: it must never import the Node execution environment, Node
 * fetch/stream adapters, or any `node:` module. Everything here must run in
 * Obsidian's iOS WebView. pi-agent-core remains the owner of the agent loop
 * and live state; this adapter only constructs and supervises the Agent.
 */
import { Agent } from "@earendil-works/pi-agent-core";

export class MobileAgentRuntime {
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
}
