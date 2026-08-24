export const MINIMUM_NODE = [22, 19, 0] as const;

export interface RuntimeCheck {
  supported: boolean;
  message: string;
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.replace(/^v/, ""));
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function checkPiRuntime(nodeVersion: string): RuntimeCheck {
  const parsed = parseVersion(nodeVersion);
  if (!parsed) {
    return { supported: false, message: `Cannot parse embedded Node version: ${nodeVersion}` };
  }
  const [major, minor, patch] = parsed;
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_NODE;
  const supported = major > minimumMajor ||
    (major === minimumMajor && (minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch)));
  return supported
    ? { supported: true, message: `Embedded Node ${nodeVersion} is supported.` }
    : { supported: false, message: `Obsidian's embedded Node ${nodeVersion} is unsupported. Reinstall Obsidian 1.10 or later.` };
}
