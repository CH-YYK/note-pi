import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("settings retain tabbed sections through the declarative API", async () => {
  const source = await readFile(new URL("../src/settings.ts", import.meta.url), "utf8");

  assert.match(source, /private activeTab: SettingsTabId = "general"/);
  assert.match(source, /renderTabBar\(setting, tabs\)/);
  assert.match(source, /this\.activeTab = id;\s*this\.update\(\)/);
  assert.doesNotMatch(source, /\bdisplay\s*\(/);
});
