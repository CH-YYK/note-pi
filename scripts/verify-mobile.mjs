import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

assert.ok(existsSync("mobile.js"), "Missing built artifact: mobile.js. Run npm run build first.");

const bundle = readFileSync("mobile.js", "utf8");

// The mobile bundle must be WebView-safe: no static Node imports, no Node
// fetch/stream adapters, no Node execution environment, no jiti extension
// loader. pi-ai's guarded dynamic fallbacks (import(...) of node modules
// behind runtime detection) are allowed because mobile never invokes them.
// One guarded fallback is known and allowed: pi-ai's provider-env.js reads
// /proc/self/environ under Bun only, behind a typeof process check and a
// try/catch, so its require("node:fs") can never evaluate in the WebView.
// Allow exactly that occurrence; any other Node require fails the build.
const bunProcEnvFallback = 'require("node:fs")';
if (bundle.includes(bunProcEnvFallback)) {
  const index = bundle.indexOf(bunProcEnvFallback);
  assert.ok(bundle.slice(Math.max(0, index - 800), index).includes("/proc/self/environ") || bundle.slice(index, index + 800).includes("/proc/self/environ"),
    'require("node:fs") is only allowed inside the guarded Bun /proc/self/environ fallback');
}
const scrubbed = bundle.replace(bunProcEnvFallback, "");
for (const forbidden of ['require("node:', "from \"node:", 'require("node-fetch', "NodeExecutionEnv", "jiti"]) {
  assert.ok(!scrubbed.includes(forbidden), `mobile.js must not contain: ${forbidden}`);
}
assert.ok(bundle.includes('require("obsidian")'), "mobile.js must keep obsidian as an external.");

// The shipped artifact is the universal main.js, which must dispatch on
// Platform.isMobile so mobile devices (and mobile emulation) load the
// WebView-safe runtime.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
assert.equal(manifest.isDesktopOnly, false, "The plugin runs on desktop and mobile.");

const universal = readFileSync("main.js", "utf8");
assert.ok(universal.includes("isMobile"), "main.js must dispatch on Platform.isMobile.");

// The universal bundle's Node-style resolution picks node variants of
// packages behind export conditions; those read Node globals the iOS WebView
// doesn't have ("Can't find variable: process" on device). The build pins
// browser variants, so Node-only dependency trees must stay out of main.js.
for (const forbidden of ["google-auth-library", "gcp-metadata", "gaxios"]) {
  assert.ok(!universal.includes(forbidden), "main.js must not contain the Node-only dependency: " + forbidden);
}

console.log("Mobile bundle verification passed.");
