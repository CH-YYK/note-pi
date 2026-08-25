# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0.0] - 2026-08-25

### Added

- Pi-compatible extensions: drop `.ts` or `.js` extensions into the vault-local Pi agent directory (`_pi/agent/extensions/`) and they load with pi-coding-agent discovery rules (direct files, subdirectory `index.ts`/`index.js` entries, and `package.json` `pi.extensions` declarations).
- Extensions can register LLM-callable tools, slash commands, and lifecycle handlers (`session_start`, `session_shutdown`, `turn_start`, `turn_end`, `tool_call`, `tool_result`) through a subset of Pi's ExtensionAPI. `tool_call` handlers can block execution.
- Slash commands registered by extensions run straight from the composer (`/name args`).
- A header chip shows how many extensions loaded, with their tools, commands, and any load failures on hover.
- Assistant messages render as Markdown, including while streaming: headings, lists, code blocks, links, and tables inherit the vault theme.
- Click-to-fill prompt suggestions on the empty state, and a Jump to latest control when scrolled away from the bottom.
- `npm run deploy:testing` builds, deploys, and hot-reloads the plugin in the testing vault.

### Changed

- The composer is now a rounded box with an auto-growing textarea and a bottom bar holding the context chip, the model picker (moved from the header), keyboard hints, and a send button that becomes a stop button while streaming.

### Fixed

- Activity cards now settle to done when a turn completes instead of showing "working" forever.
- Slash-command and other non-streaming responses render their returned text instead of staying blank.
- The Node-backed fetch adapter now exposes `text()`, `json()`, and `arrayBuffer()`, so provider errors surface their real messages (for example rate limits) instead of "response.text is not a function".

## [0.1.0.0] - 2026-08-23

### Added

- A desktop-only Obsidian chat pane backed by a bundled Pi agent runtime.
- Gemini provider settings, streaming chat updates, cancellation, transcript rendering, and note-context display.
- Runtime compatibility and standalone-harness verification tests.
- Moonshot AI Kimi K3 API-key provider support.
- Kimi Code as a separate API-key provider, using Pi's Kimi Code endpoint and model catalog.
- Provider-specific model selection backed by Pi's bundled model catalog.

### Changed

- Renamed the plugin and repository to Note Pi for Obsidian community-plugin naming compliance.
- Added provider selection and API-key setup for supported providers.

### Fixed

- Removed the unsupported OAuth sign-in flow in Obsidian; provider setup now uses API keys and tokens only.
- Route Moonshot AI tokens through Pi's Moonshot API provider and endpoint.
