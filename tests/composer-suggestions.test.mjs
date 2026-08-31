import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { composerTrigger, filterSuggestions, replaceComposerRange } from "../src/composer-suggestions.mjs";

test("composer trigger detects @ mentions after whitespace and preserves their replacement range", () => {
  assert.deepEqual(composerTrigger("Compare @pro", 12), { kind: "note", query: "pro", start: 8, end: 12 });
  assert.equal(replaceComposerRange("Compare @pro", 8, 12, ""), "Compare ");
  assert.equal(composerTrigger("email@project", 13), undefined);
});

test("composer trigger only offers slash commands where the harness can run them", () => {
  assert.deepEqual(composerTrigger("/sum", 4), { kind: "command", query: "sum", start: 0, end: 4 });
  assert.equal(composerTrigger("Ask /sum", 8), undefined);
  assert.equal(composerTrigger("/sum arguments", 14), undefined);
});

test("suggestion filtering ranks name prefixes before path-only matches", () => {
  const entries = [
    { name: "Architecture", detail: "Notes/Architecture.md" },
    { name: "Project brief", detail: "Projects/Architecture/brief.md" },
    { name: "Archive", detail: "Archive.md" }
  ];
  assert.deepEqual(filterSuggestions(entries, "arch").map((entry) => entry.name), ["Architecture", "Archive", "Project brief"]);
  assert.deepEqual(filterSuggestions(entries, "", 2).map((entry) => entry.name), ["Architecture", "Archive"]);
});

test("pointer selection keeps its option mounted until its click handler runs", async () => {
  const source = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
  assert.match(source, /option\.addEventListener\("click", \(\) => this\.chooseSuggestion\(item\)\);/);
  assert.doesNotMatch(source, /option\.addEventListener\("mouseenter",\s*\(\) =>\s*\{\s*this\.suggestionIndex = index;\s*this\.renderComposerSuggestion\(\);/);
});
