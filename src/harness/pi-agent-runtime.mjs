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
import { relative } from "node:path";
import { realpath } from "node:fs/promises";
import { Readable } from "node:stream";

// Obsidian's renderer-global fetch is CORS-bound. node-fetch runs through
// Electron's Node integration instead, so provider requests use the same
// Web-standard fetch API without renderer network policy restrictions.
export async function nodeBackedFetch(input, init) {
  const response = await nodeFetch(input, init);
  return {
    body: response.body ? Readable.toWeb(response.body) : null,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    ok: response.ok,
    url: response.url
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
    let canonicalVault;
    const vaultRoot = async () => (canonicalVault ??= await realpath(vaultPath));
    const safeRead = async (path, signal) => {
      let canonical;
      try {
        canonical = await realpath(path);
      } catch {
        // Missing file: fall back to the raw resolved path for the boundary
        // check and let readBinaryFile surface the not-found error itself.
        canonical = undefined;
      }
      const outside = canonical
        ? relative(await vaultRoot(), canonical).startsWith("..")
        : relative(vaultPath, path).startsWith("..");
      if (outside) {
        return { ok: false, error: new FileError("permission_denied", "Read is limited to the vault.", path) };
      }
      return env.readBinaryFile(path, signal);
    };
    // Keep the full NodeExecutionEnv surface (exists, absolutePath, ...) via
    // the prototype chain and override only the vault-guarded read. The core
    // read tool calls env.exists while resolving paths, so a partial env
    // object breaks every read.
    const guardedEnv = Object.create(env);
    guardedEnv.readBinaryFile = safeRead;
    return {
      ...read,
      execute: (id, args, signal, update) => read.execute(id, args, signal, update, { env: guardedEnv })
    };
  }
}
