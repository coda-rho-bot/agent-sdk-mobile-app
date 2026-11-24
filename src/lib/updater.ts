/**
 * Self-updater for the Agents Chat Android app.
 *
 * Manifest contract (published by scripts/publish-release.sh):
 *   GET /repos/coda/agents-chat/releases?limit=1  → newest release
 *   its latest.json asset = {"version","versionCode","apk","size","releasedAt"}
 *   apk = attachment UUID url (auth required while repo is private)
 *
 * Download → expo-file-system; install → FileProvider + ACTION_VIEW intent.
 */
import * as Application from "expo-application";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Paths, DownloadTask } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";
import { compareVersions, isUpdateAvailable } from "./version";

const RELEASES_API = "https://git.angussoftware.dev/api/v1/repos/coda/agents-chat-releases/releases?limit=1";

export interface UpdateManifest {
  version: string;
  versionCode: number;
  apk: string;
  size: number;
  releasedAt: string;
}

export class UpdaterError extends Error {}

/** Fetch the newest release manifest. Throws UpdaterError on any failure. */
export async function fetchLatestManifest(token = ""): Promise<UpdateManifest | null> {
  type Release = { assets?: Array<{ name: string; browser_download_url: string }> };
  let release: Release | null = null;
  try {
    const res = await fetch(RELEASES_API, { headers: authHeaders(token) });
    if (!res.ok) throw new UpdaterError(`releases api ${res.status}`);
    const list = (await res.json()) as Release[];
    release = list?.[0] ?? null;
  } catch (e) {
    throw new UpdaterError(e instanceof Error ? e.message : String(e));
  }
  const manifestAsset = release?.assets?.find((a) => a.name === "latest.json");
  if (!manifestAsset) return null;
  const res = await fetch(manifestAsset.browser_download_url, { headers: authHeaders(token) });
  if (!res.ok) throw new UpdaterError(`manifest download ${res.status}`);
  const manifest = (await res.json()) as UpdateManifest;
  if (!manifest.version || !manifest.apk) throw new UpdaterError("manifest missing fields");
  return manifest;
}


type PendingUpdateListener = (u: PendingUpdate | null) => void;
export interface PendingUpdate {
  version: string;
  manifest: UpdateManifest;
}
let pendingUpdate: PendingUpdate | null = null;
const listeners = new Set<PendingUpdateListener>();
export function setPendingUpdate(u: PendingUpdate | null): void {
  pendingUpdate = u;
  for (const l of listeners) l(u);
}
export function subscribePendingUpdate(l: PendingUpdateListener): () => void {
  listeners.add(l);
  l(pendingUpdate);
  return () => listeners.delete(l);
}

const UPDATE_TOKEN_KEY = "letta.update.token";

/**
 * Optional bearer token for the release host. The artifacts repo is designed
 * to be public; while the hosting account is visibility-limited, a scoped
 * read token can be pasted once in settings to bridge the gap. Stored in
 * AsyncStorage alongside the app's other secrets.
 */
export async function loadUpdateToken(): Promise<string> {
  return (await AsyncStorage.getItem(UPDATE_TOKEN_KEY)) ?? "";
}

export async function saveUpdateToken(token: string): Promise<void> {
  if (token) await AsyncStorage.setItem(UPDATE_TOKEN_KEY, token);
  else await AsyncStorage.removeItem(UPDATE_TOKEN_KEY);
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `token ${token}` } : {};
}

export interface UpdateCheckResult {
  currentVersion: string;
  manifest: UpdateManifest | null;
  updateAvailable: boolean;
}

/** One update check: fetch manifest, compare to installed version. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = Application.nativeApplicationVersion ?? "0.0.0";
  // Anonymous first (public host); on failure retry once with the stored
  // token (visibility-limited hosting).
  let manifest = await fetchLatestManifest().catch(() => null);
  if (!manifest) {
    const token = await loadUpdateToken();
    if (token) manifest = await fetchLatestManifest(token);
  }
  return {
    currentVersion,
    manifest,
    updateAvailable: manifest ? isUpdateAvailable(manifest, currentVersion) : false,
  };
}

/** Download the APK and launch the system installer. Returns the local path. */
export async function downloadAndInstall(manifest: UpdateManifest, onProgress?: (pct: number) => void): Promise<string> {
  if (Platform.OS !== "android") throw new UpdaterError("android only");
  const token = await loadUpdateToken();
  const file = new File(Paths.document, `agents-chat-${manifest.version}.apk`);
  if (file.exists) file.delete();

  const headers = authHeaders(token);
  const task = new DownloadTask(manifest.apk, file, headers ? { headers } : undefined);
  task.addListener("progress", ({ bytesWritten, totalBytes }) => {
    if (totalBytes > 0) onProgress?.(bytesWritten / totalBytes);
  });
  const ok = await task.downloadAsync();
  if (!ok) throw new UpdaterError("download failed");

  if (manifest.size && file.exists && Math.abs(file.size - manifest.size) > 1024) {
    throw new UpdaterError(`size mismatch: got ${file.size}, expected ${manifest.size}`);
  }

  // content:// URI through the app's FileProvider so the installer can read
  // the APK from our private directory.
  // androidx FileProvider resolves the FIRST path segment against the root's
  // name attribute (files-path name="files"), so /files/<name> is required.
  const contentUri = `content://${Application.applicationId}.fileprovider/files/${file.name}`;
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    type: "application/vnd.android.package-archive",
    // FLAG_GRANT_READ_URI_PERMISSION — the installer needs it to open our URI.
    flags: 1,
  });
  return file.uri;
}
