/**
 * Note Pi extension support.
 *
 * Resolution mirrors pi-coding-agent's discovery rules, rooted at the
 * vault-local Pi agent directory instead of ~/.pi/agent:
 *
 *   <agentDir>/extensions/*.ts|*.js            -> load directly
 *   <agentDir>/extensions/* /index.ts|index.js -> load subdirectory entry
 *   <agentDir>/extensions/* /package.json      -> "pi.extensions" declared paths
 *
 * Discovery never recurses beyond one level and never reads global Pi
 * locations. Modules load through jiti with Note Pi's bundled typebox and
 * Pi packages exposed as virtual modules, so extensions written for the Pi
 * CLI (`import { Type } from "typebox"`, pi type imports) resolve the same
 * way here.
 *
 * The ExtensionAPI surface is a deliberate subset of pi-coding-agent's:
 * pi.on(event, handler), pi.registerTool(definition), and
 * pi.registerCommand(name, options). TUI renderers, shortcuts, flags, and
 * provider registration are not applicable to the Obsidian view and are
 * intentionally absent.
 *
 * jiti is loaded from a vendored copy (runtime/jiti) via an absolute path
 * instead of being bundled: jiti lazy-requires its babel transform relative
 * to its own module URL, which bundlers cannot preserve.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";
import * as typebox from "typebox";

/** Events extensions can subscribe to. Names match pi-coding-agent. */
export const EXTENSION_EVENTS = ["session_start", "session_shutdown", "turn_start", "turn_end", "tool_call", "tool_result"];

class UnsupportedTuiComponent {
  constructor(..._args) {}
  addChild(..._args) {}
  invalidate() {}
}

const PI_TUI_SHIM = {
  Container: UnsupportedTuiComponent,
  Spacer: UnsupportedTuiComponent,
  Text: UnsupportedTuiComponent,
  getKeybindings: () => ({})
};

/**
 * A few extension packages import Coding Agent helpers even when their useful
 * commands only need the shared ExtensionAPI. Keep those imports loadable and
 * deliberately fall back to their local discovery paths instead of pretending
 * Note Pi owns Pi's package manager or terminal UI.
 */
function createCodingAgentCompatibilityModule(agentDir) {
  class DefaultPackageManager {
    async resolve() {
      throw new Error("Pi Coding Agent package management is not available in Note Pi.");
    }
  }
  return {
    ...piAgentCore,
    CONFIG_DIR_NAME: ".pi",
    getAgentDir: () => agentDir,
    DefaultPackageManager,
    SettingsManager: {
      create: () => ({
        getProjectSettings: () => ({}),
        getPackages: () => [],
        setProjectPackages: () => {},
        setPackages: () => {}
      })
    }
  };
}

function createVirtualModules(agentDir) {
  return {
    typebox,
    "typebox/compile": typebox,
    "typebox/value": typebox,
    "@sinclair/typebox": typebox,
    "@earendil-works/pi-agent-core": piAgentCore,
    "@earendil-works/pi-ai": piAi,
    "@earendil-works/pi-tui": PI_TUI_SHIM,
    // Extensions written against the CLI import its types; type-only imports
    // erase at transform time. Runtime helpers use this limited compatibility
    // module rather than receiving the unrelated core export surface.
    "@earendil-works/pi-coding-agent": createCodingAgentCompatibilityModule(agentDir)
  };
}

function isExtensionFile(name) {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points declared by a subdirectory:
 * package.json "pi.extensions" first, then index.ts / index.js.
 */
function resolveExtensionEntries(dir) {
  const packageJsonPath = path.join(dir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const declared = manifest?.pi?.extensions;
      if (Array.isArray(declared) && declared.length) {
        const entries = declared.map((entry) => path.resolve(dir, entry)).filter((entry) => fs.existsSync(entry));
        if (entries.length) return entries;
      }
    } catch {
      // Fall through to index resolution.
    }
  }
  const indexTs = path.join(dir, "index.ts");
  const indexJs = path.join(dir, "index.js");
  if (fs.existsSync(indexTs)) return [indexTs];
  if (fs.existsSync(indexJs)) return [indexJs];
  return [];
}

/**
 * Discover extension entry points in a directory using pi-coding-agent's
 * rules: direct .ts/.js files, subdirectory index files, or subdirectory
 * pi manifests. No recursion beyond one level.
 */
export function discoverExtensionPaths(extensionsDir) {
  if (!fs.existsSync(extensionsDir)) return [];
  const discovered = [];
  let entries = [];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const entryPath = path.join(extensionsDir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
      discovered.push(entryPath);
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      discovered.push(...resolveExtensionEntries(entryPath));
    }
  }
  return discovered;
}

function createExtension(extensionPath, extensionsDir) {
  const fileName = path.basename(extensionPath);
  const entryDir = path.dirname(extensionPath);
  const fallbackName = /^index\.[tj]s$/i.test(fileName) ? path.basename(entryDir) : path.parse(fileName).name;
  let metadata = { name: fallbackName, description: "Local extension" };
  for (let directory = entryDir; directory.startsWith(extensionsDir); directory = path.dirname(directory)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      metadata = {
        name: typeof manifest?.name === "string" && manifest.name.trim() ? manifest.name.trim() : fallbackName,
        description: typeof manifest?.description === "string" && manifest.description.trim()
          ? manifest.description.trim()
          : "Local extension"
      };
      break;
    } catch {
      // A manifest is optional; continue toward the extension package root.
    }
    if (directory === extensionsDir) break;
  }
  return {
    path: extensionPath,
    ...metadata,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map()
  };
}

function createExtensionApi(extension, host) {
  return {
    on(event, handler) {
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },
    registerTool(definition) {
      if (!definition?.name) throw new Error("Extension tools require a name.");
      extension.tools.set(definition.name, definition);
      host.onToolRegistered?.(definition);
    },
    registerCommand(name, options) {
      if (!name || typeof options?.handler !== "function") throw new Error("Extension commands require a name and a handler.");
      extension.commands.set(name, { name, description: options.description ?? "", handler: options.handler });
    },
    getAllTools() {
      return host.getAllTools?.() ?? [];
    },
    getActiveTools() {
      return host.getActiveTools?.() ?? [];
    },
    getCommands() {
      return host.getCommands?.() ?? [];
    }
  };
}

/**
 * Load extension modules from the vault-local agent directory. A failure in
 * one extension is reported and never prevents the others from loading.
 *
 * `jitiPath` must point at the vendored jiti entry (runtime/jiti/lib/jiti.cjs
 * in the packaged plugin, node_modules/jiti/lib/jiti.cjs in tests).
 */
export async function loadNotePiExtensions(agentDir, host = {}, jitiPath) {
  const extensionsDir = path.join(agentDir, "extensions");
  const paths = discoverExtensionPaths(extensionsDir);
  if (!paths.length) return new ExtensionRegistry([], [], host);
  if (!jitiPath || !fs.existsSync(jitiPath)) {
    return new ExtensionRegistry([], [{ path: extensionsDir, error: "Bundled jiti runtime is missing; extensions cannot load." }], host);
  }
  const { createJiti } = createRequire(jitiPath)(jitiPath);
  const jiti = createJiti(jitiPath, {
    moduleCache: false,
    fsCache: false,
    virtualModules: createVirtualModules(agentDir)
  });
  const extensions = [];
  const errors = [];
  for (const extensionPath of paths) {
    try {
      const factory = await jiti.import(extensionPath, { default: true });
      if (typeof factory !== "function") {
        errors.push({ path: extensionPath, error: "Extension does not export a factory function." });
        continue;
      }
      const extension = createExtension(extensionPath, extensionsDir);
      await factory(createExtensionApi(extension, host));
      extensions.push(extension);
    } catch (error) {
      errors.push({ path: extensionPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return new ExtensionRegistry(extensions, errors, host);
}

/**
 * Holds loaded extensions and fans lifecycle/tool events out to their
 * handlers. Handler failures are captured as extension errors instead of
 * breaking the agent turn.
 */
export class ExtensionRegistry {
  constructor(extensions = [], errors = [], host = {}) {
    this.extensions = extensions;
    this.errors = errors;
    this.host = host;
  }

  isEmpty() {
    return this.extensions.length === 0 && this.errors.length === 0;
  }

  summary() {
    return {
      extensions: this.extensions.map((extension) => ({
        path: extension.path,
        name: extension.name,
        description: extension.description,
        tools: [...extension.tools.keys()],
        commands: [...extension.commands.keys()]
      })),
      errors: this.errors.map((error) => ({ path: error.path, error: error.error }))
    };
  }

  commands() {
    const commands = new Map();
    for (const extension of this.extensions) {
      for (const [name, command] of extension.commands) {
        if (!commands.has(name)) commands.set(name, command);
      }
    }
    return commands;
  }

  tools() {
    const tools = new Map();
    for (const extension of this.extensions) {
      for (const [name, definition] of extension.tools) {
        if (!tools.has(name)) tools.set(name, definition);
      }
    }
    return tools;
  }

  createContext() {
    return {
      cwd: this.host.vaultPath,
      hasUI: true,
      ui: { notify: (message, type = "info") => this.host.notify?.(message, type) }
    };
  }

  async emit(event, ctx = this.createContext()) {
    for (const extension of this.extensions) {
      for (const handler of extension.handlers.get(event.type) ?? []) {
        try {
          const result = await handler(event, ctx);
          if (result !== undefined) return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.errors.push({ path: extension.path, error: message });
          this.host.notify?.(`Extension error in ${path.basename(extension.path)}: ${message}`, "error");
        }
      }
    }
    return undefined;
  }

  /**
   * Wrap an extension tool definition as a pi-agent-core AgentTool, running
   * tool_call / tool_result handlers around execution like AgentSession does.
   */
  wrapTool(definition) {
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const ctx = this.createContext();
        const block = await this.emit({ type: "tool_call", toolCallId, toolName: definition.name, input: params });
        if (block?.block) {
          return { content: [{ type: "text", text: `Tool call blocked: ${block.reason ?? "by extension"}` }], details: { blocked: true } };
        }
        let result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
        const modified = await this.emit({ type: "tool_result", toolCallId, toolName: definition.name, input: params, content: result?.content, details: result?.details, isError: false });
        if (modified?.content) result = { ...result, content: modified.content };
        return result;
      }
    };
  }

  agentTools() {
    return [...this.tools().values()].map((definition) => this.wrapTool(definition));
  }

  /**
   * Wrap a plain AgentTool (for example the bundled vault read tool) so
   * tool_call / tool_result handlers observe it exactly like extension tools.
   */
  wrapNativeTool(tool) {
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const block = await this.emit({ type: "tool_call", toolCallId, toolName: tool.name, input: params });
        if (block?.block) {
          return { content: [{ type: "text", text: `Tool call blocked: ${block.reason ?? "by extension"}` }], details: { blocked: true } };
        }
        const result = await execute(toolCallId, params, signal, onUpdate);
        await this.emit({ type: "tool_result", toolCallId, toolName: tool.name, input: params, content: result?.content, details: result?.details, isError: false });
        return result;
      }
    };
  }

  async runCommand(name, args) {
    const command = this.commands().get(name);
    if (!command) return undefined;
    const result = await command.handler(args, this.createContext());
    return typeof result === "string" ? result : `/${name} completed.`;
  }
}
