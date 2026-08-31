import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { EmbeddedHarness } from "../src/harness/host.mjs";

for (const required of ["main.js", "manifest.json"]) {
  assert.ok(existsSync(required), `Missing built artifact: ${required}`);
}
assert.ok(existsSync("runtime/jiti/lib/jiti.cjs"), "Missing vendored jiti runtime required for extension loading.");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
assert.equal(manifest.isDesktopOnly, false, "The plugin is universal; the desktop runtime is selected by the main.js dispatcher.");

const bundle = readFileSync("main.js", "utf8");
assert.ok(!bundle.includes("import(__rewriteRelativeImportExtension(specifier))"), "Pi's dynamic Node imports must be bridged for the Obsidian renderer.");
assert.ok(!bundle.includes("openaiCodex: () => openaiCodexOAuth"), "The API-only plugin must not bundle OAuth flow loaders.");
assert.match(bundle, /dist\/babel\.cjs/, "main.js must embed jiti so BRAT installs can restore the extension runtime.");

const health = await new EmbeddedHarness().health("standalone");
assert.equal(health.piHostInstallationRequired, false);
assert.equal(health.piAgentCoreLoaded, true, "Pi agent core must load from the plugin's packaged dependencies.");
console.log("Standalone Slice 0 harness verification passed.");
