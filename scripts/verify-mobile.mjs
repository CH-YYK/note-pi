import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

assert.ok(existsSync("mobile.js"), "Missing built artifact: mobile.js. Run npm run build first.");

const bundle = readFileSync("mobile.js", "utf8");

// The mobile bundle must be WebView-safe: no static Node imports, no Node
// fetch/stream adapters, no Node execution environment, no jiti extension
// loader. pi-ai's guarded dynamic fallbacks (import(...) of node modules
// behind runtime detection) are allowed because mobile never invokes them.
for (const forbidden of ['require("node:', "from \"node:", 'require("node-fetch', "NodeExecutionEnv", "jiti"]) {
  assert.ok(!bundle.includes(forbidden), `mobile.js must not contain: ${forbidden}`);
}
assert.ok(bundle.includes('require("obsidian")'), "mobile.js must keep obsidian as an external.");

// The desktop artifact and manifest are untouched by the mobile target until
// the spike passes on real iPad hardware.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
assert.equal(manifest.isDesktopOnly, true, "isDesktopOnly flips only after on-device validation of the mobile build.");

console.log("Mobile bundle verification passed.");
