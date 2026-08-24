import esbuild from "esbuild";
import { readFile } from "node:fs/promises";

const rendererNodeImportBridge = {
  name: "renderer-node-import-bridge",
  setup(build) {
    build.onLoad({ filter: /node_modules\/@earendil-works\/pi-ai\/dist\/.*\.js$/ }, async (args) => {
      let source = await readFile(args.path, "utf8");
      source = source
        .replaceAll('import("node:http")', 'Promise.resolve(require("node:http"))')
        .replaceAll('import("node:crypto")', 'Promise.resolve(require("node:crypto"))')
        .replace("const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier));", "const dynamicImport = (specifier) => Promise.resolve(require(specifier));")
        .replace("const importNodeModule = (specifier) => import(__rewriteRelativeImportExtension(specifier));", "const importNodeModule = (specifier) => Promise.resolve(require(specifier));");
      if (args.path.endsWith("/auth/oauth/load.js")) {
        source = [
          'import { anthropicOAuth } from "./anthropic.js";',
          'import { githubCopilotOAuth } from "./github-copilot.js";',
          'import { openaiCodexOAuth } from "./openai-codex.js";',
          'import { openRouterOAuth } from "./openrouter.js";',
          source.replace("let bundledLoaders;", "let bundledLoaders = { anthropic: () => anthropicOAuth, openaiCodex: () => openaiCodexOAuth, githubCopilot: () => githubCopilotOAuth, openrouter: () => openRouterOAuth };")
        ].join("\n");
      }
      return {
        contents: source,
        loader: "js"
      };
    });
  }
};

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["obsidian"],
  plugins: [rendererNodeImportBridge],
  logLevel: "info"
};

await esbuild.build({
  ...shared,
  entryPoints: ["src/main.ts"],
  format: "cjs",
  outfile: "main.js"
});
