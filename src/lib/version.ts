/** Manifest shape mirror (structural — no import from updater.ts to keep this pure). */
export interface VersionedManifest {
  version: string;
}

/**
 * semver-ish compare: positive if a > b, negative if a < b, 0 if equal.
 * Numeric segments compared in order; non-numeric segments (prerelease
 * suffixes like "-ls.1") parse to 0 so mixed-shape comparisons never
 * produce NaN — "0.4.1-ls.1" vs "0.4.0" must yield "newer", not the
 * NaN-falsy miss that plain Number() produced. (Uncia finding, PR #8.)
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(/[.\-+]/).map((seg) => parseInt(seg, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function isUpdateAvailable(manifest: VersionedManifest, currentVersion: string): boolean {
  return compareVersions(manifest.version, currentVersion) > 0;
}
