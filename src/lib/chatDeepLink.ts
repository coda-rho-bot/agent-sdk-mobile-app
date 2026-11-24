/**
 * Deep-link stack rebuilding for chat notifications.
 *
 * A raw deep link to /chat produces a SINGLE-SCREEN stack on cold start —
 * hardware back then exits the app instead of walking the navigation chain.
 * These helpers rebuild the natural stack so back works as if the user had
 * navigated manually:
 *
 *   / (servers) -> /agents -> /conversations -> /chat
 *
 * Entry points:
 *   - +native-intent.tsx (system deep links: Kotlin conversation
 *     notifications, launcher shortcuts)
 *   - _layout.tsx notification response listener (JS-posted notifications)
 */
import { router } from "expo-router";

export interface ChatLinkTarget {
  conversationId: string;
  agentId?: string;
  agentName?: string;
  title?: string;
}

/** Parse `agents-chat://chat?...` (or bare `/chat?...`) into a target. */
export function parseChatLink(link: string): ChatLinkTarget | null {
  let rest: string | null = null;
  if (link.startsWith("agents-chat://chat")) {
    rest = link.slice("agents-chat://chat".length);
  } else if (link.startsWith("/chat")) {
    rest = link.slice("/chat".length);
  } else {
    return null;
  }
  const query = rest.startsWith("?") ? rest.slice(1) : rest;
  if (!query) return null;
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    try {
      params[key] = decodeURIComponent(value);
    } catch {
      params[key] = value;
    }
  }
  if (!params.conversationId) return null;
  return {
    conversationId: params.conversationId,
    agentId: params.agentId,
    agentName: params.agentName,
    title: params.title,
  };
}

/**
 * Reset the stack and navigate to the chat screen through the natural
 * chain (servers -> agents -> conversations -> chat) so the hardware
 * back button walks the same path as manual navigation.
 *
 * Commands go through expo-router's FIFO routing queue. When called from
 * RootLayout's mount effect (cold-start deep links), React's bottom-up
 * effect ordering guarantees the queue drains only after the navigation
 * container reports ready — nothing is dropped.
 */
export function openChatWithBackStack(target: ChatLinkTarget): void {
  if (!target.agentId) {
    // Legacy notification payloads without agent context: push the chat
    // on top of whatever is open (previous behavior — no stack wipe).
    router.push({
      pathname: "/chat",
      params: {
        conversationId: target.conversationId,
        agentName: target.agentName,
        title: target.title,
      },
    });
    return;
  }
  router.dismissAll();
  router.push("/agents");
  router.push({
    pathname: "/conversations",
    params: { agentId: target.agentId, agentName: target.agentName },
  });
  router.push({
    pathname: "/chat",
    params: {
      conversationId: target.conversationId,
      agentId: target.agentId,
      agentName: target.agentName,
      title: target.title,
    },
  });
}

/**
 * Cold-start handoff. The initial system link is intercepted during
 * getInitialURL — long before the navigator mounts — where queued router
 * commands could drain into a not-yet-ready container and be dropped.
 * Instead: stash the target, return "/" so the app starts on the server
 * list, and let RootLayout's mount effect fire the rebuild at a
 * deterministic point in the mount sequence.
 */
let pendingColdStartTarget: ChatLinkTarget | null = null;

export function stashPendingChatLink(target: ChatLinkTarget): void {
  pendingColdStartTarget = target;
}

/** One-shot consume of the cold-start target (null if none/consumed). */
export function takePendingChatLink(): ChatLinkTarget | null {
  const t = pendingColdStartTarget;
  pendingColdStartTarget = null;
  return t;
}
