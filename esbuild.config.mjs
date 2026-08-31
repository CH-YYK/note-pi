import esbuild from "esbuild";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * @google/genai ships separate node and browser variants behind export
 * conditions. platform "node" resolution picks the node variant, which reads
 * bare `process` globals that don't exist in Obsidian's iOS WebView (and
 * pulls in google-auth-library's Node-only dependency tree). The plugin only
 * uses API-key auth, which the web variant fully supports, so pin every
 * import of @google/genai to the web variant — the same resolution the
 * browser-platform mobile.js build already validates.
 *
 * Same story for debug: its "browser" field points at the WebView-safe
 * variant, while platform "node" resolution picks src/node.js, which lazily
 * requires the "process" builtin. Pin the browser variant too.
 *
 * And for yaml: its exports map has an explicit "node" condition pointing at
 * the CJS build, whose parser requires the "process" builtin; the default
 * (browser) build is environment-neutral. Pin the browser build.
 */
const genaiWebEntry = join(import.meta.dirname, "node_modules", "@google", "genai", "dist", "web", "index.mjs");
const debugBrowserEntry = join(import.meta.dirname, "node_modules", "debug", "src", "browser.js");
const yamlBrowserEntry = join(import.meta.dirname, "node_modules", "yaml", "browser", "index.js");

async function readRuntimeFiles(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await readRuntimeFiles(absolutePath, relativePath));
    else files[relativePath.replaceAll("\\", "/")] = (await readFile(absolutePath)).toString("base64");
  }
  return files;
}

const vendoredJitiRuntimePlugin = {
  name: "vendored-jiti-runtime",
  setup(build) {
    build.onResolve({ filter: /^note-pi-jiti-runtime$/ }, () => ({ path: "note-pi-jiti-runtime", namespace: "note-pi" }));
    build.onLoad({ filter: /.*/, namespace: "note-pi" }, async () => ({
      contents: `export const JITI_RUNTIME_FILES = ${JSON.stringify(await readRuntimeFiles("node_modules/jiti"))};`,
      loader: "js"
    }));
  }
};

const rendererNodeImportBridge = {
  name: "renderer-node-import-bridge",
  setup(build) {
    build.onLoad({ filter: /node_modules\/@earendil-works\/pi-ai\/dist\/.*\.js$/ }, async (args) => {
      let source = await readFile(args.path, "utf8");
      source = source
        // Pi's dynamic Node imports don't resolve in the Obsidian renderer,
        // so bridge them to require(). The require result can be null where
        // Node is unavailable to the WebView (mobile emulation stubs it);
        // resolve an empty module then, so guarded fallbacks that probe the
        // result (e.g. pi-ai's env-api-keys) stay silent instead of throwing.
        .replace("const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier));", "const dynamicImport = (specifier) => Promise.resolve(require(specifier) ?? {});")
        .replace("const importNodeModule = (specifier) => import(__rewriteRelativeImportExtension(specifier));", "const importNodeModule = (specifier) => Promise.resolve(require(specifier) ?? {});");
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
  minify: true,
  sourcemap: true,
  external: ["obsidian"],
  plugins: [rendererNodeImportBridge, vendoredJitiRuntimePlugin],
  logLevel: "info"
};

await esbuild.build({
  ...shared,
  // Universal entry: src/entry.ts dispatches on Platform.isMobile and
  // lazily require()s the desktop or mobile subtree, so the unselected
  // runtime's module scope (including the desktop tree's Node imports) never
  // evaluates. platform "node" keeps Node builtins external — they are only
  // reached inside the lazily-initialized desktop subtree. target es2022
  // keeps the emitted syntax inside the iOS WebView's support window.
  target: "es2022",
  alias: { "@google/genai": genaiWebEntry, debug: debugBrowserEntry, yaml: yamlBrowserEntry },
  entryPoints: ["src/entry.ts"],
  format: "cjs",
  outfile: "main.js"
});

// Mobile (iPad/iPhone) verification build: the mobile subtree on its own,
// bundled with platform "browser" so any accidental `node:*` import is a
// build error. The shipped artifact is the universal main.js above; this
// build exists so verify-mobile.mjs can prove the mobile runtime is
// WebView-safe, and the rendererNodeImportBridge (which rewrites dynamic
// imports to require) intentionally does not apply — guarded dynamic
// fallbacks inside pi-ai stay dynamic and simply never run in the WebView.
await esbuild.build({
  bundle: true,
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  external: ["obsidian"],
  format: "cjs",
  entryPoints: ["src/mobile/main.ts"],
  outfile: "mobile.js",
  logLevel: "info"
});

// jiti cannot be bundled (it lazy-requires its babel transform relative to
// its own module URL), so ship it as vendored runtime files instead.
await rm("runtime/jiti", { recursive: true, force: true });
await mkdir("runtime/jiti", { recursive: true });
for (const entry of ["dist", "lib", "package.json"]) {
  await cp(`node_modules/jiti/${entry}`, `runtime/jiti/${entry}`, { recursive: true });
}
console.log("runtime/jiti vendored");
