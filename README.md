# Note Pi

A desktop-only Obsidian plugin that opens a native-feeling chat pane backed by bundled [Pi](https://github.com/badlogic/pi-mono) agent libraries. It does not require, launch, or shell out to a `pi` binary installed on the host machine.

## Current slice

- Opens an Obsidian chat view from the command palette.
- Presents the active note as lightweight context, without making the note the agent's source of truth.
- Streams status and assistant messages into the view.
- Lets you choose Google Gemini, Anthropic, GitHub Copilot, Kimi Code, Moonshot AI, or OpenRouter.
- Stores provider API keys and tokens in the plugin's local Obsidian data file.
- Checks Obsidian's embedded Node version against Pi's Node 22.19 runtime floor.

## Architecture

Note Pi has three parts. There is no separate product-level “controller” layer: the small TypeScript methods between the UI and harness are just the plugin's wiring.

| Part | Responsibility | Examples |
| --- | --- | --- |
| **Plugin configuration** | Persistent, vault-local configuration that is analogous to setting up Pi before a session. | Provider selection, API key/token storage, disconnecting a provider. |
| **Chat UI** | The interactive session surface. It sends user input, renders streamed output, and applies session-level harness controls. | Chat messages, cancel, model picker, future slash commands such as `/model` and `/agents`. |
| **Embedded Pi Harness** | The bundled Pi runtime. It applies the selected configuration, owns the Pi agent and provider request, and streams events back. | Pi model catalog, `Agent`, credentials, provider transport, transcript, cancellation. |

Obsidian's current renderer runtime cannot launch a reliable Node child process or worker thread, so this first slice loads the harness in-process behind a narrow UI-to-harness interface. This is a structural separation, not a security boundary. A future process-isolated harness remains an optional deployment evolution when the host supports it.

### Pi runtime, not Pi binary

The release bundles the JavaScript libraries `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` into `main.js`. It deliberately does **not** include the full Pi CLI/coding-agent application or a platform-specific `pi` executable.

That means:

- No host-level Pi installation, PATH entry, child process, or binary download is required.
- The plugin uses Pi's `Agent`, model catalog, provider adapters, credential abstraction, streaming events, and cancellation API directly in the Obsidian Electron process.
- Pi extensions, interactive CLI commands, terminal UI, and host-level Pi skills are not part of this plugin slice. They require an explicit future integration rather than being inherited automatically from a local Pi installation.

**Pi agent directory:** Plugin settings stores a vault-relative `agentDir`, defaulting to `_pi/agent`; paths outside the vault are rejected. The underscore keeps the folder visible in Obsidian's file explorer. The harness receives the resolved `<vault>/_pi/agent` path so the upcoming lightweight resource loader can discover its `skills/`, `extensions/`, prompts, and settings. The current minimal Pi runtime does not yet load those resources; this setting establishes the stable configuration contract without pretending they are active.

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

Provider selection and API-key/token storage live in **Note Pi settings**. The chat header contains the current model picker, the UI equivalent of a basic `/model` control. Model choice is session-only: it is held by the harness, preserves the current transcript, and is never written to Obsidian plugin data. Changing the provider reapplies the persistent provider configuration and starts a fresh harness session.

`/agents` and other Pi-style session controls are part of the intended Chat UI contract but are **not implemented yet**. The active note name is displayed as UI context; the current implementation does not send note contents to the model.

### Provider networking

Obsidian's renderer `fetch` is governed by Chromium's network policy and cannot reliably call all model-provider endpoints. The harness therefore sends Pi provider requests through bundled Node networking (`node-fetch`) and adapts the Node response stream to the Web-stream interface Pi expects. API keys remain in local Obsidian plugin data and are passed only to the selected provider request.

## Using the chat

1. Open **Note Pi settings** from the command palette.
2. Select a provider and save its API key or token.
3. Run **Open Note Pi** from the command palette.
4. Choose a model in the chat header.
5. Send a message. Press `Escape` while a response is streaming to cancel it.

The model menu is scoped to the selected provider's bundled Pi model catalog. Kimi Code and Moonshot AI are separate providers, so their credentials and model lists are not interchangeable.

## Development

```bash
npm install
npm run verify
```

To try it in Obsidian, install or symlink the built `main.js`, `manifest.json`, and `styles.css` into a desktop vault's `.obsidian/plugins/note-pi/` directory, enable the plugin, open **Note Pi settings** to save a provider credential, then open the Note Pi chat and select a model. Obsidian plugin data is local storage, not OS keychain-backed secret storage.

Note Pi intentionally supports API keys and tokens only. A Gemini API key can use Google AI Studio free-tier quota when available. Kimi Code (`https://api.kimi.com/coding`) and Moonshot AI (`https://api.moonshot.ai/v1`) are separate Pi providers with separate credentials and model catalogs.

## Release notes

`main.js` and source maps are build artifacts and intentionally excluded from Git. A distributable plugin release must contain the built `main.js` alongside `manifest.json` and `styles.css`.

`npm run spike:surface` compares published package metadata for the minimal `pi-agent-core` path and the full `pi-coding-agent` path.
