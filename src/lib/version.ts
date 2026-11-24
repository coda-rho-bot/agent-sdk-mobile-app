/** Manifest shape mirror (structural — no import from updater.ts to keep this pure). */
export interface VersionedManifest {
  version: string;
}

/** semver-ish compare: positive if a > b, negative if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isUpdateAvailable(manifest: VersionedManifest, currentVersion: string): boolean {
  return compareVersions(manifest.version, currentVersion) > 0;
}
