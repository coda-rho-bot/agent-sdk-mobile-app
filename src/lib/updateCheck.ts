/**
 * Update check for side-loaded builds — no Play Store, so the app asks the
 * fork's public GitHub releases for the latest version and surfaces a banner
 * when the installed build is behind.
 *
 * - Local version: Application.nativeApplicationVersion (the APK's
 *   versionName, set from app.json "version" at prebuild time).
 * - Remote version: the latest release tag on the public fork repo.
 * - Comparison: semver-ish (numeric segments, non-numeric suffixes ignored).
 * - Cached: one check per CHECK_INTERVAL (AsyncStorage) — a small user base
 *   should not hammer the API on every app open.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Linking } from "react-native";

const REPO = "coda-rho-bot/agent-sdk-mobile-app";
const CACHE_KEY = "letta.updateCheck.v1";
/** Recheck at most every 6 hours; failed checks back off to 1 hour. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 1 * 60 * 60 * 1000;

export interface UpdateInfo {
  /** Latest published version tag (e.g. "v0.2.0" → "0.2.0"). */
  version: string;
  /** Direct APK download URL from the release assets. */
  apkUrl: string;
  /** Human-readable release notes (first line of the body). */
  notes?: string;
}

export function localVersion(): string {
  //expo-application is the reliable native read; constants as fallback.
  try {
    // Lazy require: keeps this module importable in tests without native modules.
    const { default: Application } = require("expo-application");
    const v = Application?.nativeApplicationVersion;
    if (v) return v;
  } catch {
    // Fall through to constants.
  }
  return Constants.expoConfig?.version ?? "0.0.0";
}

/** Numeric-segment comparison: "0.10.0" > "0.9.2"; suffixes ignored. */
function isRemoteNewer(remote: string, local: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(/[.\-+]/).map((seg) => parseInt(seg, 10) || 0);
  const r = parse(remote);
  const l = parse(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

interface CacheShape {
  checkedAt: number;
  /** null = check succeeded, no update; UpdateInfo = update available. */
  update: UpdateInfo | null;
  /** true = the last check errored — retry sooner. */
  failed?: boolean;
}

/** Returns the update info when a newer release exists, else null. Cached. */
export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  try {
    const cached = await AsyncStorage.getItem(CACHE_KEY);
    if (!force && cached) {
      const parsed = JSON.parse(cached) as CacheShape;
      const interval = parsed.failed ? RETRY_INTERVAL_MS : CHECK_INTERVAL_MS;
      if (Date.now() - parsed.checkedAt < interval) return parsed.update;
    }
  } catch {
    // Cache read failure — proceed with a fresh check.
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`releases API ${res.status}`);
    const release = (await res.json()) as {
      tag_name?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
      body?: string;
    };
    const tag = release.tag_name?.replace(/^v/, "");
    const apk = release.assets?.find((a) => a.name?.endsWith(".apk"));
    if (!tag || !apk?.browser_download_url) {
      await persist({ checkedAt: Date.now(), update: null });
      return null;
    }
    const update: UpdateInfo = {
      version: tag,
      apkUrl: apk.browser_download_url,
      notes: release.body?.split("\n").find((l) => l.trim()) ?? undefined,
    };
    const available = isRemoteNewer(update.version, localVersion());
    await persist({ checkedAt: Date.now(), update: available ? update : null });
    return available ? update : null;
  } catch {
    // Network/API failure — keep the previous cached answer, back off retries.
    try {
      const cached = await AsyncStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as CacheShape;
        await persist({ ...parsed, checkedAt: Date.now(), failed: true });
        return parsed.update;
      }
    } catch {
      // Nothing cached — stay silent.
    }
    return null;
  }
}

async function persist(entry: CacheShape): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Cache write failure is invisible.
  }
}

/** Open the APK download in the browser (side-load install flow). */
export async function downloadUpdate(info: UpdateInfo): Promise<void> {
  await Linking.openURL(info.apkUrl);
}
