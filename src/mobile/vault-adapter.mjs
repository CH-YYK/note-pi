/**
 * Mobile vault adapter: exposes vault reads to the Pi agent loop through an
 * injected Obsidian vault facade. No Node filesystem access exists here —
 * the facade is implemented with Obsidian's mobile-safe vault APIs, which are
 * rooted at the vault. The path policy below is defense in depth on top of
 * that: every agent-supplied path is normalized to a vault-relative form and
 * any traversal or absolute path is rejected before the facade is touched.
 */
import { Type } from "typebox";

/**
 * Normalize an agent-supplied path into a vault-relative path.
 * Throws when the path is empty, absolute, or attempts traversal.
 */
export function normalizeVaultPath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("A vault-relative path is required.");
  }
  const unified = rawPath.trim().replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:\//.test(unified)) {
    throw new Error(`Path escapes the vault: ${rawPath}`);
  }
  const segments = [];
  for (const segment of unified.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new Error(`Path escapes the vault: ${rawPath}`);
    segments.push(segment);
  }
  if (!segments.length) throw new Error("A vault-relative path is required.");
  return segments.join("/");
}

/**
 * The mobile read tool. `vault` is a facade over Obsidian's vault APIs:
 *   { readText(vaultRelativePath): Promise<string> }
 * Boundary violations throw before the facade is called, so the tool can
 * never reach outside the active vault.
 */
export function createMobileVaultReadTool(vault) {
  return {
    name: "read",
    label: "Read note",
    description: "Read the text contents of a note in the Obsidian vault. Paths are vault-relative, for example 'Notes/Idea.md'.",
    parameters: Type.Object(
      { path: Type.String({ description: "Vault-relative path of the note to read." }) },
      { additionalProperties: false }
    ),
    execute: async (_toolCallId, { path }) => {
      const normalized = normalizeVaultPath(path);
      const text = await vault.readText(normalized);
      return { content: [{ type: "text", text }], details: { path: normalized } };
    }
  };
}
