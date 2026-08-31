/**
 * Background polling — root-level lifecycle for external run-completion
 * notifications while the app is backgrounded.
 *
 * Owned by the root layout's AppState listener (NOT the chat screen): the
 * user may background the app from any screen, and "All messages" is a
 * per-conversation setting that should notify regardless of which
 * conversation (if any) was open. On background: enumerate all
 * conversations whose effective mode is ALL_MESSAGES and hand them to the
 * native Kotlin poller (modules/background-poll). On foreground: stop.
 *
 * The poller is native because JS timers never fire in backgrounded RN
 * contexts (main context pauses timers on host pause; headless contexts
 * don't drive them on the bridgeless runtime) — see Lesson #716.
 */
import { startPolling as nativeStartPolling, stopPolling as nativeStopPolling } from "../../modules/background-poll";
import { listAgents, listConversations } from "./letta/api";
import { NotificationMode, resolveEffectiveMode } from "./notifications";
import type { Profile } from "./profiles/profiles";
import { getSecret } from "./profiles/profiles";

const MAX_CONVERSATIONS = 50;
const MAX_AGENTS = 10;

let startInFlight = false;

/**
 * Enumerate ALL_MESSAGES conversations for the profile and start the native
 * poller. No-op (with log) if none qualify or the profile/token is missing.
 */
export async function startBackgroundPollingForProfile(profile: Profile | null): Promise<void> {
  if (startInFlight) return;
  startInFlight = true;
  try {
    if (!profile) {
      console.log("[BG-POLL] no active profile — not starting");
      return;
    }
    const secret = (await getSecret(profile.id)) ?? "";
    if (!secret) {
      console.log(`[BG-POLL] no secret for profile ${profile.id} — not starting`);
      return;
    }
    const conn = { profile, secret };
    const pollStartedAt = Date.now();

    // Enumerate agents → conversations, keep those resolving to ALL_MESSAGES.
    const specs: { conversationId: string; agentId: string; title: string }[] = [];
    try {
      const agents = await listAgents(conn);
      for (const agent of agents.slice(0, MAX_AGENTS)) {
        const conversations = await listConversations(conn, agent.id, { limit: 20 });
        for (const conv of conversations) {
          const mode = await resolveEffectiveMode(conv.id, agent.id, profile.id);
          if (mode !== NotificationMode.ALL_MESSAGES) continue;
          specs.push({
            conversationId: conv.id,
            agentId: agent.id,
            title: conv.title ?? "Conversation",
          });
          if (specs.length >= MAX_CONVERSATIONS) break;
        }
        if (specs.length >= MAX_CONVERSATIONS) break;
      }
    } catch (e) {
      console.log(`[BG-POLL] enumeration failed (${e instanceof Error ? e.message : String(e)}) — not starting`);
      return;
    }

    if (specs.length === 0) {
      console.log("[BG-POLL] no ALL_MESSAGES conversations — not starting");
      return;
    }
    console.log(`[BG-POLL] starting for ${specs.length} conversation(s): ${specs.map((s) => s.conversationId.slice(-8)).join(",")}`);
    await nativeStartPolling({
      conversations: specs,
      baseUrl: profile.type === "remote" && profile.url ? profile.url : "https://api.letta.com",
      token: secret,
      pollStartedAt,
      notifiedRunIds: [],
    });
  } finally {
    startInFlight = false;
  }
}

/** Stop the native poller (app returned to foreground). */
export async function stopBackgroundPolling(): Promise<void> {
  await nativeStopPolling();
}
