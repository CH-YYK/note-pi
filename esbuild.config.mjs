import esbuild from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["obsidian"],
  logLevel: "info"
};

await esbuild.build({
  ...shared,
  entryPoints: ["src/main.ts"],
  format: "cjs",
  outfile: "main.js"
});
