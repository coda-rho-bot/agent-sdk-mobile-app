/**
 * Self-updater for the Lettasphere mobile app.
 *
 * Release channel (Lettasphere fork, public GitHub — anonymous, no token):
 *   GET api.github.com/repos/Lettasphere/agent-sdk-mobile-app/releases/latest
 *   → the newest release; its .apk asset IS the manifest (URL, size, name).
 *   Version comes from the tag (v0.2.0-ls.1 → suffix-insensitive compare).
 *
 * Download → expo-file-system; install → FileProvider + ACTION_VIEW intent.
 *
 * (Nov 23: rewired from the angus-lineage feeds — the Forgejo latest.json
 * contract on coda/agents-chat-releases and the coda-rho-bot bot-mirror —
 * both of which would offer angus-app APKs to a Lettasphere install.)
 */
import * as Application from "expo-application";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Paths, DownloadTask } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";
import { isUpdateAvailable } from "./version";

const RELEASES_API = "https://api.github.com/repos/Lettasphere/agent-sdk-mobile-app/releases/latest";

export interface UpdateManifest {
  version: string;
  versionCode: number;
  apk: string;
  size: number;
  releasedAt: string;
}

export class UpdaterError extends Error {}

/** Fetch the newest release manifest. Throws UpdaterError on any failure. */
export async function fetchLatestManifest(): Promise<UpdateManifest | null> {
  type Asset = { name: string; browser_download_url: string; size: number };
  type Release = { tag_name?: string; published_at?: string; assets?: Asset[] };
  let release: Release;
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new UpdaterError(`releases api ${res.status}`);
    release = (await res.json()) as Release;
  } catch (e) {
    if (e instanceof UpdaterError) throw e;
    throw new UpdaterError(e instanceof Error ? e.message : String(e));
  }
  const apk = release.assets?.find((a) => a.name.endsWith(".apk"));
  const tag = release.tag_name?.replace(/^v/, "");
  if (!tag || !apk) return null;
  return {
    version: tag,
    // Version code is not part of the GitHub release object; the tag is the
    // compare key (isUpdateAvailable is suffix-insensitive on segments).
    versionCode: 0,
    apk: apk.browser_download_url,
    size: apk.size,
    releasedAt: release.published_at ?? "",
  };
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

export interface UpdateCheckResult {
  currentVersion: string;
  manifest: UpdateManifest | null;
  updateAvailable: boolean;
}

/** One update check: fetch manifest, compare to installed version. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = Application.nativeApplicationVersion ?? "0.0.0";
  const manifest = await fetchLatestManifest().catch(() => null);
  return {
    currentVersion,
    manifest,
    updateAvailable: manifest ? isUpdateAvailable(manifest, currentVersion) : false,
  };
}

/** Download the APK and launch the system installer. Returns the local path. */
export async function downloadAndInstall(manifest: UpdateManifest, onProgress?: (pct: number) => void): Promise<string> {
  if (Platform.OS !== "android") throw new UpdaterError("android only");
  const file = new File(Paths.document, `letta-mobile-${manifest.version}.apk`);
  if (file.exists) file.delete();

  const task = new DownloadTask(manifest.apk, file);
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
