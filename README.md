# Note Pi

A desktop-only Obsidian plugin that opens a native-feeling chat pane backed by bundled [Pi](https://github.com/badlogic/pi-mono) agent libraries. It does not require, launch, or shell out to a `pi` binary installed on the host machine.

## Current slice

- Opens an Obsidian chat view from the command palette.
- Presents the active note as lightweight context, without making the note the agent's source of truth.
- Streams status and assistant messages into the view, rendering assistant Markdown as it arrives.
- Lets you choose Google Gemini, Anthropic, GitHub Copilot, Kimi Code, Moonshot AI, or OpenRouter.
- Stores provider API keys and tokens in the plugin's local Obsidian data file.
- Checks Obsidian's embedded Node version against Pi's Node 22.19 runtime floor.
- Loads pi-coding-agent-compatible extensions from the vault-local Pi agent directory (see Extensions below).

## Architecture

Note Pi has three parts. `AgentController` is the product-level application layer: it receives UI intents, owns provider/session/extension policy, and publishes UI-facing snapshots and events. `PiAgentRuntime` is its thin adapter around Pi's core runtime.

| Part | Responsibility | Examples |
| --- | --- | --- |
| **Plugin configuration** | Persistent, vault-local configuration that is analogous to setting up Pi before a session. | Provider selection, API key/token storage, disconnecting a provider. |
| **Chat UI** | The interactive session surface. It sends user input, renders streamed output, and applies session-level harness controls. | Chat messages, cancel, composer model picker, extension slash commands; future `/model` and `/agents`. |
| **AgentController + Embedded Pi Runtime** | The application layer and bundled Pi integration. The controller applies configuration and session policy; the runtime creates Pi agents, adapts provider streaming, and exposes core tools. | `AgentController`, `PiAgentRuntime`, Pi model catalog, credentials, provider transport, transcript, cancellation. |

Obsidian's current renderer runtime cannot launch a reliable Node child process or worker thread, so this first slice loads the harness in-process behind a narrow UI-to-harness interface. This is a structural separation, not a security boundary. A future process-isolated harness remains an optional deployment evolution when the host supports it.

### Pi runtime, not Pi binary

The release bundles the JavaScript libraries `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` into `main.js`. It deliberately does **not** include the full Pi CLI/coding-agent application or a platform-specific `pi` executable.

That means:

- No host-level Pi installation, PATH entry, child process, or binary download is required.
- The controller uses `PiAgentRuntime` to access Pi's `Agent`, model catalog, provider adapters, credential abstraction, streaming events, and cancellation API directly in the Obsidian Electron process.
- Pi's interactive CLI commands, terminal UI, and host-level Pi resources are not part of this plugin slice. They require an explicit future integration rather than being inherited automatically from a local Pi installation. Vault-local extensions are the exception; see below.

**Pi agent directory:** Plugin settings stores a vault-relative `agentDir`, defaulting to `_pi/agent`; paths outside the vault are rejected. The underscore keeps the folder visible in Obsidian's file explorer. The harness receives the resolved `<vault>/_pi/agent` path and discovers its `extensions/` directory (see below). Skills, prompts, and settings are future resource-loader work.

## Extensions

Note Pi resolves extensions the same way pi-coding-agent does, rooted at the vault-local agent directory instead of `~/.pi/agent`:

- `<agentDir>/extensions/*.ts|*.js` load directly.
- `<agentDir>/extensions/<name>/index.ts|index.js` load as subdirectory entries.
- `<agentDir>/extensions/<name>/package.json` with a `pi.extensions` field loads its declared paths.

Discovery never recurses beyond one level and never touches global Pi locations. Extensions are TypeScript or JavaScript modules whose default export is a factory function receiving a subset of Pi's `ExtensionAPI`:

```typescript
import { Type } from "typebox";

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => ctx.ui.notify("loaded"));
  pi.registerTool({ name: "my_tool", description: "…", parameters: Type.Object({}), async execute(id, params) { /* … */ } });
  pi.registerCommand("mycommand", { description: "…", handler: async (args, ctx) => "result" });
}
```

Supported handlers: `session_start`, `session_shutdown`, `turn_start`, `turn_end`, `tool_call` (may return `{ block: true, reason }`), and `tool_result`. Registered tools join the agent's tool list next to the vault read tool, and `/name args` typed in the composer invokes a registered command. `typebox` and the bundled Pi packages resolve as virtual modules, so CLI-style imports work unchanged. A header chip lists loaded extensions and any load failures.

Extensions execute arbitrary code with the plugin's permissions. Only place extensions you trust in the vault's agent directory.

### UI-to-harness flow

```
Plugin configuration                 Chat UI                              Embedded Pi Harness
────────────────────                 ───────                              ───────────────────
provider + API key ───────► apply persistent configuration ─────────────► configure providers + credentials
                                      │
                                      ├─ model picker / future `/model` ─► apply session model
                                      ├─ future `/agents` ───────────────► apply agent configuration
                                      ├─ send message ───────────────────► Agent.prompt()
                                      └─ Escape / cancel ────────────────► Agent.abort()
                                      ◄────────────────────────────────── Pi streaming events
                                      render message deltas
```

Provider selection and API-key/token storage live in **Note Pi settings**. The composer bar contains the current model picker, the UI equivalent of a basic `/model` control. Model choice is session-only: it is held by the harness, preserves the current transcript, and is never written to Obsidian plugin data. Changing the provider reapplies the persistent provider configuration and starts a fresh harness session.

`/agents` and other Pi-style session controls are part of the intended Chat UI contract but are **not implemented yet**. The active note name is displayed as UI context; the current implementation does not send note contents to the model.

### Provider networking

Obsidian's renderer `fetch` is governed by Chromium's network policy and cannot reliably call all model-provider endpoints. The harness therefore sends Pi provider requests through bundled Node networking (`node-fetch`) and adapts the Node response stream to the Web-stream interface Pi expects. API keys remain in local Obsidian plugin data and are passed only to the selected provider request.

## Using the chat

1. Open **Note Pi settings** from the command palette.
2. Select a provider and save its API key or token.
3. Run **Open Note Pi** from the command palette.
4. Choose a model in the composer bar.
5. Send a message. Press `Escape` while a response is streaming to cancel it.

The model menu is scoped to the selected provider's bundled Pi model catalog. Kimi Code and Moonshot AI are separate providers, so their credentials and model lists are not interchangeable.

## Development

```bash
npm install
npm run verify
```

To try it in Obsidian, install or symlink the built `main.js`, `manifest.json`, `styles.css`, and the vendored `runtime/` directory into a desktop vault's `.obsidian/plugins/note-pi/` directory, enable the plugin, open **Note Pi settings** to save a provider credential, then open the Note Pi chat and select a model. Obsidian plugin data is local storage, not OS keychain-backed secret storage.

With the Obsidian CLI enabled, `npm run deploy:testing` builds, copies the artifacts into the shared testing vault, and hot-reloads the plugin in the running app.

Note Pi intentionally supports API keys and tokens only. A Gemini API key can use Google AI Studio free-tier quota when available. Kimi Code (`https://api.kimi.com/coding`) and Moonshot AI (`https://api.moonshot.ai/v1`) are separate Pi providers with separate credentials and model catalogs.

## Release notes

`main.js` and source maps are build artifacts and intentionally excluded from Git. A distributable plugin release must contain the built `main.js` alongside `manifest.json` and `styles.css`.

`npm run spike:surface` compares published package metadata for the minimal `pi-agent-core` path and the full `pi-coding-agent` path.
