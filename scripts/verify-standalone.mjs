import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { EmbeddedHarness } from "../src/harness/host.mjs";

for (const required of ["main.js", "manifest.json"]) {
  assert.ok(existsSync(required), `Missing built artifact: ${required}`);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
assert.equal(manifest.isDesktopOnly, true, "The embedded Node runtime requires a desktop-only plugin.");

const health = await new EmbeddedHarness().health("standalone");
assert.equal(health.piHostInstallationRequired, false);
assert.equal(health.piAgentCoreLoaded, true, "Pi agent core must load from the plugin's packaged dependencies.");
console.log("Standalone Slice 0 harness verification passed.");
