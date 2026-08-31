import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join } from "node:path";

// Smoke test for the universal entry: loading the built main.js must resolve
// to the desktop or mobile plugin class depending on Platform.isMobileApp,
// and each load must not touch the other runtime's module scope.

const BUILT_ENTRY = join(import.meta.dirname, "..", "main.js");
const require = createRequire(join(import.meta.dirname, "entry-dispatch.test.mjs"));

/** Generic stand-in for every Obsidian class extended at module scope. */
class StubBase {}

function obsidianStub(isMobileApp) {
  const platform = { isMobileApp, isDesktopApp: !isMobileApp, isMobile: isMobileApp, isPhone: isMobileApp, isTablet: isMobileApp };
  return new Proxy({ Platform: platform }, {
    get(target, key) {
      return key in target ? target[key] : StubBase;
    }
  });
}

function loadPluginClass(isMobileApp) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return obsidianStub(isMobileApp);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(BUILT_ENTRY)];
    return require(BUILT_ENTRY).default;
  } finally {
    Module._load = originalLoad;
  }
}

test("main.js loads the desktop plugin when Platform.isMobileApp is false", { skip: !existsSync(BUILT_ENTRY) && "main.js not built" }, () => {
  const pluginClass = loadPluginClass(false);
  assert.equal(typeof pluginClass, "function", "main.js must export the plugin class");
  assert.equal(typeof pluginClass.prototype.defaultAgentDir, "function", "expected the desktop plugin class");
  assert.equal(typeof pluginClass.prototype.selectedProvider, "undefined", "must not load the mobile plugin class");
});

test("main.js loads the mobile plugin when Platform.isMobileApp is true", { skip: !existsSync(BUILT_ENTRY) && "main.js not built" }, () => {
  const pluginClass = loadPluginClass(true);
  assert.equal(typeof pluginClass, "function", "main.js must export the plugin class");
  assert.equal(typeof pluginClass.prototype.selectedProvider, "function", "expected the mobile plugin class");
  assert.equal(typeof pluginClass.prototype.defaultAgentDir, "undefined", "must not load the desktop plugin class");
});
