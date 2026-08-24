import { execFileSync } from "node:child_process";

for (const packageName of ["@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent"]) {
  const metadata = execFileSync("npm", ["view", `${packageName}@0.84.2`, "version", "dist.unpackedSize", "engines", "dependencies", "--json"], { encoding: "utf8" });
  console.log(`\n${packageName}@0.84.2\n${metadata}`);
}
