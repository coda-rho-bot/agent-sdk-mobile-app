/**
 * System deep-link interception (expo-router convention).
 *
 * redirectSystemPath runs for EVERY system link — cold start (initial) and
 * warm (app already open). We detect chat links (conversation notifications,
 * launcher shortcuts) and rebuild the natural navigation stack instead of
 * landing on a bare /chat screen where hardware back would exit the app.
 */
import { parseChatLink, openChatWithBackStack, stashPendingChatLink } from "../lib/chatDeepLink";

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  const target = parseChatLink(path);
  if (!target) return path;
  if (initial) {
    // Cold start: stash and return "/" (server list). RootLayout's mount
    // effect consumes the stash and rebuilds the stack at a deterministic
    // point — after the navigation container is ready. (Queuing commands
    // here would risk the routing queue draining before the container
    // mounts, silently dropping them.)
    stashPendingChatLink(target);
    return "/";
  }
  // Warm start: navigator is ready — rebuild immediately. Defer a tick so
  // we never dispatch from inside the linking layer's own event handler,
  // and return null to suppress the default single-screen navigation (the
  // linking layer truthiness-checks the return value).
  setImmediate(() => {
    openChatWithBackStack(target);
  });
  return null;
}

// Keep the default export a component for expo-router's route scanner.
export default function NativeIntent() {
  return null;
}
