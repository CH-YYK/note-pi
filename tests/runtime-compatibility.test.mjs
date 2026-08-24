import test from "node:test";
import assert from "node:assert/strict";

function checkPiRuntime(nodeVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion.replace(/^v/, ""));
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}

test("requires Pi's Node 22.19 runtime floor", () => {
  assert.equal(checkPiRuntime("22.18.9"), false);
  assert.equal(checkPiRuntime("22.19.0"), true);
  assert.equal(checkPiRuntime("22.20.0"), true);
  assert.equal(checkPiRuntime("23.0.0"), true);
});
