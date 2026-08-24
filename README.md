# note-pi

A desktop-only Obsidian plugin that opens a native-feeling chat pane backed by an embedded [Pi](https://github.com/badlogic/pi-mono) agent runtime. It does not require a `pi` binary installed on the host machine.

## Current slice

- Opens an Obsidian chat view from the command palette.
- Presents the active note as lightweight context, without making the note the agent's source of truth.
- Streams status and assistant messages into the view.
- Lets you choose Google Gemini, Anthropic, GitHub Copilot, Moonshot AI, or OpenRouter.
- Stores provider API keys and tokens in the plugin's local Obsidian data file.
- Checks Obsidian's embedded Node version against Pi's Node 22.19 runtime floor.

## Architecture

The Obsidian layer is deliberately a view/controller: it renders messages, collects user intent, and persists plugin settings. `EmbeddedHarness` owns Pi model setup, agent/session lifecycle, cancellation, and transcript events.

Obsidian's current renderer runtime cannot launch a reliable Node child process or worker thread, so this first slice loads the harness in-process behind a narrow controller interface. This is a structural separation, not a security boundary. A future process-isolated harness remains an optional deployment evolution when the host supports it.

## Development

```bash
npm install
npm run verify
```

To try it in Obsidian, install or symlink the built `main.js`, `manifest.json`, and `styles.css` into a desktop vault's `.obsidian/plugins/note-pi/` directory, enable the plugin, open **Open Note Pi settings**, choose a provider and model from Pi's catalog, then save its API key or token. Obsidian plugin data is local storage, not OS keychain-backed secret storage.

Note Pi intentionally supports API keys and tokens only. A Gemini API key can use Google AI Studio free-tier quota when available.

## Release notes

`main.js` and source maps are build artifacts and intentionally excluded from Git. A distributable plugin release must contain the built `main.js` alongside `manifest.json` and `styles.css`.

`npm run spike:surface` compares published package metadata for the minimal `pi-agent-core` path and the full `pi-coding-agent` path.
