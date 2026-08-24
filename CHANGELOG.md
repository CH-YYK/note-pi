# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0.0] - 2026-08-23

### Added

- A desktop-only Obsidian chat pane backed by a bundled Pi agent runtime.
- Gemini provider settings, streaming chat updates, cancellation, transcript rendering, and note-context display.
- Runtime compatibility and standalone-harness verification tests.
- Kimi K3 API-key provider support.
- Provider-specific model selection backed by Pi's bundled model catalog.

### Changed

- Renamed the plugin and repository to Note Pi for Obsidian community-plugin naming compliance.
- Added provider selection and API-key setup for supported providers.

### Fixed

- Removed the unsupported OAuth sign-in flow in Obsidian; provider setup now uses API keys and tokens only.
