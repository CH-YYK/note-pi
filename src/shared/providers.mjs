/**
 * Provider catalog shared by the desktop and mobile builds. Pure data only —
 * this module must stay free of Node and Obsidian imports so both bundles
 * can consume it.
 */
export const AUTH_PROVIDERS = [
  { id: "google", label: "Google Gemini", apiKeyLabel: "Gemini API key", defaultModel: "gemini-3.6-flash" },
  { id: "anthropic", label: "Anthropic", apiKeyLabel: "Anthropic API key", defaultModel: "claude-sonnet-4-5" },
  { id: "github-copilot", label: "GitHub Copilot", apiKeyLabel: "GitHub token", defaultModel: "gpt-4.1" },
  { id: "kimi-coding", label: "Kimi Code", apiKeyLabel: "Kimi Code API key", defaultModel: "k3" },
  { id: "openrouter", label: "OpenRouter", apiKeyLabel: "OpenRouter API key", defaultModel: "openai/gpt-4o-mini" }
];

/**
 * Providers validated for the mobile (iOS WebView) build. The first mobile
 * profile ships Google Gemini only; additional providers join this list after
 * their transport is validated through Obsidian's requestUrl on-device.
 */
export const MOBILE_PROVIDER_IDS = ["google"];
