/**
 * Deploy the built plugin into the shared testing vault and reload it in the
 * running Obsidian app via the Obsidian CLI.
 *
 * Usage: npm run deploy:testing
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const TESTING_VAULT_PLUGIN = "/Users/yikangy/self/obsidian-plugins/obsidian-rednote/testing_vault/.obsidian/plugins/note-pi";

for (const artifact of ["main.js", "styles.css", "manifest.json"]) {
  await cp(artifact, join(TESTING_VAULT_PLUGIN, artifact));
}
await rm(join(TESTING_VAULT_PLUGIN, "runtime"), { recursive: true, force: true });
await mkdir(join(TESTING_VAULT_PLUGIN, "runtime"), { recursive: true });
await cp("runtime", join(TESTING_VAULT_PLUGIN, "runtime"), { recursive: true });

execFileSync("obsidian", ["vault=testing_vault", "plugin:reload", "id=note-pi"], { stdio: "inherit" });
console.log("Deployed and reloaded note-pi in testing_vault.");
