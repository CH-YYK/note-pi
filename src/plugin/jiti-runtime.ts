import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JITI_RUNTIME_FILES } from "note-pi-jiti-runtime";

/**
 * BRAT installs only the release's top-level plugin assets. Embed jiti in the
 * bundle and restore it alongside the plugin so TypeScript extensions keep
 * working after a BRAT installation.
 */
export async function ensureVendoredJitiRuntime(pluginDir: string): Promise<string> {
  const runtimeDir = join(pluginDir, "runtime", "jiti");
  const entryPath = join(runtimeDir, "lib", "jiti.cjs");
  if (existsSync(entryPath)) return entryPath;
  for (const [relativePath, encodedContents] of Object.entries(JITI_RUNTIME_FILES)) {
    const destination = join(runtimeDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(encodedContents, "base64"));
  }
  return entryPath;
}
