import esbuild from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";

const rendererNodeImportBridge = {
  name: "renderer-node-import-bridge",
  setup(build) {
    build.onLoad({ filter: /node_modules\/@earendil-works\/pi-ai\/dist\/.*\.js$/ }, async (args) => {
      let source = await readFile(args.path, "utf8");
      source = source
        .replace("const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier));", "const dynamicImport = (specifier) => Promise.resolve(require(specifier));")
        .replace("const importNodeModule = (specifier) => import(__rewriteRelativeImportExtension(specifier));", "const importNodeModule = (specifier) => Promise.resolve(require(specifier));");
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

// jiti cannot be bundled (it lazy-requires its babel transform relative to
// its own module URL), so ship it as vendored runtime files instead.
await rm("runtime/jiti", { recursive: true, force: true });
await mkdir("runtime/jiti", { recursive: true });
for (const entry of ["dist", "lib", "package.json"]) {
  await cp(`node_modules/jiti/${entry}`, `runtime/jiti/${entry}`, { recursive: true });
}
console.log("runtime/jiti vendored");
