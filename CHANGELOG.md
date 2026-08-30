# Changelog

All notable changes to this project will be documented in this file.

## [0.5.3] - 2026-08-30

### Fixed

- Preserve Note Pi leaves when the plugin unloads, so user-chosen pane placement survives reloads.
- Use supported Obsidian settings and style APIs, and declare the 1.13.0 minimum app version they require.
- Build a minified desktop bundle (under Obsidian Sync's 5 MB limit) and use Node 22's built-in fetch instead of a direct `node-fetch` dependency.

### Added

- An MIT license and tag-driven GitHub release workflow that generates provenance attestations for `main.js` and `styles.css`.

## [0.5.2] - 2026-08-30

### Fixed

- The automatically included current note can now be toggled off. When auto-context is on, the focused note is added once at the start of each session as a regular context chip that can be removed with its × control, replacing the separate Auto on/off toggle in the composer.
- Thinking progress is now visible in the chat UI. Reasoning deltas stream into the Thinking activity entry, which expands to show the full text on desktop and stays open inline on mobile; the entry closes when the answer starts streaming or a tool call begins, and each reasoning round gets its own entry.
- Conversation text in the chat view can now be selected and copied. The transcript opts back into text selection (Obsidian disables it app-wide), while interactive elements like the activity timeline and copy buttons stay non-selectable.

## [0.5.1] - 2026-08-30

### Changed

- Extensions are now discovered exclusively from the configured Pi agent directory's `extensions/` folder. The settings tab is a compact inventory with extension name and description columns, while the Pi agent directory remains configured under General.
- Extension names and descriptions use package metadata when available, so installed packages such as `pi-util-commands` appear with their own description.

### Removed

- The separate extension-source configuration and reload controls. Note Pi no longer loads extension modules from arbitrary vault paths.

### Fixed

- BRAT installs now restore the bundled TypeScript extension runtime automatically, so extensions work after installation from the GitHub release assets.

## [0.5.0.0] - 2026-08-29

### Added

- Chat now works with every configured provider at once: the composer model picker groups all available models by provider, so switching between Kimi Code, Anthropic, OpenRouter, and others is a single pick without revisiting settings.
- Each saved provider key has a connection test button that probes the provider with a minimal request and reports the responding model and latency inline.
- The composer automatically attaches the currently focused note as context (on by default), with an Auto toggle in the context row and a matching setting under General. The attached note follows your focus as you switch notes.

### Changed

- Settings split into General and API Provider tabs. The API Provider tab is a pure key manager: a provider dropdown plus key entry up top (works for first-time setup and adding more providers), and an Added keys list below with compact replace, test, and remove actions. Key management no longer changes which provider chats.
- Saved keys display masked (last four characters) so you can tell at a glance which credential is stored.

### Removed

- The deprecated Moonshot AI provider (Kimi Code remains the Kimi entry). Credentials stored for providers that no longer exist are pruned automatically on load.

### Fixed

- Removing the key of the provider your session is using now falls back to another configured provider instead of breaking chat.
- Saving the Pi agent directory and toggling focused-note context no longer crash the settings tab.

## [0.4.0.0] - 2026-08-29

### Added

- Desktop settings can now configure trusted, vault-local Pi extension sources. Sources may be individual TypeScript/JavaScript modules, Pi extension package directories, or directories of extensions; saving reloads them immediately.
- The Extensions settings panel now acts as a management surface, showing loaded modules, their tools and commands, load errors, and a reload action. Common Coding Agent inspection extensions can use limited agent-directory and tool/command compatibility helpers without requiring Pi's terminal UI.

## [0.3.0.0] - 2026-08-25

### Added

- Mobile (iPad/iPhone) runtime slice as a distinct build target: `npm run build` now emits a browser-safe `mobile.js` alongside the desktop `main.js`, wiring `MobileAgentView -> MobileAgentController -> MobileAgentRuntime -> pi-agent-core Agent` with no Node APIs, no extensions, and no shell tools.
- A deterministic fake streaming provider (`src/mobile/fake-provider.mjs`) that speaks Pi's AssistantMessageEventStream protocol, used by the mobile spike and its tests.
- A mobile vault read tool built on Obsidian's vault APIs with a strict vault-relative path policy that rejects traversal and absolute paths before any read happens.
- A provider transport adapter over Obsidian's `requestUrl` so mobile provider calls use the mobile-safe network path.
- Mobile session persistence through Obsidian's plugin data APIs, with resume after the view is closed and reopened; the session record shape matches the desktop store.
- A compact touch-first mobile chat view (larger tap targets, session history in a touch menu instead of a rail) backed by the same typed harness-client contract as the desktop view.
- `npm run verify:mobile` asserts the mobile bundle contains no `node:` imports, `node-fetch`, the Node execution environment, or the jiti loader.

### Fixed

- The controller/runtime refactor wrapped `initialState` twice when constructing the Pi `Agent`, so desktop turns ran with a placeholder model, an empty system prompt, and no tools. Both runtimes now pass the controller-prepared options through unchanged, and a regression test asserts the agent receives the configured model, prompt, and tools.

## [0.2.1.0] - 2026-08-25

### Changed

- The chat application now uses an explicit `AgentController` and `PiAgentRuntime` boundary. Pi's core loop, Node stream adapter, and native read-tool setup are isolated from the Obsidian-facing session, provider, and extension policy.

## [0.2.0.0] - 2026-08-25

### Added

- Pi-compatible extensions: drop `.ts` or `.js` extensions into the vault-local Pi agent directory (`_pi/agent/extensions/`) and they load with pi-coding-agent discovery rules (direct files, subdirectory `index.ts`/`index.js` entries, and `package.json` `pi.extensions` declarations).
- Extensions can register LLM-callable tools, slash commands, and lifecycle handlers (`session_start`, `session_shutdown`, `turn_start`, `turn_end`, `tool_call`, `tool_result`) through a subset of Pi's ExtensionAPI. `tool_call` handlers can block execution.
- Slash commands registered by extensions run straight from the composer (`/name args`).
- A header chip shows how many extensions loaded, with their tools, commands, and any load failures on hover.
- Assistant messages render as Markdown, including while streaming: headings, lists, code blocks, links, and tables inherit the vault theme.
- Agent activity renders as a timeline with state dots, measured durations, and expandable rows whose details link to the target note; the header shows the session title and a live token count, with a new-session button.
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
